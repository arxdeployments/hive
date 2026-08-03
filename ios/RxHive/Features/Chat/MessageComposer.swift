import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The message composer: text, attachments and voice notes.
///
/// Ported from `frontend/src/components/chat/MessageComposer.jsx`.
///
/// Photos and video go through `MediaSendSheet` before they are uploaded, which is
/// where the caption is written and where the Standard/HD choice is made. Documents
/// and voice notes do not: a document has no quality tier and nothing to preview that
/// the picker has not already shown, and a voice note has just been reviewed in the
/// recorder bar. Both upload straight from the pick, with the composer's own text as
/// the caption.
struct MessageComposer: View {

    let conversationID: String
    let replyTo: Message?
    let onSent: () -> Void
    /// Added to the assigned signature, because the reply strip lives in here but the
    /// `replyTo` state lives in the parent — a child cannot clear a value it does not
    /// own. Defaulted so the fixed three-argument call site still compiles; when it is
    /// not supplied the X still hides the strip locally (see `replyDismissed`), so the
    /// control is never inert.
    let onCancelReply: () -> Void

    init(
        conversationID: String,
        replyTo: Message?,
        onSent: @escaping () -> Void,
        onCancelReply: @escaping () -> Void = {}
    ) {
        self.conversationID = conversationID
        self.replyTo = replyTo
        self.onSent = onSent
        self.onCancelReply = onCancelReply
    }

    @EnvironmentObject private var chat: ChatStore
    @EnvironmentObject private var toasts: ToastCenter

    @State private var text = ""
    @FocusState private var isFocused: Bool

    @State private var showPhotoPicker = false
    @State private var photoSelection: [PhotosPickerItem] = []
    @State private var showCamera = false
    @State private var showFileImporter = false

    /// Persisted across launches and shared by every chat, like the reference's own
    /// upload-quality setting: this is a statement about the user's data plan, not
    /// about one conversation.
    @AppStorage(MediaQuality.storageKey) private var mediaQuality: MediaQuality = .standard

    /// Picked or captured media awaiting confirmation. Non-empty presents the send sheet.
    @State private var pendingMedia: [PendingMedia] = []

    @State private var uploads: [UploadJob] = []
    @State private var replyDismissed = false
    @State private var replyConsumed = false

    @StateObject private var recorder = AudioRecorder()
    /// The finger is on the mic. Separate from `recorder.isRecording` because the
    /// permission prompt sits between the two, and a finger lifted during the prompt
    /// must not start a recording nobody is holding.
    @State private var micHeld = false
    /// Hands-free: the finger has let go but the recorder is still running.
    @State private var isLocked = false
    /// Upward travel of the hold gesture, for the lock affordance.
    @State private var slideUp: CGFloat = 0

    /// Which recorder state the bar should show, or nil for the normal composer.
    ///
    /// Paused outranks locked: pausing is reached *from* locked, and the paused bar is
    /// the one with the preview player and the resume button.
    private var recorderMode: VoiceRecorderBar.Mode? {
        if recorder.phase == .paused { return .paused }
        guard recorder.isRecording else { return nil }
        if isLocked { return .locked }
        return .holding(dragX: slideOffset, dragY: slideUp)
    }
    @State private var cancelArmed = false
    @State private var slideOffset: CGFloat = 0

    private var trimmedText: String { text.trimmed }
    private var hasText: Bool { !trimmedText.isEmpty }

    /// `admin_only_messages` on a group: only the creator and admins may post.
    private var canPost: Bool {
        guard let conversation = chat.conversation(id: conversationID) else { return true }
        return conversation.canIPost(userID: chat.currentUserID)
    }

    private var showsReplyStrip: Bool { replyTo != nil && !replyDismissed }

    /// The reply target, once.
    ///
    /// A batch of files attaches the quote to the first message only — the same thing
    /// the web composer does, because five bubbles each quoting the same message reads
    /// as a bug rather than as one reply with five attachments.
    private func consumeReplyID() -> String? {
        guard !replyConsumed, let id = replyTo?.id else { return nil }
        replyConsumed = true
        return id
    }

