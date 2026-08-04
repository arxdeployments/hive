import AVFoundation
import CoreGraphics
import ImageIO
import SwiftUI
import UIKit

/// Turning a `MediaEdit` into pixels — for the live preview and for the bytes that
/// get sent.
///
/// Both go through `MediaEditGeometry.apply(to:)`, so the composite on screen is the
/// composite that is uploaded. That is not a nicety: a caption that reflows or a
/// stroke that shifts between placing it and sending it is worse than not having the
/// tool.

// MARK: - Text layout

/// One place that decides how a text box is measured and drawn.
///
/// Measurement and drawing share the same `NSAttributedString` and the same
/// paragraph style, so the wrapped lines are identical in the preview and in the
/// export — the box's chrome cannot end up sized for different text than the glyphs
/// it surrounds.
enum EditTextLayout {

    struct Layout {
        var fontPointSize: CGFloat
        var pad: CGFloat
        var contentWidth: CGFloat
        var boxSize: CGSize
        var attributed: NSAttributedString
    }

    /// Semibold system, matching the web editor's `600` weight. The web uses Inter and
    /// iOS uses SF Pro throughout this app (see `Theme.Typography`), so the two
    /// clients differ in face exactly as every other label in the product does.
    private static func font(_ points: CGFloat) -> UIFont {
        UIFont.systemFont(ofSize: max(1, points), weight: .semibold)
    }

    /// Height, in points, every text box is laid out at regardless of the decode.
    ///
    /// The editor decodes the photo at 2400px and the exporter at 4096px, so laying out
    /// against `source.height` would shape the glyphs at two different point sizes.
    /// CoreText line breaking is not exactly scale-invariant — fractional advances round
    /// differently — so a caption that fits on two lines in the editor can come back as
    /// three in the sent image. Laying out at a fixed reference height and scaling the
    /// result into place makes the wrapped lines identical everywhere.
    static let referenceHeight: CGFloat = 1000

    /// Points of real output per point of reference layout.
    static func referenceScale(for source: CGSize) -> CGFloat {
        max(source.height, 1) / referenceHeight
    }

    /// The size to lay out against: the reference height, with the source's aspect.
    static func referenceSource(for source: CGSize) -> CGSize {
        let k = referenceScale(for: source)
        return CGSize(width: max(1, source.width / k), height: referenceHeight)
    }

    /// Lay a box out. `source` should be the REFERENCE size — callers go through
    /// `layout(_:forSource:)`, which converts.
    static func layout(_ item: EditText, source: CGSize) -> Layout {
        let points = max(1, item.fontSize * source.height)
        let pad = item.padding * source.height
        let contentWidth = max(1, item.boxWidth * source.width)

        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = item.alignment.nsAlignment
        paragraph.lineHeightMultiple = MediaEditLimits.lineHeightMultiple
        paragraph.lineBreakMode = .byWordWrapping

        let attributed = NSAttributedString(
            // A single space when empty, so a box the user has not typed into still
            // has one line's worth of height and its handles do not collapse.
            string: item.text.isEmpty ? " " : item.text,
            attributes: [
                .font: font(points),
                .foregroundColor: EditorInk.uiColor(item.colorHex),
                .paragraphStyle: paragraph,
            ]
        )

        let bounds = attributed.boundingRect(
            with: CGSize(width: contentWidth, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )

        return Layout(
            fontPointSize: points,
            pad: pad,
            contentWidth: contentWidth,
            boxSize: CGSize(width: contentWidth + pad * 2, height: ceil(bounds.height) + pad * 2),
            attributed: attributed
        )
    }

    /// The layout for a real decode, expressed in that decode's own points.
    ///
    /// Measured at the reference height and scaled up, so the wrapped LINES are decided
    /// once and cannot differ between the editor's decode and the exporter's.
    static func layout(_ item: EditText, forSource source: CGSize) -> Layout {
        let k = referenceScale(for: source)
        let base = layout(item, source: referenceSource(for: source))
        return Layout(
            fontPointSize: base.fontPointSize * k,
            pad: base.pad * k,
            contentWidth: base.contentWidth * k,
            boxSize: CGSize(width: base.boxSize.width * k, height: base.boxSize.height * k),
            attributed: base.attributed
        )
    }

    /// Draw the box and its text with its CENTRE at `centre`, in whatever coordinate
    /// space the context is currently in.
    ///
    /// `NSAttributedString.draw` renders into the current UIKit graphics context, so this
    /// must be called from inside a `UIGraphicsImageRenderer` block — which both callers
    /// are. The context is scaled to the reference layout first, so the glyphs are shaped
    /// at exactly the size they were measured at.
    static func draw(_ item: EditText, source: CGSize, centre: CGPoint, in cg: CGContext) {
        guard !item.text.isEmpty else { return }
        let k = referenceScale(for: source)
        let layout = layout(item, source: referenceSource(for: source))

        cg.saveGState()
        cg.translateBy(x: centre.x, y: centre.y)
        cg.scaleBy(x: k, y: k)

        let box = CGRect(
            x: -layout.boxSize.width / 2,
            y: -layout.boxSize.height / 2,
            width: layout.boxSize.width,
            height: layout.boxSize.height
        )

        if item.boxOpacity > 0 {
            let plate = UIBezierPath(roundedRect: box, cornerRadius: layout.pad * 0.9)
            EditorInk.uiColor(item.boxColorHex).withAlphaComponent(item.boxOpacity).setFill()
            plate.fill()
        }

        layout.attributed.draw(
            with: box.insetBy(dx: layout.pad, dy: layout.pad),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )
        cg.restoreGState()
    }
}

// MARK: - Stroke geometry

/// The one place a stroke's shape is decided.
///
/// Shared by the exporter — which maps points into source pixels — and by the
/// editor's live `Canvas`, which maps them into display points. Two copies of the
/// smoothing would eventually disagree, and the disagreement would be a stroke that
/// moves slightly the instant it is committed.
enum EditStrokeGeometry {

