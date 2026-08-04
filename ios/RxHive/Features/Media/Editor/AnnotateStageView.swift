import SwiftUI
import UIKit

/// Freehand drawing and text boxes, on the frame that will actually be sent.
///
/// ## Three layers, and why
///
/// 1. A rasterised base — the picture with the crop, rotation and flips applied and
///    NOTHING else, composed by the same `MediaEditRenderer.compose` the exporter uses.
///    Recomputed only when the crop or the orientation changes, never while a finger is
///    moving.
/// 2. A `Canvas` for the strokes, including the one currently under the finger. Drawn
///    through `EditStrokeGeometry.path` — the same function the exporter strokes — with
///    a display-space mapper instead of a source-pixel one. Re-rasterising the base per
///    touch would drop the frame rate to single digits; a `Canvas` redraw of a few
///    hundred points costs nothing.
/// 3. One `Image` per text box, rasterised by the same `EditTextLayout.draw` the
///    exporter uses, so the wrapped lines and glyph positions on screen are the ones
///    that get sent. A caption that reflows between being placed and being sent is worse
///    than not having the tool. Each box's bitmap is keyed on everything except its
///    position, so dragging one never re-renders its text.
///
/// ## Colour
///
/// One vertical strip drives whichever colour is in play: the pen, or the selected box's
/// text, or the selected box's plate. That is what makes "the colour of the text and the
/// text box, individually" two taps rather than two pickers competing for the same edge
/// of the screen.
///
/// ## What undo covers
///
/// Structural changes — a finished stroke, adding or deleting a box, a completed drag.
/// Not the colour and size sliders: they are continuous, so every tick would be its own
/// step and Undo would stop meaning anything. Dragging a slider back is the undo for a
/// slider.
struct AnnotateStageView: View {

    let image: UIImage
    let source: CGSize
    @Binding var edit: MediaEdit
    let tool: EditorTool
    @Binding var ink: String
    @Binding var pen: PenSize
    @Binding var selectedID: UUID?
    let onCommit: () -> Void

    @State private var base: UIImage?
    @State private var live: EditStroke?
    @State private var dragStart: CGPoint?
    @State private var resizeStartWidth: CGFloat?
    @State private var didMove = false
    @State private var editingID: UUID?
    /// Which colour the strip and the swatches are driving right now.
    @State private var colorTarget: ColorTarget = .text
    @FocusState private var textFocused: Bool

    private enum ColorTarget { case text, box }

    private var stripped: MediaEdit {
        var copy = edit
        copy.strokes = []
        copy.texts = []
        return copy
    }

    private var selected: EditText? {
        guard let selectedID else { return nil }
        return edit.texts.first { $0.id == selectedID }
    }

    private var activeColor: String {
        guard tool == .text, let selected else { return ink }
        return colorTarget == .box ? selected.boxColorHex : selected.colorHex
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: Theme.Layout.spacing2) {
                GeometryReader { geo in
                    let box = fitted(in: geo.size)
                    ZStack {
                        if let base, box.width > 1 {
                            stage(base: base, box: box)
                                .frame(width: box.width, height: box.height)
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                    .task(id: rasterKey(box: box)) {
                        guard box.width > 1, box.height > 1 else { return }
                        // Device resolution, not point resolution — see `previewOutput`.
                        // On the main actor deliberately: it reads UIScreen.main.
                        let output = MediaEditRenderer.previewOutput(source: source, edit: stripped, box: box)
                        // Detached for the same reason as CropStageView: a `.task` in a
                        // view body runs on the main actor, and this is a full
                        // device-resolution composite.
                        let edit = stripped
                        let src = source
                        let img = image
                        let composed = await Task.detached(priority: .userInitiated) {
                            MediaEditRenderer.compose(image: img, source: src, edit: edit, output: output)
                        }.value
                        guard !Task.isCancelled else { return }
                        base = composed
                    }
                }

                // The strip lives beside the picture, not under it: it is the one control
                // reached for repeatedly while drawing, and a bottom bar would put it
                // under the user's own hand.
                EditorColorStrip(selected: activeColor, onPick: setActiveColor)
                    .frame(maxHeight: 300)
                    .padding(.trailing, Theme.Layout.spacing3)
            }

            controls
        }
    }

    // MARK: Stage