    var body: some View {
        VStack(spacing: 0) {
            Hairline()

            if showsReplyStrip, let replyTo {
                ReplyStrip(message: replyTo) {
                    replyDismissed = true
                    onCancelReply()
                }
            }

            if !uploads.isEmpty {
                VStack(spacing: 0) {
                    ForEach(uploads) { job in
                        UploadRow(job: job) { cancel(job: job) }
                    }
                }
                .transition(.opacity)
            }

            if !canPost {
                blockedNotice
            } else if let mode = recorderMode, mode == .locked || mode == .paused {
                // Hands-free and paused take the whole row: the finger is off the
                // screen, so there is no mic button to keep under it.
                VoiceRecorderBar(
                    recorder: recorder,
                    mode: mode,
                    onCancel: discardRecording,
                    onPause: pauseRecording,
                    onResume: resumeRecording,
                    onSend: finishAndSend
                )
            } else {
                // Includes the holding state, which keeps the mic button in place —
                // the finger is still on it, and the lock target sits above it.
                composerRow
            }
        }
        .background(Theme.Color.sidebar)
        .animation(Theme.Motion.ease, value: showsReplyStrip)
        .animation(Theme.Motion.ease, value: uploads.count)
        .animation(Theme.Motion.ease, value: recorder.phase)
        .onChange(of: replyTo?.id) { _, _ in
            replyDismissed = false
            replyConsumed = false
            // Replying is an invitation to type; the web app focuses the box too.
            if replyTo != nil { isFocused = true }
        }
        .onChange(of: text) { _, newValue in
            guard !newValue.isEmpty else { return }
            chat.noteTyping(in: conversationID)
        }
        .onChange(of: isFocused) { _, focused in
            // Blur means the user has stopped composing, whatever the throttle thinks.
            if !focused { chat.stopTyping(in: conversationID) }
        }
        .onDisappear {
            chat.stopTyping(in: conversationID)
            // A live microphone keeps the recording indicator lit system-wide, so it
            // must not survive the screen it belongs to.
            recorder.cancel()
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $photoSelection,
            maxSelectionCount: 10,
            matching: photoPickerFilter
        )
        .onChange(of: photoSelection) { _, items in
            guard !items.isEmpty else { return }
            let picked = items
            photoSelection = []
            Task { @MainActor in await stage(pickerItems: picked) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            // The capture UI is narrowed too: an unusable Video tab in the shutter
            // bar is a worse answer than not showing it.
            CameraCapture(
                allowsPhotos: true,
                allowsVideos: true,
                // Capture at the tier the user chose. Recording 4K to then throw most
                // of it away in a re-encode wastes both the wait and the disk.
                videoQuality: mediaQuality == .hd ? .typeHigh : .typeMedium
            ) { data, filename in
                showCamera = false
                guard let data, let filename else { return }
                // A capture goes to the same confirm step as a pick: it is the one that
                // most needs reviewing, since nobody has seen the frame yet.
                Task { @MainActor in
                    let isVideo = MediaFormatting.fileExtension(of: filename) != "jpg"
                    if let media = await makePending(data: data, filename: filename, isVideo: isVideo) {
                        pendingMedia = [media]
                    }
                }
            }
            .ignoresSafeArea()
        }
        // `fullScreenCover`, not `sheet`: the point of this screen is to look at the
        // media, and a sheet leaves the chat showing through above it.
        .fullScreenCover(isPresented: Binding(
            get: { !pendingMedia.isEmpty },
            set: { if !$0 { pendingMedia = [] } }
        )) {
            MediaSendSheet(
                items: pendingMedia,
                caption: trimmedText,
                onSend: { items, caption, quality in
                    pendingMedia = []
                    send(media: items, caption: caption, quality: quality)
                },
                onCancel: { pendingMedia = [] }
            )
        }
        .fileImporter(
            isPresented: $showFileImporter,
            // `.data` is every file. Any format may be sent, so the picker must
            // not narrow: a .psd or a .dwg has to be reachable.
            allowedContentTypes: [.data],
            allowsMultipleSelection: true
        ) { result in
            handleFileImport(result)
        }
    }

    // MARK: - Composer row

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: Theme.Layout.spacing2) {
            // Hidden while holding: the paperclip is directly under the sliding
            // "slide to cancel" label, and a tappable target there is a trap.
            if !micHeld {
                attachmentMenu
            }

            if micHeld {
                VoiceRecorderBar(
                    recorder: recorder,
                    mode: .holding(dragX: slideOffset, dragY: slideUp),
                    onCancel: discardRecording,
                    onPause: pauseRecording,
                    onResume: resumeRecording,
                    onSend: finishAndSend
                )
            } else {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .font(Theme.Typography.body)
                    .foregroundStyle(Theme.Color.text)
                    .tint(Theme.Color.primary)
                    .focused($isFocused)
                    .padding(.horizontal, Theme.Layout.spacing4)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .fill(Theme.Color.surface2)
                            .overlay(
                                RoundedRectangle(cornerRadius: 22, style: .continuous)
                                    .stroke(isFocused ? Theme.Color.primary : Theme.Color.border2, lineWidth: 1)
                            )
                    )
                    .animation(Theme.Motion.ease, value: isFocused)
            }