    /// Quadratic midpoint smoothing. A polyline through raw touch samples is visibly
    /// faceted: events arrive every ~8ms and a fast swipe leaves 40-point gaps between
    /// them, so the corners show.
    static func path(_ stroke: EditStroke, mapping: (CGPoint) -> CGPoint) -> Path {
        var path = Path()
        guard let first = stroke.points.first else { return path }
        path.move(to: mapping(first))
        if stroke.points.count == 1 { return path }

        if stroke.points.count > 2 {
            for i in 1..<(stroke.points.count - 1) {
                let c = stroke.points[i]
                let n = stroke.points[i + 1]
                path.addQuadCurve(
                    to: mapping(CGPoint(x: (c.x + n.x) / 2, y: (c.y + n.y) / 2)),
                    control: mapping(c)
                )
            }
        }
        if let last = stroke.points.last { path.addLine(to: mapping(last)) }
        return path
    }
}

// MARK: - Stills

enum MediaEditRenderer {

    struct Rendered {
        let data: Data
        let filename: String
    }

    /// Decode a picked file into something drawable, upright.
    ///
    /// Via ImageIO rather than `UIImage(data:)`: `CGImageSourceCreateThumbnailAtIndex`
    /// decodes straight to the target size, so a 12MP HEIC never becomes a 48 MB
    /// bitmap in memory first — on an older device that is the difference between an
    /// edit and a jetsam kill. It also applies the EXIF orientation transform, so a
    /// photo taken sideways is not edited sideways. Same reasoning as
    /// `MediaTranscoder.image`.
    ///
    /// The size this returns becomes the model's source size. That is safe at any
    /// decode size because every stored value is a FRACTION of it — so the editor can
    /// work from a 2400px decode while the export works from a 4096px one and the two
    /// agree exactly.
    static func decode(data: Data, maxEdge: CGFloat) -> UIImage? {
        MediaTranscoder.thumbnail(data: data, maxEdge: maxEdge)
    }

    /// Device pixels per point, capped.
    ///
    /// Capped at 3 because that is the most any shipping iPhone has, and an uncapped
    /// value would let a future device quadruple every preview bitmap for no visible
    /// gain.
    static var screenScale: CGFloat { min(3, max(1, UIScreen.main.scale)) }

    /// The output descriptor for a preview that fills a box of POINTS at device resolution.
    ///
    /// The box has to be converted to pixels before `displayOutput` sees it, or the
    /// composite is rasterised at one pixel per point and the photo is previewed at a
    /// third of the resolution the screen can show — which matters here more than
    /// anywhere else in the app, because the user is judging a crop edge and the
    /// sharpness of a pen stroke on it.
    static func previewOutput(source: CGSize, edit: MediaEdit, box: CGSize) -> MediaEditGeometry.Output {
        let scale = screenScale
        return MediaEditGeometry.displayOutput(
            source, edit,
            box: CGSize(width: box.width * scale, height: box.height * scale)
        )
    }

    /// Paint the composite into a bitmap of `output.size`.
    static func compose(image: UIImage, source: CGSize, edit: MediaEdit, output: MediaEditGeometry.Output) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        // 1: the output size is already in real pixels, so a 3x scale would triple
        // them again and quietly produce a 12000px JPEG from a 4096px request.
        format.scale = 1
        format.opaque = true