    @ViewBuilder
    private func stage(base: UIImage, box: CGSize) -> some View {
        let output = MediaEditGeometry.displayOutput(source, edit, box: box)
        let shortEdge = max(1, min(source.width, source.height))

        ZStack(alignment: .topLeading) {
            // The gesture lives on the BASE image, not on the enclosing stack.
            //
            // That is what keeps a tap on a caption from being read twice. The text
            // overlays sit above this layer, so in text mode a touch on one is claimed by
            // the overlay and never reaches the deselect-on-empty-space handler here; in
            // draw mode the overlays are `allowsHitTesting(false)` and a stroke passes
            // straight through them onto this layer. Putting it on the stack instead
            // would have every box-tap both select and immediately deselect.
            Image(uiImage: base)
                .resizable()
                .frame(width: box.width, height: box.height)
                .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                .contentShape(Rectangle())
                .gesture(surfaceGesture(box: box))

            Canvas { context, _ in
                let mapping: (CGPoint) -> CGPoint = { point in
                    let f = MediaEditGeometry.sourcePointToFrame(point, edit)
                    return CGPoint(x: f.x * box.width, y: f.y * box.height)
                }
                for stroke in edit.strokes + (live.map { [$0] } ?? []) {
                    let width = max(0.5, stroke.width * shortEdge * output.scale)
                    if stroke.points.count == 1, let only = stroke.points.first {
                        let centre = mapping(only)
                        context.fill(
                            Path(ellipseIn: CGRect(
                                x: centre.x - width / 2, y: centre.y - width / 2,
                                width: width, height: width
                            )),
                            with: .color(EditorInk.color(stroke.colorHex))
                        )
                        continue
                    }
                    context.stroke(
                        EditStrokeGeometry.path(stroke, mapping: mapping),
                        with: .color(EditorInk.color(stroke.colorHex)),
                        style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
                    )
                }
            }
            .frame(width: box.width, height: box.height)
            .allowsHitTesting(false)

            ForEach(edit.texts) { item in
                textOverlay(item, box: box, output: output)
            }
            .allowsHitTesting(tool == .text)
        }
        .frame(width: box.width, height: box.height)
    }

    @ViewBuilder
    private func textOverlay(_ item: EditText, box: CGSize, output: MediaEditGeometry.Output) -> some View {
        // `forSource:` — measured at the reference height so the stage's chrome is sized
        // from the same wrapped lines the exporter will draw.
        let layout = EditTextLayout.layout(item, forSource: source)
        let size = CGSize(width: layout.boxSize.width * output.scale, height: layout.boxSize.height * output.scale)
        let centre = MediaEditGeometry.sourcePointToFrame(item.centre, edit)
        let isSelected = item.id == selectedID

        EditorTextBitmap(item: item, source: source, displayScale: output.scale)
            .frame(width: size.width, height: size.height)
            .overlay {
                if isSelected {
                    RoundedRectangle(cornerRadius: 3)
                        .strokeBorder(.white.opacity(0.85), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                        .padding(-3)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if isSelected {
                    Circle()
                        .fill(.white)
                        .frame(width: 12, height: 12)
                        .shadow(color: .black.opacity(0.7), radius: 3, y: 1)
                        .frame(width: 36, height: 36)
                        .contentShape(Circle())
                        .offset(x: 16, y: 16)
                        .gesture(resizeGesture(item, output: output))
                        .accessibilityLabel("Resize text box")
                }
            }
            .overlay(alignment: .topTrailing) {
                if isSelected {
                    Button {
                        remove(item.id)
                    } label: {
                        Image(systemName: "trash")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 26, height: 26)
                            .background(Circle().fill(.black.opacity(0.7)))
                    }
                    .buttonStyle(.plain)
                    .offset(x: 13, y: -13)
                    .accessibilityLabel("Delete this text")
                }
            }
            .contentShape(Rectangle())
            .position(x: centre.x * box.width, y: centre.y * box.height)
            .gesture(moveGesture(item, box: box))
    }

    // MARK: Layout

    private func fitted(in available: CGSize) -> CGSize {
        let inset: CGFloat = 12
        let w = max(0, available.width - inset * 2)
        let h = max(0, available.height - inset * 2)
        guard w > 0, h > 0 else { return .zero }
        let ratio = MediaEditGeometry.visibleAspect(source, edit)
        var width = w
        var height = width / ratio
        if height > h {
            height = h
            width = height * ratio
        }
        return CGSize(width: width.rounded(), height: height.rounded())
    }

    private func rasterKey(box: CGSize) -> String {
        let c = MediaEditGeometry.crop(edit)
        return [
            String(Int(box.width)), String(Int(box.height)),
            String(format: "%.4f,%.4f,%.4f,%.4f", c.minX, c.minY, c.width, c.height),
            String(edit.rotation), String(edit.flipH), String(edit.flipV),
        ].joined(separator: "-")
    }

    // MARK: Drawing

    private func surfaceGesture(box: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard tool == .draw else { return }
                let point = sourcePoint(value.location, box: box)
                if live == nil {
                    live = EditStroke(
                        colorHex: ink,
                        width: MediaEditGeometry.penWidth(fraction: pen.fraction, source: source, edit: edit),
                        points: [point]
                    )
                    return
                }
                // Drop samples that land on the previous one: a stationary finger emits a
                // steady stream of identical positions, and thousands of duplicate points
                // make the stroke expensive to redraw for no visual difference.
                if let last = live?.points.last,
                   abs(last.x - point.x) < 0.0004, abs(last.y - point.y) < 0.0004 { return }
                live?.points.append(point)
            }
            .onEnded { _ in
                guard tool == .draw else {
                    // Any half-drawn stroke is dropped, not kept. The tool buttons stay
                    // live during a gesture, so a second finger can switch away
                    // mid-stroke — and a stranded `live` would be previewed but never
                    // exported, then welded onto the front of the next stroke.
                    live = nil
                    // A tap on bare picture in text mode means "nothing is selected".
                    finishEditing()
                    selectedID = nil
                    return
                }
                guard let stroke = live else { return }
                live = nil
                onCommit()
                edit.strokes.append(stroke)
            }
    }

