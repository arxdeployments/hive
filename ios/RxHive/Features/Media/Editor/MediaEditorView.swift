import AVFoundation
import SwiftUI
import UIKit

enum EditorTool: String, CaseIterable, Identifiable {
    case crop, draw, text

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .crop: return "crop.rotate"
        case .draw: return "pencil.tip"
        case .text: return "textformat"
        }
    }

    var label: String {
        switch self {
        case .crop: return "Crop, rotate and flip"
        case .draw: return "Draw"
        case .text: return "Add text"
        }
    }
}

/// The pre-send media editor.
///
/// Opened from the confirm step for a picked photo or clip, and it never touches the
/// network: it takes the ORIGINAL bytes plus an edit model and hands back new bytes plus
/// the model that produced them. Nothing has been uploaded at this point, which is what
/// makes Cancel free and Revert exact.
///
/// ## Why the original is what gets edited, every time
///
/// The item keeps its untouched original for as long as it is staged, and the editor
/// always opens on `original + model`. So:
///
///   - re-opening shows the crop handles where they were left and the strokes still
///     live, and the user can keep refining instead of starting over;
///   - "Revert to the original" is `MediaEdit()`, not an inverse transform;
///   - a crop tightened twice never compounds JPEG generations, because the second pass
///     re-renders from the original rather than from the first pass's output.
///
/// ## Video
///
/// Crop, rotate and flip only. Drawing and text are photo-only, so those two tools are
/// absent for a clip rather than present and inert — annotating a clip would mean
/// promising scrubbing and keyframes, which is a different feature. The clip is exported
/// through `MediaTranscoder.video`'s composition path in a single pass at send time; here
/// the crop is judged against a still frame, which is what the user is deciding on
/// anyway.
///
/// ## Errors surface in the chrome, not as a toast
///
/// `ToastHost` is mounted inside `RootView`'s `ZStack`, which sits BELOW any
/// `fullScreenCover` — a toast raised from here would render behind the cover and be
/// invisible. So failures are shown in this view's own footer.
struct MediaEditorView: View {

    let item: PendingMedia
    /// Called with the new bytes, the new filename, the model that produced them and a
    /// freshly composed preview. `edit` is empty when the user reverted.
    let onSave: (Data, String, MediaEdit, UIImage?) -> Void
    let onCancel: () -> Void

    /// The edit AND its undo stack, as one value — see `MediaEditHistory` for why they
    /// cannot be two separate pieces of state.
    @State private var editHistory: MediaEditHistory
    @State private var tool: EditorTool = .crop
    @State private var aspect: AspectPreset = .free
    @State private var decoded: UIImage?
    @State private var loadFailure: String?
    @State private var saveFailure: String?
    @State private var isSaving = false
    @State private var ink: String = EditorInk.default
    @State private var pen: PenSize = .medium
    @State private var selectedTextID: UUID?
    /// A preview file THIS view staged, because the item had none. It owns it, so it has
    /// to free it — `send(media:)` only ever discards the URL the item itself is holding.
    @State private var stagedPreviewURL: URL?

    init(
        item: PendingMedia,
        onSave: @escaping (Data, String, MediaEdit, UIImage?) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.item = item
        self.onSave = onSave
        self.onCancel = onCancel
        _editHistory = State(initialValue: MediaEditHistory(item.edit))
    }

    /// The bytes every render starts from — never the previously saved output.
    private var original: Data { item.originalData }