        return UIGraphicsImageRenderer(size: output.size, format: format).image { context in
            let cg = context.cgContext
            // Opaque black first: a rotation that does not exactly fill the surface
            // reads as letterboxing rather than as uninitialised memory.
            UIColor.black.setFill()
            cg.fill(CGRect(origin: .zero, size: output.size))

            cg.saveGState()
            MediaEditGeometry.apply(to: cg, source: source, edit: edit, output: output)
            cg.interpolationQuality = .high
            image.draw(in: CGRect(origin: .zero, size: source))
            drawStrokes(edit.strokes, source: source, in: cg)
            drawTexts(edit.texts, source: source, edit: edit, in: cg, skipping: nil)
            cg.restoreGState()
        }
    }

    /// Bake original + edit into JPEG bytes, with the filename the server needs.
    ///
    /// JPEG rather than PNG: unlike the web there is no second keep-the-smaller pass
    /// that could recover from a 30 MB screenshot PNG — `MediaTranscoder.image`
    /// returns the ORIGINAL bytes and the ORIGINAL filename when the source is
    /// already a JPEG no larger than its re-encode, which means it cannot be relied
    /// on to normalise an extension. Emitting `.jpg` here keeps classification
    /// correct whichever branch that takes.
    static func render(data: Data, filename: String, edit: MediaEdit, maxEdge: CGFloat = MediaEditLimits.exportMaxEdge) -> Rendered? {
        guard let image = decode(data: data, maxEdge: maxEdge) else { return nil }
        let source = image.size
        let output = MediaEditGeometry.output(source, edit, maxEdge: maxEdge)
        let composed = compose(image: image, source: source, edit: edit, output: output)
        // 0.95, not the tier's quality: `MediaTranscoder.image` re-encodes this again
        // at the chosen tier on the way out, and stacking two lossy passes at 0.7
        // visibly softens thin pen strokes and small type.
        guard let jpeg = composed.jpegData(compressionQuality: 0.95) else { return nil }
        let base = (filename as NSString).deletingPathExtension
        return Rendered(data: jpeg, filename: "\(base.isEmpty ? "IMG" : base).jpg")
    }

    /// A preview-sized bitmap of the whole composite, for the send sheet's thumbnail.
    static func previewImage(data: Data, edit: MediaEdit, maxEdge: CGFloat = 1400) -> UIImage? {
        guard let image = decode(data: data, maxEdge: maxEdge) else { return nil }
        let source = image.size
        let output = MediaEditGeometry.output(source, edit, maxEdge: maxEdge)
        return compose(image: image, source: source, edit: edit, output: output)
    }

    // MARK: Layers

    /// Draw the strokes. Source-pixel space; call inside `MediaEditGeometry.apply`.
    static func drawStrokes(_ strokes: [EditStroke], source: CGSize, in cg: CGContext) {
        guard !strokes.isEmpty else { return }
        let shortEdge = max(1, min(source.width, source.height))
        let toSourcePixels: (CGPoint) -> CGPoint = { CGPoint(x: $0.x * source.width, y: $0.y * source.height) }

        for stroke in strokes {
            guard !stroke.points.isEmpty else { continue }
            let width = max(0.5, stroke.width * shortEdge)
            let color = EditorInk.uiColor(stroke.colorHex)

            // A single tap is a dot, and a zero-length path strokes nothing at all —
            // so it is filled as a circle rather than being silently lost.
            if stroke.points.count == 1 {
                let centre = toSourcePixels(stroke.points[0])
                color.setFill()
                cg.fillEllipse(in: CGRect(
                    x: centre.x - width / 2, y: centre.y - width / 2,
                    width: width, height: width
                ))
                continue
            }

            cg.saveGState()
            cg.setLineWidth(width)
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            cg.setStrokeColor(color.cgColor)
            cg.addPath(EditStrokeGeometry.path(stroke, mapping: toSourcePixels).cgPath)
            cg.strokePath()
            cg.restoreGState()
        }
    }