            // Hidden outright when there is nothing for it to do. With the box empty
            // and audio blocked it would be a mic that cannot record, and iOS has
            // nowhere to put the tooltip the web uses to explain that. Typing brings
            // it straight back as the send button.
            if true {
                sendOrMicButton
                    // The lock column floats above the mic, anchored to the button
                    // rather than to the bar, so "slide up" points at something.
                    .overlay(alignment: .bottom) {
                        if micHeld && !isLocked {
                            VoiceRecorderBar.lockAffordance(dragY: slideUp)
                                .transition(.opacity)
                        }
                    }
            }
        }
        .padding(.horizontal, Theme.Layout.spacing3)
        .padding(.vertical, Theme.Layout.spacing2)
    }

    private var attachmentMenu: some View {
        Menu {
            if true {
                Button {
                    showPhotoPicker = true
                } label: {
                    Label("Photo Library", systemImage: "photo.on.rectangle")
                }
                Button {
                    showCamera = true
                } label: {
                    Label("Camera", systemImage: "camera")
                }
            }
            Button {
                    showFileImporter = true
            } label: {
                Label("Document", systemImage: "doc")
            }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 19))
                .foregroundStyle(Theme.Color.textMuted)
                .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
        }
        .accessibilityLabel("Add attachment")
    }

    private var sendOrMicButton: some View {
        ZStack {
            Circle().fill(Theme.Color.primary)
            Image(systemName: hasText ? "paperplane.fill" : "mic.fill")
                .font(.system(size: hasText ? 16 : 18, weight: .medium))
                .foregroundStyle(Theme.Color.onPrimary)
                // The plane's artwork leans up-left; nudging it centres the mass.
                .offset(x: hasText ? -1 : 0, y: hasText ? 1 : 0)
        }
        .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
        .scaleEffect(micHeld ? 1.25 : 1)
        .animation(Theme.Motion.interactive, value: micHeld)
        .contentShape(Circle())
        // Recording starts and stops on the PRESS STATE, not on a drag update.
        //
        // This is the fix for "press and hold does nothing". A `DragGesture` only calls
        // `onChanged` when the touch actually moves, so a press that never moves — a
        // mouse click-and-hold in the Simulator, or a very still thumb — produced no
        // callback at all and never began recording. Sliding worked, which is what made
        // the bug look like it wasn't there.
        //
        // `onLongPressGesture(pressing:)` fires the moment the touch lands and again
        // when it lifts, with no movement required. `maximumDistance` is deliberately
        // enormous so sliding away to cancel or to lock does not end the press.
        // `minimumDuration` is a large finite number, NOT `.infinity`: an infinite
        // timer never arms, and the gesture then never reports a press at all — which
        // is how this looked identical to the original bug. An hour never elapses
        // during a voice note, so `perform` never fires and `pressing(false)` arrives
        // only when the finger actually lifts. (Were `perform` to fire, SwiftUI would
        // end the gesture and report un-pressing, cutting the recording short.)
        .onLongPressGesture(
            minimumDuration: 3600,
            maximumDistance: 10_000,
            pressing: { isPressing in
                guard !hasText else { return }
                if isPressing {
                    beginRecording()
                } else if !isLocked {
                    endRecording()
                } else {
                    micHeld = false
                }
            },
            perform: {}
        )
        // Runs alongside the press so the same touch can both hold and slide.
        .simultaneousGesture(micGesture)
        .accessibilityLabel(hasText ? "Send message" : "Hold to record a voice message")
        .accessibilityHint(hasText ? "" : "Slide up to record hands-free, or slide left to cancel")
    }

    private var blockedNotice: some View {
        HStack(spacing: Theme.Layout.spacing2) {
            Image(systemName: "lock")
                .font(.system(size: 13))
            Text("Only admins can send messages in this group")
                .font(Theme.Typography.caption)
        }
        .foregroundStyle(Theme.Color.textMuted)
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Layout.spacing4)
    }

    // MARK: - Text send

    private func sendText() {
        let body = trimmedText
        guard !body.isEmpty, canPost else { return }
        let replyID = consumeReplyID()
        text = ""
        chat.stopTyping(in: conversationID)
        Task { @MainActor in
            await chat.send(conversationID: conversationID, content: body, replyTo: replyID)
            // After the await, so the optimistic bubble already exists and the parent's
            // scroll-to-bottom has something to scroll to.
            onSent()
        }
    }

    // MARK: - Voice notes

    /// Distance below which an ended drag counts as a tap rather than a slide.
    private static let tapSlop: CGFloat = 12

    /// Tracks *where* the finger goes. Starting and stopping the recording is the
    /// press gesture's job (see `sendOrMicButton`) — this only reads translation, so a
    /// motionless hold is not dependent on it.
    private var micGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard !hasText, !isLocked else { return }
                slideOffset = min(0, value.translation.width)
                slideUp = min(0, value.translation.height)
                cancelArmed = value.translation.width < -VoiceRecorderBar.cancelThreshold

                // Slide up to go hands-free. Checked before cancel so a diagonal drag
                // that clears the lock threshold locks rather than being read as a
                // half-hearted cancel.
                if value.translation.height < -VoiceRecorderBar.lockThreshold, !cancelArmed {
                    lockRecording()
                }
            }
            .onEnded { value in
                guard hasText else { return }
                // A lift with no travel is the tap that sends the typed message.
                let travelled = max(abs(value.translation.width), abs(value.translation.height))
                if travelled < Self.tapSlop { sendText() }
            }
    }

    /// Hands-free. The bar takes over the composer row and the gesture stops mattering.
    private func lockRecording() {
        guard !isLocked else { return }
        isLocked = true
        micHeld = false
        cancelArmed = false
        slideOffset = 0
        slideUp = 0
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }

    /// Pause, resume and trash from the locked/paused bar.
    private func pauseRecording() {
        recorder.pause()
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func resumeRecording() {
        if !recorder.resume() {
            toasts.error("Couldn't continue recording.")
        }
    }

    private func discardRecording() {
        recorder.cancel()
        isLocked = false
        micHeld = false
        cancelArmed = false
        slideOffset = 0
        slideUp = 0
    }

    /// Send whatever has been captured, from either the locked or the paused bar.
    private func finishAndSend() {
        isLocked = false
        micHeld = false
        Task { @MainActor in
            guard let result = await recorder.finish() else {
                toasts.show("That recording was too short to send")
                return
            }
            await sendVoiceNote(url: result.url, duration: result.duration)
        }
    }

    private func beginRecording() {
        micHeld = true
        cancelArmed = false
        slideOffset = 0
        isFocused = false
        Task { @MainActor in
            guard await recorder.requestPermission() else {
                micHeld = false
                toasts.error(
                    recorder.isPermissionDenied
                        ? "Microphone access is off. Turn it on in Settings › RX HIVE."
                        : "Microphone access is needed to record a voice message."
                )
                return
            }
            // The finger may already be back up — either because the prompt stole the
            // press, or because it was a stray tap.
            guard micHeld else { return }
            if recorder.start() {
                // The strip appearing is easy to miss with a thumb over it, so confirm
                // the hold in the hand as well as on screen.
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            } else {
                micHeld = false
                toasts.error("Couldn't start recording. Try again.")
            }
        }
    }

    /// Finger lifted without locking: send, or discard if the slide-to-cancel was armed.
    private func endRecording() {
        let armed = cancelArmed
        micHeld = false
        cancelArmed = false
        slideOffset = 0
        slideUp = 0
        guard recorder.isActive else { return }

        if armed {
            recorder.cancel()
            return
        }
        Task { @MainActor in
            guard let result = await recorder.finish() else {
                toasts.show("Hold to record, release to send")
                return
            }
            await sendVoiceNote(url: result.url, duration: result.duration)
        }
    }

    @MainActor
    private func sendVoiceNote(url: URL, duration: TimeInterval) async {
        defer { try? FileManager.default.removeItem(at: url) }
        guard let data = try? Data(contentsOf: url) else {
            toasts.error("The recording could not be read.")
            return
        }
        // `.m4a` is load-bearing: the server classifies by extension, and this is the
        // extension that lands in its audio set. See AudioRecorder for the full note.
        let filename = "voice-\(Int(Date().timeIntervalSince1970)).m4a"
        enqueue(
            data: data,
            filename: filename,
            kind: .audio,
            caption: "",
            duration: (duration * 10).rounded() / 10,
            replyID: consumeReplyID()
        )
    }

    // MARK: - Staging attachments

    /// Photos and videos from the system picker.
    @MainActor
    private func stage(pickerItems: [PhotosPickerItem]) async {
        var staged: [PendingMedia] = []
        for item in pickerItems {
            // Loaded as `Data` because `APIClient.upload` builds an in-memory multipart
            // body — there is no streaming upload path to hand a file URL to, so
            // materialising the bytes is not an extra cost, it is the same cost.
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                toasts.error("That item couldn't be read from your library.")
                continue
            }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let isVideo = type?.conforms(to: .movie) == true
            let stamp = Int(Date().timeIntervalSince1970)
            let name = "\(isVideo ? "VID" : "IMG")-\(stamp)-\(UUID().uuidString.prefix(4)).\(ext)"
            if let media = await makePending(data: data, filename: name, isVideo: isVideo) {
                staged.append(media)
            }
        }
        guard !staged.isEmpty else { return }
        pendingMedia = staged
    }

    /// Build the preview the send sheet shows.
    ///
    /// The poster frame and the playable temp file are produced here rather than in the
    /// sheet so the sheet stays synchronous — a `View` that has to await its own content
    /// flashes empty on first appear, and this screen's whole job is to show the media.
    private func makePending(data: Data, filename: String, isVideo: Bool) async -> PendingMedia? {
        guard let kind = mediaKind(data: data, filename: filename) else {
            toasts.error("\(filename) isn't a file type this chat accepts.")
            return nil
        }

        if isVideo || kind == .video {
            let url = MediaTranscoder.stagePreviewFile(data: data, filename: filename)
            let (poster, duration) = await MediaTranscoder.videoPoster(url: url)
            return PendingMedia(
                data: data, filename: filename, isVideo: true,
                preview: poster, playbackURL: url, duration: duration
            )
        }
        // Downscaled for display only — the bytes sent are still the originals, and the
        // tier is applied at send time from whatever the sheet ends up choosing.
        let poster = MediaTranscoder.thumbnail(data: data, maxEdge: 1400)
        return PendingMedia(
            data: data, filename: filename, isVideo: false,
            preview: poster, playbackURL: nil, duration: nil
        )
    }

    /// Confirmed in the send sheet: transcode each item to the chosen tier and upload.
    private func send(media: [PendingMedia], caption: String, quality: MediaQuality) {
        guard !media.isEmpty else { return }
        if !caption.isEmpty || !trimmedText.isEmpty {
            text = ""
            chat.stopTyping(in: conversationID)
        }
        for (offset, item) in media.enumerated() {
            MediaTranscoder.discardPreviewFile(item.playbackURL)
            enqueueMedia(
                data: item.data,
                filename: item.filename,
                kind: item.isVideo ? .video : .image,
                quality: quality,
                // The caption rides on the first item only, as it does on the web — five
                // bubbles repeating the same sentence reads as a bug.
                caption: offset == 0 ? caption : "",
                replyID: offset == 0 ? consumeReplyID() : nil
            )
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            toasts.error(error.localizedDescription)
        case .success(let urls):
            for url in urls {
                // Picked files live outside the app container; without the scoped
                // access the read fails with a permission error.
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else {
                    toasts.error("\(url.lastPathComponent) couldn't be read.")
                    continue
                }
                stage(data: data, filename: url.lastPathComponent)
            }
        }
    }

    /// Validate, then queue an upload. The caption is whatever is in the box, which is
    /// then cleared — a picked photo with text already typed reads as one message.
    /// Documents and voice notes only. Photos and video come through `send(media:…)`
    /// after the send sheet, because they need the chosen tier applied first.
    private func stage(data: Data, filename: String) {
        guard let candidate = validate(data: data, filename: filename) else { return }
        let caption = trimmedText
        if !caption.isEmpty {
            text = ""
            chat.stopTyping(in: conversationID)
        }
        enqueue(
            data: candidate.data,
            filename: candidate.filename,
            kind: candidate.kind,
            caption: caption,
            duration: nil,
            replyID: consumeReplyID()
        )
    }

    /// `.image` or `.video` when this file is one, else nil.
    ///
    /// Falls back to decoding the bytes because the extension is not always enough:
    /// an iPhone photo arrives as HEIC, which classifies as a document now that
    /// nothing is rejected. It is still an image, and treating it as one is what
    /// gets it a preview instead of a file card.
    private func mediaKind(data: Data, filename: String) -> AttachmentKind? {
        let ext = MediaFormatting.fileExtension(of: filename)
        let kind = AttachmentKind(fileExtension: ext)
        if kind == .image || kind == .video { return kind }
        return UIImage(data: data) != nil ? .image : nil
    }

    /// Enforce the server's own limits before spending the user's data allowance.
    ///
    /// Returns possibly-rewritten bytes: an iPhone photo is usually HEIC, which the
    /// server has no thumbnailer for, so it is transcoded to JPEG here. The filename
    /// is rewritten to match, because the server derives the MIME type from the
    /// extension and ignores what we claim.
    ///
    /// Still the single place the size limit is applied to a file. The pickers no
    /// longer narrow anything — every format is accepted — but the camera returns
    /// whatever it captured and a HEIC arrives here as something else entirely, so
    /// every path except a voice note passes through this function.
    private func validate(data: Data, filename: String) -> (data: Data, filename: String, kind: AttachmentKind)? {
        let ext = MediaFormatting.fileExtension(of: filename)

        // HEIC has no server-side thumbnailer, so it is still rewritten to JPEG —
        // not because it would be rejected, but because it would arrive as a file
        // card with no preview on every other device.
        if ext == "heic" || ext == "heif",
           let image = UIImage(data: data),
           let jpeg = image.jpegData(compressionQuality: 0.9) {
            let base = (filename as NSString).deletingPathExtension
            return validate(data: jpeg, filename: "\((base.isEmpty ? "IMG" : base)).jpg")
        }

        // Never nil now: an unrecognised extension is a document, matching
        // `storage.classify`.
        let kind = AttachmentKind(fileExtension: ext)

        if data.count > kind.maxBytes {
            // Name the actual limit: "too large" without a number leaves the user
            // guessing what would work.
            toasts.error("\(filename) is too large (max \(kind.limitLabel))")
            return nil
        }
        return (data, filename, kind)
    }

    // MARK: - Uploading

    /// One file on its way out.
    ///
    /// There is no byte-level progress: `APIClient.upload` awaits a single
    /// `URLSession.data(for:)` and exposes no progress callback, and inventing a second
    /// URLSession here would bypass its cookie, CSRF and refresh-and-replay handling.
    /// The row is therefore indeterminate, with a working cancel — which is the part
    /// that matters on a slow connection.
    fileprivate struct UploadJob: Identifiable {
        let id = UUID()
        /// Mutable because a transcode renames the file — a HEIC becomes a JPEG, a
        /// `.mov` becomes an `.mp4` — and the row should say what is actually going.
        var filename: String
        let kind: AttachmentKind
        /// "Compressing…" then "Sending…". A 4K clip at HD can take tens of seconds to
        /// export, and a bar that says nothing during it reads as a hang.
        var status: String
        var task: Task<Void, Never>?
    }

    private func enqueue(
        data: Data,
        filename: String,
        kind: AttachmentKind,
        caption: String,
        duration: Double?,
        replyID: String?
    ) {
        let job = UploadJob(filename: filename, kind: kind, status: "Sending…")
        uploads.append(job)

        let task = Task { @MainActor in
            await perform(
                data: data, filename: filename, kind: kind,
                caption: caption, duration: duration, replyID: replyID
            )
            uploads.removeAll { $0.id == job.id }
        }
        if let index = uploads.firstIndex(where: { $0.id == job.id }) {
            uploads[index].task = task
        }
    }

    /// Photos and video: re-encode to the chosen tier, *then* validate, then upload.
    ///
    /// The order matters and is the opposite of every other attachment. `validate`
    /// enforces the server's size ceiling, and a 4K clip straight off the camera is
    /// routinely past it — rejecting that before compressing would refuse a file the
    /// app is perfectly able to send. So the row appears first (the export is the slow
    /// part and needs to be visible), the bytes are rewritten, and only the bytes that
    /// will actually be uploaded are measured.
    private func enqueueMedia(
        data: Data,
        filename: String,
        kind: AttachmentKind,
        quality: MediaQuality,
        caption: String,
        replyID: String?
    ) {
        let job = UploadJob(
            filename: filename,
            kind: kind,
            status: kind == .video ? "Compressing…" : "Preparing…"
        )
        uploads.append(job)

        let task = Task { @MainActor in
            let output: MediaTranscoder.Output
            switch kind {
            case .video:
                output = await MediaTranscoder.video(data: data, filename: filename, quality: quality)
            default:
                output = MediaTranscoder.image(data: data, filename: filename, quality: quality)
            }

            guard !Task.isCancelled else {
                uploads.removeAll { $0.id == job.id }
                return
            }

            if let index = uploads.firstIndex(where: { $0.id == job.id }) {
                uploads[index].filename = output.filename
                uploads[index].status = "Sending…"
            }

            if let candidate = validate(data: output.data, filename: output.filename) {
                await perform(
                    data: candidate.data, filename: candidate.filename, kind: candidate.kind,
                    caption: caption, duration: nil, replyID: replyID
                )
            }
            uploads.removeAll { $0.id == job.id }
        }
        if let index = uploads.firstIndex(where: { $0.id == job.id }) {
            uploads[index].task = task
        }
    }

    @MainActor
    private func perform(
        data: Data,
        filename: String,
        kind: AttachmentKind,
        caption: String,
        duration: Double?,
        replyID: String?
    ) async {
        do {
            let result = try await RxHiveAPI.upload(
                data: data, filename: filename, mimeType: kind.mimeType(forFilename: filename)
            )
            guard !Task.isCancelled else { return }

            // A document with no caption carries its filename as content — that is what
            // the web client sends, and what the conversation-list preview reads.
            let content: String = {
                if !caption.isEmpty { return caption }
                return kind == .document ? result.filename : ""
            }()

            await chat.send(
                conversationID: conversationID,
                content: content,
                type: kind.messageType,
                replyTo: replyID,
                mediaURL: result.fileURL,
                duration: duration,
                thumbnailURL: result.thumbnailURL,
                fileSize: result.fileSize,
                filename: result.filename
            )
            onSent()
        } catch is CancellationError {
            // The user pulled it; the row is already gone.
        } catch {
            guard !Task.isCancelled else { return }
            toasts.failure(error, fallback: "\(filename) couldn't be sent")
        }
    }

    private func cancel(job: UploadJob) {
        job.task?.cancel()
        uploads.removeAll { $0.id == job.id }
    }

    // MARK: - Picker configuration

    /// What the photo library will offer.
    ///
    /// `PHPickerFilter`, not `accept`: this one really does constrain the picker, so
    /// a video-blocked user is shown a library with no videos in it rather than a
    /// grid where half the taps fail.
    private var photoPickerFilter: PHPickerFilter {
        .any(of: [.images, .videos])
    }
}