    private func sourcePoint(_ location: CGPoint, box: CGSize) -> CGPoint {
        MediaEditGeometry.framePointToSource(
            CGPoint(
                x: min(1, max(0, location.x / max(1, box.width))),
                y: min(1, max(0, location.y / max(1, box.height)))
            ),
            edit
        )
    }

    // MARK: Text gestures

    private func moveGesture(_ item: EditText, box: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard tool == .text else { return }
                if dragStart == nil {
                    dragStart = MediaEditGeometry.sourcePointToFrame(item.centre, edit)
                    selectedID = item.id
                    didMove = false
                }
                guard let start = dragStart else { return }
                let travelled = abs(value.translation.width) + abs(value.translation.height)
                if !didMove {
                    // One history entry per gesture, pushed the moment it stops being a tap.
                    guard travelled > 4 else { return }
                    didMove = true
                    onCommit()
                }
                let next = MediaEditGeometry.framePointToSource(
                    CGPoint(
                        x: min(1, max(0, start.x + value.translation.width / max(1, box.width))),
                        y: min(1, max(0, start.y + value.translation.height / max(1, box.height)))
                    ),
                    edit
                )
                patch(item.id) { $0.centre = next }
            }
            .onEnded { _ in
                let wasTap = !didMove
                dragStart = nil
                didMove = false
                guard tool == .text else { return }
                // A tap, not a drag: open the keyboard on it.
                if wasTap { beginEditing(item.id) }
            }
    }

    /// Resize changes the WRAP WIDTH only, never the type size — two independent
    /// controls is the point. The box is centre-anchored, so a handle moved by dx grows
    /// it by 2dx; and because `EditTextLayout` lays the box out axis-aligned in display
    /// space, converting back to a source fraction carries no rotation term.
    private func resizeGesture(_ item: EditText, output: MediaEditGeometry.Output) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if resizeStartWidth == nil {
                    resizeStartWidth = EditTextLayout.layout(item, forSource: source).boxSize.width * output.scale
                    selectedID = item.id
                    onCommit()
                }
                guard let startWidth = resizeStartWidth else { return }
                let padPoints = item.padding * source.height
                let nextDisplayWidth = max(8, startWidth + value.translation.width * 2)
                let contentSourcePixels = nextDisplayWidth / output.scale - 2 * padPoints
                let lower = MediaEditGeometry.boxWidth(fraction: MediaEditLimits.boxFrameMin, source: source, edit: edit)
                let upper = MediaEditGeometry.boxWidth(fraction: MediaEditLimits.boxFrameMax, source: source, edit: edit)
                patch(item.id) {
                    $0.boxWidth = min(max(contentSourcePixels / source.width, lower), upper)
                }
            }
            .onEnded { _ in resizeStartWidth = nil }
    }

    // MARK: Mutations

    private func patch(_ id: UUID, _ change: (inout EditText) -> Void) {
        guard let index = edit.texts.firstIndex(where: { $0.id == id }) else { return }
        change(&edit.texts[index])
    }

    /// A binding that looks the box up by id on every access.
    ///
    /// Not `$edit.texts[index]`: an index binding captures the position and SwiftUI reads
    /// it again on a later layout pass, so deleting the box being typed into — the trash
    /// button is live while the keyboard is up — can read past the end of the array and
    /// trap. Looking it up by id turns that into a no-op instead.
    private var editingTextBinding: Binding<String> {
        Binding(
            get: { edit.texts.first { $0.id == editingID }?.text ?? "" },
            set: { newValue in
                guard let editingID else { return }
                patch(editingID) { $0.text = newValue }
            }
        )
    }

    private func addText() {
        let centre = MediaEditGeometry.framePointToSource(CGPoint(x: 0.5, y: 0.5), edit)
        var item = EditText()
        item.centre = centre
        item.fontSize = MediaEditGeometry.fontSize(fraction: MediaEditLimits.fontFrameDefault, source: source, edit: edit)
        item.boxWidth = MediaEditGeometry.boxWidth(fraction: MediaEditLimits.boxFrameDefault, source: source, edit: edit)
        item.padding = MediaEditGeometry.fontSize(fraction: 0.018, source: source, edit: edit)
        item.colorHex = ink
        onCommit()
        edit.texts.append(item)
        selectedID = item.id
        colorTarget = .text
        beginEditing(item.id)
    }

    private func remove(_ id: UUID) {
        onCommit()
        edit.texts.removeAll { $0.id == id }
        if selectedID == id { selectedID = nil }
        if editingID == id { editingID = nil; textFocused = false }
    }

    private func beginEditing(_ id: UUID) {
        editingID = id
        textFocused = true
    }

    /// Leaving the keyboard drops a box nobody typed in.
    ///
    /// Without this, tapping Add text and then tapping away would leave an invisible
    /// empty box in the model — which `hasEdits` counts, so the item would be badged as
    /// edited and Revert would appear to have something to undo.
    private func finishEditing() {
        guard let id = editingID else { return }
        editingID = nil
        textFocused = false
        if let item = edit.texts.first(where: { $0.id == id }),
           item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            edit.texts.removeAll { $0.id == id }
            if selectedID == id { selectedID = nil }
        }
    }

    private func setActiveColor(_ hex: String) {
        guard tool == .text, let selected else { ink = hex; return }
        patch(selected.id) { item in
            if colorTarget == .box { item.boxColorHex = hex } else { item.colorHex = hex }
        }
        // Kept as the pen colour too, so the next stroke picks up the colour the user has
        // just been thinking about rather than reverting to an older one.
        if colorTarget == .text { ink = hex }
    }

    // MARK: Controls

    @ViewBuilder
    private var controls: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            if tool == .draw {
                HStack {
                    EditorPenSizeRow(selection: $pen, inkHex: ink)
                    Spacer(minLength: Theme.Layout.spacing2)
                }
                .padding(.horizontal, Theme.Layout.spacing3)
            } else {
                textControls
            }

            ScrollView(.horizontal, showsIndicators: false) {
                EditorSwatchRow(selected: activeColor, onPick: setActiveColor)
                    .padding(.horizontal, Theme.Layout.spacing3)
            }
            .frame(height: 38)
        }
        .padding(.bottom, Theme.Layout.spacing2)
    }

    @ViewBuilder
    private var textControls: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            if editingID != nil {
                // The keyboard row. In-place editing on a photo needs a caret that lines
                // up with rasterised glyphs to the point; a field with the box already
                // rendering live above it is both simpler and easier to type into.
                HStack(spacing: Theme.Layout.spacing2) {
                    TextField("Type a caption…", text: editingTextBinding, axis: .vertical)
                        .lineLimit(1...3)
                        .font(Theme.Typography.body)
                        .foregroundStyle(Theme.Color.text)
                        .tint(Theme.Color.primary)
                        .focused($textFocused)
                        .padding(.horizontal, Theme.Layout.spacing3)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Layout.radiusPill, style: .continuous)
                                .fill(.white.opacity(0.14))
                        )
                    EditorCircleButton(symbol: "checkmark", label: "Finish typing", isActive: true) {
                        finishEditing()
                    }
                }
                .padding(.horizontal, Theme.Layout.spacing3)
            }

            HStack(spacing: 6) {
                EditorChip(label: "Add text") { addText() }

                if let selected {
                    Divider().frame(height: 20).overlay(Color.white.opacity(0.2))
                    // The two colours, individually.
                    EditorChip(label: "Text", isActive: colorTarget == .text) { colorTarget = .text }
                    EditorChip(label: "Box", isActive: colorTarget == .box) { colorTarget = .box }
                    Spacer(minLength: 4)
                    ForEach(EditText.TextAlignmentOption.allCases) { option in
                        EditorCircleButton(
                            symbol: option.symbol,
                            label: option.label,
                            isActive: selected.alignment == option,
                            size: 13
                        ) {
                            patch(selected.id) { $0.alignment = option }
                        }
                    }
                } else {
                    Text(edit.texts.isEmpty ? "Drop a caption anywhere on the picture" : "Tap a caption to edit or move it")
                        .font(Theme.Typography.micro)
                        .foregroundStyle(Theme.Color.textFaint)
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, Theme.Layout.spacing3)

            if let selected {
                VStack(spacing: 2) {
                    // The two size controls the brief asks to be independent: one scales
                    // the glyphs, the other only sets the wrap width.
                    EditorValueSlider(
                        label: "Text size",
                        value: MediaEditGeometry.frameFontFraction(selected.fontSize, source: source, edit: edit),
                        range: MediaEditLimits.fontFrameMin...MediaEditLimits.fontFrameMax,
                        format: { "\(Int(($0 * 100).rounded()))%" }
                    ) { value in
                        patch(selected.id) {
                            $0.fontSize = MediaEditGeometry.fontSize(fraction: value, source: source, edit: edit)
                        }
                    }
                    EditorValueSlider(
                        label: "Box width",
                        value: MediaEditGeometry.frameBoxFraction(selected.boxWidth, source: source, edit: edit),
                        range: MediaEditLimits.boxFrameMin...MediaEditLimits.boxFrameMax,
                        format: { "\(Int(($0 * 100).rounded()))%" }
                    ) { value in
                        patch(selected.id) {
                            $0.boxWidth = MediaEditGeometry.boxWidth(fraction: value, source: source, edit: edit)
                        }
                    }
                    // 0% is the transparent background this feature is specified around,
                    // and it is where every new box starts.
                    EditorValueSlider(
                        label: "Box fill",
                        value: selected.boxOpacity,
                        range: 0...1,
                        format: { $0 <= 0.001 ? "off" : "\(Int(($0 * 100).rounded()))%" }
                    ) { value in
                        patch(selected.id) { $0.boxOpacity = value }
                    }
                }
                .padding(.horizontal, Theme.Layout.spacing3)
            }
        }
    }
}

// MARK: - One text box, rasterised

/// A text box drawn by the SAME code the exporter uses.
///
/// Held in `@State` and keyed on everything EXCEPT the box's position, so dragging a
/// caption across the picture re-renders nothing — only moving it changes, and that is a
/// `position` modifier.
private struct EditorTextBitmap: View {
    let item: EditText
    let source: CGSize
    let displayScale: CGFloat

    @State private var rendered: UIImage?

    private var key: String {
        [
            item.text,
            String(format: "%.5f", item.fontSize),
            String(format: "%.5f", item.boxWidth),
            String(format: "%.5f", item.padding),
            item.colorHex, item.boxColorHex,
            String(format: "%.3f", item.boxOpacity),
            item.alignment.rawValue,
            String(format: "%.3f", displayScale),
        ].joined(separator: "|")
    }

    var body: some View {
        ZStack {
            if let rendered {
                Image(uiImage: rendered).resizable()
            } else {
                // An empty box still needs a hit area, or a caption the user has just
                // added cannot be selected until they type something into it.
                Color.clear
            }
        }
        .task(id: key) {
            rendered = MediaEditRenderer.textImage(item, source: source, displayScale: displayScale)
        }
    }
}