    /// Draw the text boxes. Source-pixel space; call inside `MediaEditGeometry.apply`.
    ///
    /// ## Text is glued in place but never turned or mirrored
    ///
    /// A stroke should rotate with the picture — a hand-drawn arrow that stopped
    /// pointing at the thing it was drawn on would be wrong. Type should not:
    /// mirrored text is unreadable and sideways text nearly so, and nobody rotating a
    /// photo is asking for their caption to end up on its side.
    ///
    /// So each box translates to its glued source point and then undoes the outer
    /// transform's rotation and mirroring, leaving only the uniform scale. The
    /// current matrix at that point is `s·R·F`; `scaleBy(F)` makes it `s·R` (F is its
    /// own inverse and s is scalar, so it commutes) and `rotate(-θ)` then makes it
    /// `s·I`. Upright, unmirrored, correct size, still anchored to the pixel it was
    /// placed on — which is also what lets the editor's drag handles be plain
    /// axis-aligned SwiftUI views.
    static func drawTexts(
        _ texts: [EditText],
        source: CGSize,
        edit: MediaEdit,
        in cg: CGContext,
        skipping skipID: UUID?
    ) {
        guard !texts.isEmpty else { return }
        let radians = CGFloat(MediaEditGeometry.normalized(edit.rotation)) * .pi / 180

        for item in texts {
            if item.id == skipID { continue }
            guard !item.text.isEmpty else { continue }
            cg.saveGState()
            cg.translateBy(x: item.centre.x * source.width, y: item.centre.y * source.height)
            cg.scaleBy(x: edit.flipH ? -1 : 1, y: edit.flipV ? -1 : 1)
            cg.rotate(by: -radians)
            EditTextLayout.draw(item, source: source, centre: .zero, in: cg)
            cg.restoreGState()
        }
    }

    /// One text box on its own transparent bitmap, for the editor's live overlay.
    ///
    /// Drawn by the SAME `EditTextLayout.draw` the exporter uses, so the preview is
    /// the export — there is no second text renderer that could disagree with it.
    /// Pixels a single caption's bitmap may occupy.
    ///
    /// A cap is not optional. `boxWidth` is a fraction of the SOURCE, so a caption placed
    /// on the whole photo and then cropped to a sliver keeps its source-space width while
    /// `output.scale` climbs — the requested bitmap grows without bound and the allocation
    /// is what fails, not the drawing. 16 megapixels is far more than any caption needs on
    /// any iPhone, and beyond it the render simply gets coarser rather than dying.
    private static let textBitmapBudget: CGFloat = 16_000_000

    static func textImage(_ item: EditText, source: CGSize, displayScale: CGFloat) -> UIImage? {
        guard !item.text.isEmpty else { return nil }
        let layout = EditTextLayout.layout(item, forSource: source)
        guard layout.boxSize.width > 0, layout.boxSize.height > 0 else { return nil }

        let pointSize = CGSize(
            width: layout.boxSize.width * displayScale,
            height: layout.boxSize.height * displayScale
        )
        guard pointSize.width >= 1, pointSize.height >= 1 else { return nil }

        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = false
        // Bounded, and bounded on the RESOLUTION rather than on the size, so the caption
        // is still drawn at the geometry the stage expects — just with fewer pixels behind
        // it than the screen could show.
        let requested = pointSize.width * pointSize.height * format.scale * format.scale
        if requested > textBitmapBudget {
            format.scale = max(0.05, format.scale * sqrt(textBitmapBudget / requested))
        }

        return UIGraphicsImageRenderer(size: pointSize, format: format).image { context in
            let cg = context.cgContext
            cg.scaleBy(x: displayScale, y: displayScale)
            EditTextLayout.draw(
                item, source: source,
                centre: CGPoint(x: layout.boxSize.width / 2, y: layout.boxSize.height / 2),
                in: cg
            )
        }
    }
}

// MARK: - Video

/// Cropping, rotating and flipping a clip.
///
/// One export, not two. Stacking a crop pass on top of `MediaTranscoder.video`'s
/// tier pass would mean two H.264 generations, double the wall clock, and a size
/// guard comparing against the wrong baseline — so the edit is threaded INTO that
/// export and the tier is expressed by scaling `renderSize` instead of by a preset.
enum VideoEditComposer {

    enum Failure: LocalizedError {
        case noVideoTrack
        case unsupported
        case exportFailed(String?)

        var errorDescription: String? {
            switch self {
            case .noVideoTrack: return "That clip has no video track to crop."
            case .unsupported: return "That clip could not be re-encoded on this device."
            case .exportFailed(let detail): return detail ?? "The cropped clip could not be written."
            }
        }
    }

    /// Long edge the cropped clip is fitted inside, per tier. Never upscales.
    ///
    /// A cap is needed because a composition export re-encodes at `renderSize`, and
    /// letting 4K through means a minutes-long export of a file nobody can send over
    /// cellular. Matches the web editor's own 1080p ceiling.
    static func maxEdge(for quality: MediaQuality) -> CGFloat {
        quality == .hd ? 1920 : 1280
    }