// MARK: - Attachment classification

/// The server's upload rules, transcribed.
///
/// Limits and extension sets come from `app/services/storage.py` (via the product
/// contract), and they are enforced client-side purely so a 200 MB video fails in
/// under a second instead of after a long upload.
///
/// ## These sets classify; they no longer restrict
/// Which bubble renders a file — photo, video player, voice note or file card —
/// is `storage.classify`'s job and is the same for everybody. Anything not listed
/// is a document, exactly as the server treats it, so an unrecognised extension
/// sends fine and simply arrives as a file card.
///
/// Which means this list is the third of four copies that have to stay in lockstep:
/// `services/storage.py`, the web composer, here, and
/// `frontend/src/utils/audioFormat.js` — the last of which depends on ".weba"
/// classifying as audio and ".webm" as video, so do not "tidy" those two together.
private enum AttachmentKind {
    case image, video, audio, document

    static let imageExtensions: Set<String> = ["jpg", "jpeg", "png", "gif", "webp"]
    static let videoExtensions: Set<String> = ["mp4", "mov", "webm", "m4v"]
    static let audioExtensions: Set<String> = ["mp3", "m4a", "wav", "ogg", "aac", "opus", "weba"]
    static let documentExtensions: Set<String> = [
        "pdf", "txt", "csv", "zip", "md", "json",
        "doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf",
    ]

