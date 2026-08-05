import SwiftUI
import UIKit

/// The crop stage.
///
/// ## It shows the whole picture, not the crop
///
/// The base bitmap here is composed with the crop forced to `nil` — rotation and flips
/// applied, crop deliberately not — because a crop UI whose job is to let you decide
/// what to cut away cannot hide what is being cut away. The crop rect is an overlay on
/// top, and everything outside it is dimmed by one even-odd fill rather than four
/// positioned scrims that could disagree with each other by a point.
///
/// ## Dragging happens in FRAME space
///
/// The model stores the crop in source-image coordinates, but the user drags it on the
/// rotated, flipped picture in front of them. So every gesture converts:
/// `rectSourceToFrame` on the way in, `rectFrameToSource` on the way out — both built
/// out of `MediaEditGeometry`'s point converters, so a handle cannot end up describing
/// a different rectangle than the exporter will cut.
///
/// A locked aspect ratio is also applied in frame space, where it means what it says:
/// displayed pixel width over displayed pixel height. Applying it in source space needs
/// an inversion for a quarter-turned image, which is precisely the sign error that
/// ships as "16:9 gave me 9:16".
///
/// ## The delta is measured from where the drag started
///
/// `dragStart` captures the rect at the first `onChanged` and every later update
/// recomputes from `start + translation`, rather than accumulating frame to frame.
/// Accumulating drifts: each intermediate rect is clamped, and clamping a clamped value
/// sixty times a second walks the rect away from the finger.
struct CropStageView: View {

    let image: UIImage
    let source: CGSize
    @Binding var edit: MediaEdit
    @Binding var aspect: AspectPreset
    let onCommit: () -> Void

    /// The composite with the crop ignored. Recomputed only when something it actually
    /// depends on changes — never while the crop rect is being dragged.
    @State private var base: UIImage?
    @State private var dragStart: CGRect?
    @State private var isDragging = false

    private var uncropped: MediaEdit {
        var copy = edit
        copy.crop = nil
        return copy
    }

    private var frame: CGSize { MediaEditGeometry.frameSize(source, edit) }

    private var cropInFrame: CGRect {
        MediaEditGeometry.rectSourceToFrame(MediaEditGeometry.crop(edit), edit)
    }

    private var cropPixels: String {
        let cropped = MediaEditGeometry.croppedPixelSize(source, edit)
        let w = Int(cropped.width)
        let h = Int(cropped.height)
        return MediaEditGeometry.isQuarterTurned(edit) ? "\(h) × \(w)" : "\(w) × \(h)"
    }

    var body: some View {
        VStack(spacing: 0) {
            GeometryReader { geo in
                let box = fitted(in: geo.size)
                ZStack {
                    if let base, box.width > 1 {
                        Image(uiImage: base)
                            .resizable()
                            .frame(width: box.width, height: box.height)
                            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                            .overlay(cropOverlay(box: box))
                    }
                }
                .frame(width: geo.size.width, height: geo.size.height)
                // Keyed on everything the BASE depends on — pointedly not the crop, so a
                // drag never triggers a re-raster.
                .task(id: rasterKey(box: box)) {
                    guard box.width > 1, box.height > 1 else { return }
                    // Device resolution, not point resolution — see `previewOutput`.
                    // Computed HERE, on the main actor, because it reads UIScreen.main.
                    let output = MediaEditRenderer.previewOutput(source: source, edit: uncropped, box: box)
                    // The composite itself is detached. A `.task` in a view body inherits
                    // the view's main actor, so a device-resolution raster ran on the run
                    // loop and froze the UI for the length of it — on a 12MP photo at 3x
                    // that is long enough to drop the drag the user is mid-way through.
                    let edit = uncropped
                    let src = source
                    let img = image
                    let composed = await Task.detached(priority: .userInitiated) {
                        MediaEditRenderer.compose(image: img, source: src, edit: edit, output: output)
                    }.value
                    guard !Task.isCancelled else { return }
                    base = composed
                }
            }

            controls
        }
    }

    // MARK: Layout

    /// The largest box of the FULL frame's aspect that fits, with a margin for the
    /// handles that hang outside the rect's edges.
    private func fitted(in available: CGSize) -> CGSize {
        let inset: CGFloat = 24
        let w = max(0, available.width - inset * 2)
        let h = max(0, available.height - inset * 2)
        guard w > 0, h > 0 else { return .zero }
        let ratio = frame.width / frame.height
        var width = w
        var height = width / ratio
        if height > h {
            height = h
            width = height * ratio
        }
        return CGSize(width: width.rounded(), height: height.rounded())
    }

    private func rasterKey(box: CGSize) -> String {
        // The annotations are IN this bitmap, so the key has to cover their content and
        // not just how many there are — an undone caption move leaves the counts
        // identical and would keep the stale bitmap on screen.
        [
            String(Int(box.width)), String(Int(box.height)),
            String(edit.rotation), String(edit.flipH), String(edit.flipV),
            edit.annotationFingerprint,
        ].joined(separator: "-")
    }