    /// Build the composition for an edit, or throw with something a user can read.
    ///
    /// Returns the composition and the even-rounded render size.
    static func composition(
        for asset: AVAsset,
        edit: MediaEdit,
        quality: MediaQuality
    ) async throws -> (AVMutableVideoComposition, CGSize) {
        guard let tracks = try? await asset.loadTracks(withMediaType: .video),
              let track = tracks.first
        else { throw Failure.noVideoTrack }

        let naturalSize = try await track.load(.naturalSize)
        let preferred = try await track.load(.preferredTransform)
        let duration = try await asset.load(.duration)

        // The user drew the crop rect on the ROTATED preview, so the rect lives in
        // display space — after `preferredTransform`, not in `naturalSize` space.
        let displayRect = CGRect(origin: .zero, size: naturalSize).applying(preferred)
        let display = CGSize(width: abs(displayRect.width), height: abs(displayRect.height))
        guard display.width >= 1, display.height >= 1 else { throw Failure.noVideoTrack }

        let c = MediaEditGeometry.crop(edit)
        let cropRect = CGRect(
            x: c.minX * display.width,
            y: c.minY * display.height,
            width: max(2, c.width * display.width),
            height: max(2, c.height * display.height)
        )

        // Tier by render size. H.264 needs even dimensions in both axes — an odd one
        // fails the export or produces a garbage edge column — and the rounding is
        // done on the UNROTATED box with the rotated size derived from it, so the
        // transform still agrees with the surface it is drawing into.
        let limit = maxEdge(for: quality)
        let scale = min(1, limit / max(cropRect.width, cropRect.height))
        let uw = max(2, (cropRect.width * scale).rounded().evenDown)
        let uh = max(2, (cropRect.height * scale).rounded().evenDown)
        let quarter = MediaEditGeometry.isQuarterTurned(edit)
        let render = quarter ? CGSize(width: uh, height: uw) : CGSize(width: uw, height: uh)

        // Raw pixels → display space, with the origin pulled back to zero.
        //
        // Baking `preferredTransform` in is NOT optional. AVFoundation applies it for
        // you only while there is no `videoComposition`; the moment one is set that
        // stops, and omitting it is the classic "my cropped video exports sideways".
        var transform = preferred
            .concatenating(CGAffineTransform(translationX: -displayRect.minX, y: -displayRect.minY))
        // Then the same pipeline the still renderer uses, in the same order: crop,
        // scale, centre, flip, rotate, place. `a.concatenating(b)` is "a then b", so
        // this reads forward while `CGContext` calls read backward.
        transform = transform
            .concatenating(CGAffineTransform(translationX: -cropRect.minX, y: -cropRect.minY))
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(translationX: -uw / 2, y: -uh / 2))
            .concatenating(CGAffineTransform(scaleX: edit.flipH ? -1 : 1, y: edit.flipV ? -1 : 1))
            .concatenating(CGAffineTransform(rotationAngle: CGFloat(MediaEditGeometry.normalized(edit.rotation)) * .pi / 180))
            .concatenating(CGAffineTransform(translationX: render.width / 2, y: render.height / 2))

        let composition = AVMutableVideoComposition(propertiesOf: asset)
        composition.renderSize = render
        // Anything other than 1 is playback-only and fails an export.
        composition.renderScale = 1

        // Carry the source's colour tagging across. Every recent iPhone records
        // 10-bit HDR, and a composition that does not declare its colour space
        // tone-maps the result wrong — visibly washed out.
        if let description = try? await track.load(.formatDescriptions).first,
           let extensions = CMFormatDescriptionGetExtensions(description) as NSDictionary? {
            if let primaries = extensions[kCVImageBufferColorPrimariesKey] as? String,
               let transfer = extensions[kCVImageBufferTransferFunctionKey] as? String,
               let matrix = extensions[kCVImageBufferYCbCrMatrixKey] as? String {
                composition.colorPrimaries = primaries
                composition.colorTransferFunction = transfer
                composition.colorYCbCrMatrix = matrix
            }
        }

        let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
        layer.setTransform(transform, at: .zero)

        let instruction = AVMutableVideoCompositionInstruction()
        instruction.timeRange = CMTimeRange(start: .zero, duration: duration)
        instruction.layerInstructions = [layer]
        composition.instructions = [instruction]

        return (composition, render)
    }
}

private extension CGFloat {
    /// Nearest even value at or below self. H.264 chroma subsampling requires it.
    var evenDown: CGFloat {
        let i = Int(self)
        return CGFloat(i - (i % 2))
    }
}