    /// Non-failable: every extension maps. Unrecognised means document, matching
    /// `storage.classify`, which no longer rejects anything either.
    init(fileExtension ext: String) {
        let lowered = ext.lowercased()
        if Self.imageExtensions.contains(lowered) { self = .image }
        else if Self.videoExtensions.contains(lowered) { self = .video }
        else if Self.audioExtensions.contains(lowered) { self = .audio }
        else { self = .document }
    }

    /// One ceiling for everything, matching `storage.MAX_UPLOAD_BYTES`.
    var maxBytes: Int { 2 * 1024 * 1024 * 1024 }

    var limitLabel: String { "2 GB" }

    /// The message `type` the API and the bubbles expect. Note "document" maps to
    /// "file" — the upload service and the message contract disagree on the word.
    var messageType: String {
        switch self {
        case .image: return "image"
        case .video: return "video"
        case .audio: return "audio"
        case .document: return "file"
        }
    }

    /// Best-effort Content-Type for the multipart part. The server derives the real
    /// one from the extension and ignores this, but sending `application/octet-stream`
    /// for everything would make the request harder to read in a proxy log.
    func mimeType(forFilename filename: String) -> String {
        let ext = MediaFormatting.fileExtension(of: filename)
        if let type = UTType(filenameExtension: ext)?.preferredMIMEType { return type }
        switch self {
        case .image: return "image/jpeg"
        case .video: return "video/mp4"
        case .audio: return "audio/mp4"
        case .document: return "application/octet-stream"
        }
    }