    var body: some View {
        ZStack {
            Color.black

            VStack(spacing: 0) {
                topBar

                if let loadFailure {
                    Spacer()
                    Text(loadFailure)
                        .font(Theme.Typography.subheadline)
                        .foregroundStyle(Theme.Color.textMuted)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, Theme.Layout.spacing6)
                    Spacer()
                } else if let decoded {
                    switch tool {
                    case .crop:
                        CropStageView(
                            image: decoded,
                            source: decoded.size,
                            edit: editBinding,
                            aspect: $aspect,
                            onCommit: pushHistory
                        )
                    case .draw, .text:
                        AnnotateStageView(
                            image: decoded,
                            source: decoded.size,
                            edit: editBinding,
                            tool: tool,
                            ink: $ink,
                            pen: $pen,
                            selectedID: $selectedTextID,
                            onCommit: pushHistory
                        )
                    }
                } else {
                    Spacer()
                    ProgressView().tint(Theme.Color.primary)
                    Spacer()
                }

                footer
            }
            .padding(.top, EditorInsets.window.top)
            .padding(.bottom, EditorInsets.window.bottom)

            if isSaving {
                // A composition export of a clip takes real time, and a tap that lands
                // mid-export would edit a model that is already being baked.
                Color.black.opacity(0.55)
                    .overlay {
                        VStack(spacing: Theme.Layout.spacing3) {
                            ProgressView().tint(Theme.Color.primary)
                            Text(item.isVideo ? "Preparing the cropped clip…" : "Saving…")
                                .font(Theme.Typography.caption)
                                .foregroundStyle(Theme.Color.textMuted)
                        }
                    }
            }
        }
        .ignoresSafeArea()
        .preferredColorScheme(.dark)
        .statusBarHidden(true)
        .task(id: item.id) { await load() }
        .onDisappear {
            MediaTranscoder.discardPreviewFile(stagedPreviewURL)
            stagedPreviewURL = nil
        }
        // The pen must not start a stroke that is read as dragging whatever was selected.
        .onChange(of: tool) { _, newTool in
            if newTool != .text { selectedTextID = nil }
        }
    }

    // MARK: Chrome

    private var topBar: some View {
        HStack(spacing: 6) {
            EditorCircleButton(symbol: "xmark", label: "Close without saving", isEnabled: !isSaving, action: onCancel)

            Spacer(minLength: 0)

            ForEach(availableTools) { option in
                EditorCircleButton(
                    symbol: option.symbol,
                    label: option.label,
                    isActive: tool == option,
                    isEnabled: !isSaving && decoded != nil
                ) {
                    tool = option
                }
            }

            Spacer(minLength: 0)

            EditorCircleButton(
                symbol: "arrow.uturn.backward",
                label: "Undo",
                isEnabled: !isSaving && editHistory.canUndo,
                action: undo
            )
            // Only offered when there is something to revert, so it never reads as a
            // button that does nothing.
            if edit.hasEdits {
                EditorCircleButton(
                    symbol: "clock.arrow.circlepath",
                    label: "Revert to the original",
                    isEnabled: !isSaving,
                    action: revert
                )
            }

            Button(action: save) {
                HStack(spacing: 5) {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .bold))
                    Text("Done")
                        .font(Theme.Typography.font(size: 15, weight: .semibold))
                }
                .foregroundStyle(Theme.Color.onPrimary)
                .padding(.horizontal, Theme.Layout.spacing4)
                .frame(height: 40)
                .background(Capsule().fill(Theme.Color.primary))
            }
            .buttonStyle(PressScaleStyle())
            .disabled(isSaving || decoded == nil)
            .opacity(isSaving || decoded == nil ? 0.5 : 1)
            .accessibilityLabel("Save and use this version")
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.bottom, Theme.Layout.spacing2)
    }

    /// Drawing and text are photo-only — see the note in the type's documentation.
    private var availableTools: [EditorTool] {
        item.isVideo ? [.crop] : EditorTool.allCases
    }

    /// A GIF cannot survive this.
    ///
    /// Rasterising an animation means picking one frame, and there is no way around
    /// that short of a GIF encoder. Rather than silently flattening one, say what will
    /// happen while the user can still back out.
    private var flattensAnimation: Bool {
        !item.isVideo && MediaFormatting.fileExtension(of: item.originalFilename) == "gif"
    }

    @ViewBuilder
    private var footer: some View {
        if let saveFailure {
            Text(saveFailure)
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.danger)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Layout.spacing4)
                .padding(.bottom, Theme.Layout.spacing2)
        } else if flattensAnimation {
            Text("Editing a GIF saves a single still frame — close without saving to send it animated.")
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.warning)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Layout.spacing4)
                .padding(.bottom, Theme.Layout.spacing2)
        } else if item.isVideo {
            Text("Cropping re-encodes the clip when it is sent. Drawing and text are for photos only.")
                .font(Theme.Typography.micro)
                .foregroundStyle(Theme.Color.textFaint)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, Theme.Layout.spacing4)
                .padding(.bottom, Theme.Layout.spacing2)
        }
    }

    // MARK: Loading

    private func load() async {
        // A still to edit against. For a clip that is a poster frame — the crop is judged
        // on one frame regardless, and the actual pixels are cut by the composition
        // export at send time.
        let bytes = original
        let isVideo = item.isVideo
        let playback = item.playbackURL

        if isVideo {
            var url = playback
            if url == nil {
                // The item has no preview file — its staging failed. Make one, and
                // remember that WE own it so it gets freed on the way out.
                url = MediaTranscoder.stagePreviewFile(data: bytes, filename: item.filename)
                stagedPreviewURL = url
            }
            guard let url else {
                loadFailure = "That clip could not be opened."
                return
            }
            let (poster, _) = await MediaTranscoder.videoPoster(url: url)
            guard let poster else {
                loadFailure = "That clip could not be opened."
                return
            }
            decoded = poster
            return
        }

        // 2400px, not the export's 4096: the model stores fractions, so a smaller decode
        // is exact for editing and noticeably faster to compose per gesture.
        //
        // Detached: `load()` is called from a `.task` and so inherits the view's main
        // actor, which meant a full-resolution ImageIO decode blocked the run loop
        // while the editor was opening — the sheet appeared frozen before it drew.
        let image = await Task.detached(priority: .userInitiated) {
            MediaEditRenderer.decode(data: bytes, maxEdge: 2400)
        }.value
        guard let image else {
            loadFailure = "That photo could not be opened for editing."
            return
        }
        decoded = image
    }

    // MARK: History

    /// The current model. Everything that renders or saves reads this.
    private var edit: MediaEdit { editHistory.present }

    /// What the stages mutate. Writes land on `editHistory.present`, so a change and the
    /// `commit()` that precedes it act on the same value and cannot be reordered apart.
    private var editBinding: Binding<MediaEdit> {
        Binding(
            get: { editHistory.present },
            set: { editHistory.set($0) }
        )
    }

    private func pushHistory() {
        editHistory.commit()
    }

    private func undo() {
        guard editHistory.undo() else { return }
        selectedTextID = nil
    }

    private func revert() {
        editHistory.reset()
        aspect = .free
        selectedTextID = nil
    }

    // MARK: Save

    private func save() {
        guard !isSaving else { return }
        saveFailure = nil

        // A box the user opened and never typed into is not an edit — see
        // `pruningEmptyTexts`.
        let model = edit.pruningEmptyTexts()

        // Nothing to bake. Hand back the original so a save with no edits cannot silently
        // re-encode a photo — and so the item stops being marked as edited.
        guard model.hasEdits else {
            onSave(original, item.originalFilename, MediaEdit(), item.originalPreview)
            return
        }

        // A clip's pixels are cut by the composition export inside
        // `MediaTranscoder.video` at send time, so there is nothing to bake here: the
        // model travels with the item and the preview is recomposed from the poster.
        if item.isVideo {
            let composed = decoded.flatMap { image -> UIImage? in
                let output = MediaEditGeometry.output(image.size, model, maxEdge: 1400)
                return MediaEditRenderer.compose(image: image, source: image.size, edit: model, output: output)
            }
            onSave(original, item.originalFilename, model, composed)
            return
        }

        isSaving = true
        let bytes = original
        let filename = item.originalFilename
        Task { @MainActor in
            // BOTH composes are detached, not just the export one. A 4096px render and a
            // 1400px preview each decode the source again, and leaving either on the main
            // actor stalls the run loop after `isSaving` has already torn the spinner
            // down — so the screen looks interactive while nothing responds.
            let result = await Task.detached(priority: .userInitiated) {
                let rendered = MediaEditRenderer.render(data: bytes, filename: filename, edit: model)
                let preview = rendered == nil ? nil : MediaEditRenderer.previewImage(data: bytes, edit: model)
                return (rendered, preview)
            }.value
            isSaving = false
            guard let rendered = result.0 else {
                saveFailure = "The edit could not be saved. Try again, or send the photo as it is."
                return
            }
            onSave(rendered.data, rendered.filename, model, result.1)
        }
    }
}