    // MARK: The crop window

    @ViewBuilder
    private func cropOverlay(box: CGSize) -> some View {
        let rect = CGRect(
            x: cropInFrame.minX * box.width,
            y: cropInFrame.minY * box.height,
            width: cropInFrame.width * box.width,
            height: cropInFrame.height * box.height
        )

        ZStack(alignment: .topLeading) {
            // One even-odd fill dims everything outside the window.
            Canvas { context, size in
                var path = Path(CGRect(origin: .zero, size: size))
                path.addRect(rect)
                context.fill(path, with: .color(.black.opacity(0.62)), style: FillStyle(eoFill: true))
            }
            .allowsHitTesting(false)

            // The window itself: hairline border, thirds grid while a gesture is live,
            // emerald corner brackets, and a draggable interior.
            ZStack {
                Rectangle()
                    .stroke(.white.opacity(0.9), lineWidth: 1)

                if isDragging {
                    // A permanent grid over a photo is noise; the grid's job is to help
                    // place an edge that is currently moving.
                    Path { path in
                        for i in 1...2 {
                            let x = rect.width * CGFloat(i) / 3
                            path.move(to: CGPoint(x: x, y: 0))
                            path.addLine(to: CGPoint(x: x, y: rect.height))
                            let y = rect.height * CGFloat(i) / 3
                            path.move(to: CGPoint(x: 0, y: y))
                            path.addLine(to: CGPoint(x: rect.width, y: y))
                        }
                    }
                    .stroke(.white.opacity(0.35), lineWidth: 1)
                }

                cornerBrackets(size: rect.size)
            }
            .frame(width: rect.width, height: rect.height)
            .contentShape(Rectangle())
            .gesture(dragGesture(anchor: nil, box: box))
            .offset(x: rect.minX, y: rect.minY)

            // Handles last, so they take the touch before the interior does.
            ForEach(CropAnchor.allCases) { anchor in
                handle(anchor)
                    .position(
                        x: rect.minX + rect.width * unitX(anchor),
                        y: rect.minY + rect.height * unitY(anchor)
                    )
                    .gesture(dragGesture(anchor: anchor, box: box))
            }
        }
        .frame(width: box.width, height: box.height, alignment: .topLeading)
    }

    /// All four brackets in ONE path, in the crop rect's own coordinates.
    ///
    /// At a glance they say "this rectangle is the thing you can grab". Four separate
    /// paths placed with `alignment:` does not work — a `Path`'s frame is sized to its
    /// own bounds, so aligning it inside the rect lands it wherever those bounds happen
    /// to start rather than on the corner.
    private func cornerBrackets(size: CGSize) -> some View {
        let arm: CGFloat = min(20, size.width / 3, size.height / 3)
        let inset: CGFloat = 1.5
        return Path { path in
            path.move(to: CGPoint(x: inset, y: arm))
            path.addLine(to: CGPoint(x: inset, y: inset))
            path.addLine(to: CGPoint(x: arm, y: inset))

            path.move(to: CGPoint(x: size.width - arm, y: inset))
            path.addLine(to: CGPoint(x: size.width - inset, y: inset))
            path.addLine(to: CGPoint(x: size.width - inset, y: arm))

            path.move(to: CGPoint(x: size.width - inset, y: size.height - arm))
            path.addLine(to: CGPoint(x: size.width - inset, y: size.height - inset))
            path.addLine(to: CGPoint(x: size.width - arm, y: size.height - inset))

            path.move(to: CGPoint(x: arm, y: size.height - inset))
            path.addLine(to: CGPoint(x: inset, y: size.height - inset))
            path.addLine(to: CGPoint(x: inset, y: size.height - arm))
        }
        .stroke(Theme.Color.primary, style: StrokeStyle(lineWidth: 3, lineCap: .round))
        .allowsHitTesting(false)
    }

    /// A 40pt touch target with a 12pt visible dot inside it: the dot is what reads, the
    /// target is what a thumb can actually hit.
    private func handle(_ anchor: CropAnchor) -> some View {
        Circle()
            .fill(.white)
            .frame(width: 12, height: 12)
            .shadow(color: .black.opacity(0.7), radius: 3, y: 1)
            .frame(width: 40, height: 40)
            .contentShape(Circle())
            .accessibilityLabel(anchor.label)
    }

    private func unitX(_ anchor: CropAnchor) -> CGFloat {
        switch anchor {
        case .nw, .w, .sw: return 0
        case .n, .s: return 0.5
        case .ne, .e, .se: return 1
        }
    }

    private func unitY(_ anchor: CropAnchor) -> CGFloat {
        switch anchor {
        case .nw, .n, .ne: return 0
        case .w, .e: return 0.5
        case .sw, .s, .se: return 1
        }
    }

    // MARK: Gestures