    var glyph: String {
        switch self {
        case .image: return "photo"
        case .video: return "film"
        case .audio: return "waveform"
        case .document: return "doc"
        }
    }
}

// MARK: - Sub-views

/// The quoted message above the field, with the emerald leading rule the web app
/// uses on reply previews.
private struct ReplyStrip: View {
    let message: Message
    let onCancel: () -> Void

    private var snippet: String {
        if message.isDeleted { return "This message was deleted" }
        switch message.type {
        case .image: return message.content.isEmpty ? "Photo" : message.content
        case .video: return message.content.isEmpty ? "Video" : message.content
        case .audio: return "Voice message"
        case .file: return message.filename ?? (message.content.isEmpty ? "File" : message.content)
        default: return message.content
        }
    }

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Theme.Color.primary)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 1) {
                Text(message.senderName)
                    .font(Theme.Typography.font(size: 13, weight: .medium))
                    .foregroundStyle(Theme.Color.primary)
                Text(snippet)
                    // Tombstones render in muted italic everywhere in this app.
                    .font(message.isDeleted ? Theme.Typography.caption.italic() : Theme.Typography.caption)
                    .foregroundStyle(Theme.Color.textMuted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: Theme.Layout.minTouchTarget, height: Theme.Layout.minTouchTarget)
            }
            .accessibilityLabel("Cancel reply")
        }
        .padding(.leading, Theme.Layout.spacing4)
        .padding(.trailing, Theme.Layout.spacing1)
        .padding(.vertical, Theme.Layout.spacing2)
        .frame(height: 56)
        .background(Theme.Color.surface)
    }
}

/// One in-flight upload, with a cancel.
private struct UploadRow: View {
    let job: MessageComposer.UploadJob
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: Theme.Layout.spacing3) {
            Image(systemName: job.kind.glyph)
                .font(.system(size: 14))
                .foregroundStyle(Theme.Color.primary)
                .frame(width: 20)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: Theme.Layout.spacing2) {
                    Text(job.filename)
                        .font(Theme.Typography.caption)
                        .foregroundStyle(Theme.Color.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(job.status)
                        .font(Theme.Typography.micro)
                        .foregroundStyle(Theme.Color.textMuted)
                        .fixedSize()
                }
                IndeterminateBar()
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button(action: onCancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.Color.textMuted)
                    .frame(width: 32, height: 32)
            }
            .accessibilityLabel("Cancel upload of \(job.filename)")
        }
        .padding(.leading, Theme.Layout.spacing4)
        .padding(.trailing, Theme.Layout.spacing2)
        .padding(.vertical, Theme.Layout.spacing2)
        .background(Theme.Color.surface)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(job.status) \(job.filename)")
    }
}

/// A sliding emerald sliver. Honest about not knowing the percentage — see
/// `MessageComposer.UploadJob`.
private struct IndeterminateBar: View {
    /// Fraction of the track the sliver's leading edge sits at: starts fully off the
    /// left, ends fully off the right.
    @State private var phase: CGFloat = -0.35