    private func dragGesture(anchor: CropAnchor?, box: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard box.width > 1, box.height > 1 else { return }
                if dragStart == nil {
                    // History is pushed HERE, before the first write — `pushHistory`
                    // records the CURRENT model, so committing at the end of the drag
                    // would store the rect the drag produced and Undo's first press
                    // would restore what is already on screen. One push per gesture, at
                    // the start of it.
                    onCommit()
                    dragStart = cropInFrame
                    isDragging = true
                }
                guard let start = dragStart else { return }
                let dx = value.translation.width / box.width
                let dy = value.translation.height / box.height

                guard let anchor else {
                    // A move never changes the size, so it never needs the ratio pass.
                    write(CGRect(
                        x: min(max(start.minX + dx, 0), 1 - start.width),
                        y: min(max(start.minY + dy, 0), 1 - start.height),
                        width: start.width, height: start.height
                    ))
                    return
                }

                var next = start
                if anchor.holdsWest { next.origin.x = start.minX + dx; next.size.width = start.width - dx }
                if anchor.holdsEast { next.size.width = start.width + dx }
                if anchor.holdsNorth { next.origin.y = start.minY + dy; next.size.height = start.height - dy }
                if anchor.holdsSouth { next.size.height = start.height + dy }
                // Dragged past the opposite edge: fold the rect rather than letting a
                // negative span through, which would render inside-out — and carry the
                // anchor through the fold with it, because the finger is now on the
                // OPPOSITE handle and `clampFrameRect` pins whichever edge the anchor
                // names.
                let folded = MediaEditGeometry.foldDragRect(next, anchor: anchor)

                write(MediaEditGeometry.clampFrameRect(
                    folded.rect, frame: frame, ratio: aspect.ratio, anchor: folded.anchor
                ))
            }
            .onEnded { _ in
                dragStart = nil
                isDragging = false
            }
    }

    private func write(_ frameRect: CGRect) {
        edit.crop = MediaEditGeometry.clampCrop(MediaEditGeometry.rectFrameToSource(frameRect, edit))
    }

    // MARK: Controls

    private var controls: some View {
        VStack(spacing: Theme.Layout.spacing2) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(AspectPreset.allCases) { preset in
                        EditorChip(label: preset.label, isActive: preset == aspect) {
                            pick(preset)
                        }
                    }
                }
                .padding(.horizontal, Theme.Layout.spacing3)
            }
            .frame(height: 34)

            HStack(spacing: 6) {
                EditorCircleButton(symbol: "rotate.left", label: "Rotate left") { rotate(-90) }
                EditorCircleButton(symbol: "rotate.right", label: "Rotate right") { rotate(90) }
                EditorCircleButton(symbol: "arrow.left.and.right.righttriangle.left.righttriangle.right", label: "Flip horizontally") { flip(horizontal: true) }
                EditorCircleButton(symbol: "arrow.up.and.down.righttriangle.up.righttriangle.down", label: "Flip vertically") { flip(horizontal: false) }

                Spacer(minLength: Theme.Layout.spacing2)

                Text(cropPixels)
                    .font(Theme.Typography.micro)
                    .foregroundStyle(Theme.Color.textMuted)
                    .monospacedDigit()

                EditorChip(label: "Reset") { reset() }
            }
            .padding(.horizontal, Theme.Layout.spacing3)
            .padding(.bottom, Theme.Layout.spacing2)
        }
    }

    private func pick(_ preset: AspectPreset) {
        onCommit()
        aspect = preset
        guard let ratio = preset.ratio else { return }
        let fitted = MediaEditGeometry.centeredFrameRect(frame: frame, ratio: ratio)
        edit.crop = MediaEditGeometry.clampCrop(MediaEditGeometry.rectFrameToSource(fitted, edit))
    }

    private func rotate(_ delta: Int) {
        onCommit()
        var next = edit
        next.rotation = MediaEditGeometry.normalized(edit.rotation + delta)
        if let ratio = aspect.ratio {
            // A quarter turn inverts the frame's own aspect, so a rect locked to 16:9 is
            // no longer 16:9 of what is on screen. Re-fit rather than silently leaving
            // the lock broken.
            let rotatedFrame = MediaEditGeometry.frameSize(source, next)
            let fitted = MediaEditGeometry.centeredFrameRect(frame: rotatedFrame, ratio: ratio)
            next.crop = MediaEditGeometry.clampCrop(MediaEditGeometry.rectFrameToSource(fitted, next))
        }
        edit = next
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// Flip what the user can SEE.
    ///
    /// The pipeline applies flips before rotation, so on a quarter-turned image the axis
    /// the user is pointing at is the other one. Swapping here keeps the button honest;
    /// doing it in the model would mean the exporter and the preview disagreeing about
    /// what `flipH` means.
    private func flip(horizontal: Bool) {
        onCommit()
        let swap = MediaEditGeometry.isQuarterTurned(edit)
        if horizontal == !swap { edit.flipH.toggle() } else { edit.flipV.toggle() }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func reset() {
        onCommit()
        aspect = .free
        edit.crop = MediaEditGeometry.fullCrop
        edit.rotation = 0
        edit.flipH = false
        edit.flipV = false
    }
}