    var body: some View {
        GeometryReader { geo in
            Capsule()
                .fill(Theme.Color.border2)
                .frame(height: 3)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(Theme.Color.primary)
                        .frame(width: geo.size.width * 0.35, height: 3)
                        .offset(x: geo.size.width * phase)
                }
                .clipShape(Capsule())
        }
        .frame(height: 3)
        .onAppear {
            withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                phase = 1
            }
        }
    }
}

/// The live level meter shown while recording. Newest sample on the right, so the
/// bars read as travelling toward the mic the finger is on.
private struct RecordingWaveform: View {
    let levels: [Float]

    var body: some View {
        HStack(alignment: .center, spacing: 2) {
            ForEach(levels.indices, id: \.self) { index in
                Capsule()
                    .fill(Theme.Color.danger.opacity(0.85))
                    .frame(width: 2, height: max(3, CGFloat(levels[index]) * 22))
            }
        }
        .frame(height: 24, alignment: .center)
    }
}

// MARK: - Camera

/// `UIImagePickerController` for a one-shot capture.
///
/// Not `PhotosPicker`, which cannot open the camera, and not `AVCaptureSession`, which
/// would mean building a capture UI to replace one iOS already ships. Photos come back
/// as JPEG and movies as the recorder's `.mov`, both of which the server accepts.
private struct CameraCapture: UIViewControllerRepresentable {
    /// Which of the shutter bar's two modes to offer. Both, always — kept as
    /// parameters rather than hard-coded so the capture UI stays reusable.
    let allowsPhotos: Bool
    let allowsVideos: Bool
    /// Recording quality, from the composer's Standard/HD setting.
    let videoQuality: UIImagePickerController.QualityType
    /// nil data means the user cancelled.
    let onCapture: (Data?, String?) -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        // Guard against the simulator and any device without a camera: without this
        // the controller presents an empty black sheet.
        picker.sourceType = UIImagePickerController.isSourceTypeAvailable(.camera) ? .camera : .photoLibrary
        var mediaTypes: [String] = []
        if allowsPhotos { mediaTypes.append(UTType.image.identifier) }
        if allowsVideos { mediaTypes.append(UTType.movie.identifier) }
        // `UIImagePickerController` shows every available type when handed an empty
        // array, so a caller that permits neither must not reach here — the menu
        // entry is hidden in that case.
        picker.mediaTypes = mediaTypes.isEmpty ? [UTType.image.identifier] : mediaTypes
        picker.videoQuality = videoQuality
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCapture: onCapture) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        private let onCapture: (Data?, String?) -> Void

        init(onCapture: @escaping (Data?, String?) -> Void) {
            self.onCapture = onCapture
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            let stamp = Int(Date().timeIntervalSince1970)
            if let movieURL = info[.mediaURL] as? URL, let data = try? Data(contentsOf: movieURL) {
                onCapture(data, "VID-\(stamp).\(movieURL.pathExtension.isEmpty ? "mov" : movieURL.pathExtension)")
                return
            }
            // Encoded at 1.0 deliberately: `MediaTranscoder` does the real encode a
            // moment later, and compressing twice would stack a second generation of
            // JPEG loss on top of the tier the user actually asked for. These bytes
            // only ever live in memory on the way to it.
            if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 1.0) {
                onCapture(data, "IMG-\(stamp).jpg")
                return
            }
            onCapture(nil, nil)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCapture(nil, nil)
        }
    }
}
