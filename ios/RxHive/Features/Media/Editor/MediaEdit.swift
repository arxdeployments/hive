import CoreGraphics
import SwiftUI
import UIKit

/// The edit model for a picked photo or clip, and the geometry that gives it meaning.
///
/// Two features sit on top of this: crop / rotate / flip, and freehand drawing plus
/// text boxes. Both are pre-send edits — nothing here touches the network, exactly
/// like the confirm step it hangs off (`MediaSendSheet`).
///
/// ## One rule makes revert free
///
/// A `PendingMedia` keeps its ORIGINAL bytes for as long as it is staged and carries
/// a `MediaEdit` beside them. The bytes that get uploaded are re-derived from
/// original + model whenever the user saves, so "revert to original" is
/// `MediaEdit()` — not an inverse transform — and a second editing pass re-renders
/// from the original rather than compounding JPEG generations on the first pass's
/// output.
///
/// ## Everything is stored in SOURCE space
///
/// Stroke points, text positions, pen widths and font sizes are all normalised
/// against the ORIGINAL image — 0…1 of its width and height, widths as a fraction
/// of its short edge. Not against the visible frame.
///
/// Storing them against what is on screen looks simpler until the user crops after
/// drawing: annotations in frame space would slide across the picture as the frame
/// moved. In source space they are glued to the pixels they were drawn on, so crop,
/// rotate and flip carry them along and a tighter crop genuinely cuts a stroke in
/// half — which is what everyone expects. The cost is two coordinate conversions,
/// `framePointToSource` and `sourcePointToFrame`, and they are the only fiddly
/// maths in the feature.
///
/// ## The pipeline, in order
///
///     crop  →  flipH / flipV  →  rotate (multiples of 90°)
///
/// Fixed and non-negotiable, because the on-screen preview and the exported bytes
/// have to agree to the pixel: both go through `MediaEditGeometry.apply(to:)`. The
/// UI hides the consequence — at 90°/270° the "flip horizontal" button toggles
/// `flipV`, so the control always flips what the user can actually see.
///
/// Mirrors `frontend/src/utils/mediaEdit.js`: the same model, the same pipeline
/// order, the same pen fractions and the same rotation formulae. A change on either
/// side has to be made on both.
struct MediaEdit: Equatable {

    /// Normalised rect in SOURCE space, pre-rotation. `nil` means the whole frame.
    var crop: CGRect?
    /// Clockwise, degrees. Only 0/90/180/270 — see the note on the straighten dial.
    var rotation: Int = 0
    var flipH = false
    var flipV = false
    var strokes: [EditStroke] = []
    var texts: [EditText] = []

    /// Is there anything to bake — and therefore anything for Revert to undo?
    var hasEdits: Bool {
        isCropped
            || MediaEditGeometry.normalized(rotation) != 0
            || flipH || flipV
            || !strokes.isEmpty
            || !texts.isEmpty
    }

    var isCropped: Bool {
        guard let crop else { return false }
        let e: CGFloat = 0.0001
        return crop.minX > e || crop.minY > e || crop.width < 1 - e || crop.height < 1 - e
    }

    /// Drop text boxes nobody typed into.
    ///
    /// Tapping "Add text" creates the box before there is anything in it, so leaving the
    /// editor at that moment — switching to the pen, or pressing Done — would otherwise
    /// leave an invisible empty box in the model. `hasEdits` counts it, so the item gets
    /// badged as edited, Revert appears with nothing to undo, and Save re-encodes the
    /// photo to add precisely nothing.
    ///
    /// Applied at the save chokepoint rather than in the stage, so it holds for every way
    /// out of the editor rather than only the one that happens to call back into the text
    /// tool.
    func pruningEmptyTexts() -> MediaEdit {
        let kept = texts.filter { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        guard kept.count != texts.count else { return self }
        var copy = self
        copy.texts = kept
        return copy
    }

    /// Everything the rasterised base of a stage depends on, as a cheap string.
    ///
    /// `MediaEdit` is not `Hashable` (`PendingMedia` is `Identifiable` only, and the
    /// nested types follow), and a `.task(id:)` needs something comparable. Counting
    /// strokes and boxes is not enough: moving a caption or retyping it leaves the counts
    /// identical, so the cached bitmap would keep showing where the caption used to be.
    var annotationFingerprint: String {
        var parts: [String] = []
        for stroke in strokes {
            parts.append("s\(stroke.points.count)\(stroke.colorHex)\(String(format: "%.5f", stroke.width))")
        }
        for text in texts {
            parts.append(
                "t\(text.text.count)"
                + String(format: "%.4f,%.4f,%.5f,%.5f,%.4f", text.centre.x, text.centre.y, text.fontSize, text.boxWidth, text.boxOpacity)
                + text.colorHex + text.boxColorHex + text.alignment.rawValue
            )
        }
        return parts.joined(separator: ";")
    }

    /// A one-line summary for the send sheet's "Edited" chip.
    var summary: String {
        var parts: [String] = []
        if isCropped { parts.append("cropped") }
        let r = MediaEditGeometry.normalized(rotation)
        if r != 0 { parts.append("rotated \(r)°") }
        if flipH || flipV { parts.append("flipped") }
        if !strokes.isEmpty { parts.append("drawn on") }
        if !texts.isEmpty { parts.append(texts.count == 1 ? "text added" : "\(texts.count) texts") }
        return parts.joined(separator: " · ")
    }

    /// Deliberately no free-angle straighten dial.
    ///
    /// The reference app has one, and it is tempting because `CGContext.rotate` takes
    /// any angle. What it costs is a crop rect that is no longer axis-aligned in
    /// source space: every hit test, every handle drag and both coordinate
    /// conversions gain a rotation term, and the crop stops being expressible as a
    /// `CGRect`. Multiples of 90° keep the model a rectangle, which is what makes
    /// crop-after-draw provably correct rather than approximately correct. Rotation
    /// is stored as a number rather than an enum so adding it later is a change to
    /// the geometry, not to the stored shape.
    static let quarterTurns = [0, 90, 180, 270]
}

// MARK: - Strokes

struct EditStroke: Identifiable, Equatable {
    let id = UUID()
    /// `#RRGGBB`, so the value is the same string the web model stores.
    var colorHex: String
    /// Fraction of the SOURCE short edge.
    var width: CGFloat
    /// Normalised source-space points.
    var points: [CGPoint]
}

/// The four pen widths, as a fraction of the VISIBLE frame's short edge.
enum PenSize: String, CaseIterable, Identifiable {
    case fine, medium, bold, marker

    var id: String { rawValue }

    var title: String {
        switch self {
        case .fine: return "Fine"
        case .medium: return "Medium"
        case .bold: return "Bold"
        case .marker: return "Marker"
        }
    }

    var fraction: CGFloat {
        switch self {
        case .fine: return 0.006
        case .medium: return 0.013
        case .bold: return 0.024
        case .marker: return 0.042
        }
    }

    /// Diameter of the dot drawn on the picker chip.
    var dot: CGFloat {
        switch self {
        case .fine: return 5
        case .medium: return 9
        case .bold: return 14
        case .marker: return 20
        }
    }
}

// MARK: - Text boxes

/// A text box.
///
/// The two size controls the brief asks for are genuinely independent: `fontSize`
/// scales the glyphs, `boxWidth` sets the wrap width — so the same sentence can be
/// one tall column or one wide line at the same type size. Likewise `colorHex` and
/// `boxColorHex`/`boxOpacity` are separate, and `boxOpacity` starts at 0, which is
/// the transparent background the brief is specified around: nothing is drawn
/// behind the glyphs at all until the user asks for a plate.
struct EditText: Identifiable, Equatable {
    let id = UUID()
    var text: String = ""
    /// Normalised SOURCE coordinates of the box's CENTRE.
    var centre = CGPoint(x: 0.5, y: 0.5)
    /// Wrap width of the text, as a fraction of source width.
    var boxWidth: CGFloat = 0.6
    /// Fraction of source HEIGHT — so type is the same visual size on a portrait or
    /// a landscape photo.
    var fontSize: CGFloat = 0.055
    /// Inner padding, as a fraction of source height.
    var padding: CGFloat = 0.014
    var colorHex: String = "#FFFFFF"
    var boxColorHex: String = "#0A0A0A"
    /// 0 = the transparent background this feature is specified around.
    var boxOpacity: CGFloat = 0
    var alignment: TextAlignmentOption = .center

    enum TextAlignmentOption: String, CaseIterable, Identifiable, Equatable {
        case left, center, right
        var id: String { rawValue }
        var nsAlignment: NSTextAlignment {
            switch self {
            case .left: return .left
            case .center: return .center
            case .right: return .right
            }
        }
        var symbol: String {
            switch self {
            case .left: return "text.alignleft"
            case .center: return "text.aligncenter"
            case .right: return "text.alignright"
            }
        }
        var label: String {
            switch self {
            case .left: return "Align left"
            case .center: return "Align centre"
            case .right: return "Align right"
            }
        }
    }
}

// MARK: - Editor constants

enum MediaEditLimits {
    static let lineHeightMultiple: CGFloat = 1.26

    /// Slider limits, expressed against the VISIBLE frame rather than the source.
    ///
    /// These are the numbers the user is really choosing: 3%–30% of the frame's
    /// height for type, 15%–100% of its width for the wrap box. The stored values
    /// stay source-relative; `frameFontFraction` / `frameBoxFraction` translate.
    static let fontFrameMin: CGFloat = 0.03
    static let fontFrameMax: CGFloat = 0.30
    static let fontFrameDefault: CGFloat = 0.075
    static let boxFrameMin: CGFloat = 0.15
    static let boxFrameMax: CGFloat = 1.0
    static let boxFrameDefault: CGFloat = 0.7

    /// 4% of the frame. Small enough to crop one face out of a group photo, large
    /// enough that the eight drag handles do not sit on top of each other.
    static let minCropSpan: CGFloat = 0.04

    /// Longest edge an exported edit is fitted inside. Above HD's 3024 so
    /// `MediaTranscoder.image`'s tier pass still has room to work.
    static let exportMaxEdge: CGFloat = 4096
}

/// Aspect presets for the crop bar. `ratio` is width / height of the VISIBLE frame,
/// so a portrait photo cropped 16:9 still comes out landscape.
enum AspectPreset: String, CaseIterable, Identifiable {
    case free, square, landscape43, portrait34, wide, tall

    var id: String { rawValue }

    var label: String {
        switch self {
        case .free: return "Free"
        case .square: return "1:1"
        case .landscape43: return "4:3"
        case .portrait34: return "3:4"
        case .wide: return "16:9"
        case .tall: return "9:16"
        }
    }

    var ratio: CGFloat? {
        switch self {
        case .free: return nil
        case .square: return 1
        case .landscape43: return 4.0 / 3.0
        case .portrait34: return 3.0 / 4.0
        case .wide: return 16.0 / 9.0
        case .tall: return 9.0 / 16.0
        }
    }
}

// MARK: - Colour

/// The pen palette, and the vertical strip.
///
/// White first, not emerald: the overwhelmingly common annotation is a ring or an
/// arrow on a screenshot, and the app's own emerald is the one colour guaranteed to
/// collide with RX HIVE chrome inside a screenshot of RX HIVE.
enum EditorInk {
    static let swatches: [String] = [
        "#FFFFFF", "#0A0A0A", "#EF4444", "#F59E0B", "#FBBF24",
        "#10B981", "#22D3EE", "#3B82F6", "#A855F7", "#F472B6",
    ]

    static let `default` = "#22D3EE"

    /// Fraction of the strip's travel given to greys before the hue ramp starts.
    ///
    /// The reference's strip is white → black → rainbow, and the grey band has to
    /// exist: white and black are the two most-used annotation colours and a
    /// pure-hue slider can reach neither.
    static let greyStop: CGFloat = 0.16

    /// Strip position (0 at the top, 1 at the bottom) → `#RRGGBB`.
    ///
    /// Returns a hex string rather than a `Color` so the value can go straight into
    /// the model and, unchanged, into the web's.
    static func ink(atPosition position: CGFloat) -> String {
        let t = min(max(position, 0), 1)
        if t <= greyStop {
            let level = Int((255 * (1 - t / greyStop)).rounded())
            return hex(r: level, g: level, b: level)
        }
        // 0…330 rather than 0…360: ending on magenta instead of wrapping back to
        // red means the bottom of the strip is not a duplicate of its own middle.
        let hue = ((t - greyStop) / (1 - greyStop)) * 330
        let (r, g, b) = hslToRGB(hue: hue, saturation: 0.85, lightness: 0.55)
        return hex(r: Int(r.rounded()), g: Int(g.rounded()), b: Int(b.rounded()))
    }

    /// The inverse, so the thumb parks correctly when a swatch is tapped.
    static func position(forInk hex: String) -> CGFloat {
        guard let (r, g, b) = rgb(fromHex: hex) else { return greyStop + 0.35 }
        if r == g && g == b {
            return min(max((1 - CGFloat(r) / 255) * greyStop, 0), greyStop)
        }
        let hue = self.hue(r: CGFloat(r), g: CGFloat(g), b: CGFloat(b))
        // A hue past the 330 end of the ramp is nearer red than magenta, so it parks
        // at the top of the ramp rather than off the end of the strip.
        let ramp = hue > 345 ? 0 : min(hue, 330) / 330
        return greyStop + ramp * (1 - greyStop)
    }

    /// Gradient stops for the strip, read from the same function that answers it.
    static func gradientStops() -> [Gradient.Stop] {
        var stops: [Gradient.Stop] = [
            .init(color: .white, location: 0),
            .init(color: .black, location: greyStop),
        ]
        for i in 0...6 {
            let t = greyStop + (CGFloat(i) / 6) * (1 - greyStop)
            stops.append(.init(color: color(ink(atPosition: t)), location: t))
        }
        return stops
    }

    static func color(_ hex: String) -> Color {
        guard let (r, g, b) = rgb(fromHex: hex) else { return .white }
        return Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
    }

    static func uiColor(_ hex: String) -> UIColor {
        guard let (r, g, b) = rgb(fromHex: hex) else { return .white }
        return UIColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    }

    // MARK: Conversions

    static func rgb(fromHex hex: String) -> (Int, Int, Int)? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = Int(s, radix: 16) else { return nil }
        return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)
    }

    private static func hex(r: Int, g: Int, b: Int) -> String {
        let clampByte = { (v: Int) in min(max(v, 0), 255) }
        return String(format: "#%02X%02X%02X", clampByte(r), clampByte(g), clampByte(b))
    }

    private static func hslToRGB(hue: CGFloat, saturation: CGFloat, lightness: CGFloat) -> (CGFloat, CGFloat, CGFloat) {
        let h = hue.truncatingRemainder(dividingBy: 360)
        let c = (1 - abs(2 * lightness - 1)) * saturation
        let x = c * (1 - abs(((h / 60).truncatingRemainder(dividingBy: 2)) - 1))
        let m = lightness - c / 2
        let (r, g, b): (CGFloat, CGFloat, CGFloat)
        switch h {
        case ..<60: (r, g, b) = (c, x, 0)
        case ..<120: (r, g, b) = (x, c, 0)
        case ..<180: (r, g, b) = (0, c, x)
        case ..<240: (r, g, b) = (0, x, c)
        case ..<300: (r, g, b) = (x, 0, c)
        default: (r, g, b) = (c, 0, x)
        }
        return ((r + m) * 255, (g + m) * 255, (b + m) * 255)
    }

    private static func hue(r: CGFloat, g: CGFloat, b: CGFloat) -> CGFloat {
        let maxV = max(r, g, b)
        let minV = min(r, g, b)
        guard maxV != minV else { return 0 }
        let d = maxV - minV
        var h: CGFloat
        if maxV == r { h = ((g - b) / d).truncatingRemainder(dividingBy: 6) }
        else if maxV == g { h = (b - r) / d + 2 }
        else { h = (r - g) / d + 4 }
        h *= 60
        return h < 0 ? h + 360 : h
    }
}

// MARK: - Geometry

/// The coordinate maths shared by the preview and the exporter.
///
/// Every function here is pure and has a direct counterpart in
/// `frontend/src/utils/mediaEdit.js`. The web side has property tests pinning two
/// invariants that matter as much here: the render transform agrees with the point
/// converters, and a text box counter-rotated by `-θ` comes out with a pure uniform
/// scale (upright, unmirrored) while staying anchored to its glued source point.
enum MediaEditGeometry {

    static let fullCrop = CGRect(x: 0, y: 0, width: 1, height: 1)

    static func normalized(_ rotation: Int) -> Int {
        let r = Int((Double(rotation) / 90).rounded()) * 90
        return ((r % 360) + 360) % 360
    }

    static func isQuarterTurned(_ edit: MediaEdit) -> Bool {
        let r = normalized(edit.rotation)
        return r == 90 || r == 270
    }

    static func crop(_ edit: MediaEdit) -> CGRect { edit.crop ?? fullCrop }

    /// The cropped region, in source pixels, before rotation.
    static func croppedPixelSize(_ source: CGSize, _ edit: MediaEdit) -> CGSize {
        let c = crop(edit)
        return CGSize(
            width: max(1, (c.width * source.width).rounded()),
            height: max(1, (c.height * source.height).rounded())
        )
    }

    /// Pixel size of the whole ROTATED frame, ignoring the crop.
    ///
    /// This is the box the crop stage displays: a crop UI has to show what is being
    /// cut away, so it renders the full picture and dims the outside.
    static func frameSize(_ source: CGSize, _ edit: MediaEdit) -> CGSize {
        isQuarterTurned(edit)
            ? CGSize(width: source.height, height: source.width)
            : source
    }

    /// Aspect ratio (w/h) of what the user is looking at, crop included.
    static func visibleAspect(_ source: CGSize, _ edit: MediaEdit) -> CGFloat {
        let cropped = croppedPixelSize(source, edit)
        return isQuarterTurned(edit)
            ? cropped.height / cropped.width
            : cropped.width / cropped.height
    }

    /// Output descriptor: the pixel size of the baked result and the scale that maps
    /// source pixels onto it. Never upscales — the same rule `MediaTranscoder.image`
    /// follows, and for the same reason: a 700px screenshot must not be sent as a
    /// soft 1600px one.
    struct Output {
        var size: CGSize
        var scale: CGFloat
        var unrotated: CGSize
    }

    static func output(_ source: CGSize, _ edit: MediaEdit, maxEdge: CGFloat) -> Output {
        let cropped = croppedPixelSize(source, edit)
        let scale = min(1, maxEdge / max(cropped.width, cropped.height))
        let w = max(1, (cropped.width * scale).rounded())
        let h = max(1, (cropped.height * scale).rounded())
        let unrotated = CGSize(width: w, height: h)
        return Output(
            size: isQuarterTurned(edit) ? CGSize(width: h, height: w) : unrotated,
            scale: scale,
            unrotated: unrotated
        )
    }

    /// The descriptor for painting into a box of DISPLAY points.
    ///
    /// `output(_:_:maxEdge:)` derives its scale from a maximum edge, which is the
    /// right question for an export and the wrong one here: the preview has to land
    /// on exactly the box the layout gave it. `max` of the two axis scales rather
    /// than `min`, because the box is fitted to the frame's aspect and the two differ
    /// only by a rounding remainder — erring large costs a fraction of a point of
    /// overscan, erring small leaves a transparent hairline down one edge.
    static func displayOutput(_ source: CGSize, _ edit: MediaEdit, box: CGSize) -> Output {
        let quarter = isQuarterTurned(edit)
        let unrotated = quarter ? CGSize(width: box.height, height: box.width) : box
        let cropped = croppedPixelSize(source, edit)
        let scale = max(unrotated.width / cropped.width, unrotated.height / cropped.height)
        return Output(size: box, scale: scale, unrotated: unrotated)
    }

    // MARK: Point conversions

    /// Visible-frame coordinates (0…1 of the frame) → normalised SOURCE.
    ///
    /// Undoes rotate, then flip, then crop — the pipeline backwards.
    static func framePointToSource(_ point: CGPoint, _ edit: MediaEdit) -> CGPoint {
        let c = crop(edit)
        let r = normalized(edit.rotation)
        var ux: CGFloat
        var uy: CGFloat
        switch r {
        case 90: ux = point.y; uy = 1 - point.x
        case 180: ux = 1 - point.x; uy = 1 - point.y
        case 270: ux = 1 - point.y; uy = point.x
        default: ux = point.x; uy = point.y
        }
        if edit.flipH { ux = 1 - ux }
        if edit.flipV { uy = 1 - uy }
        return CGPoint(x: c.minX + ux * c.width, y: c.minY + uy * c.height)
    }

    /// The forward direction: normalised SOURCE → visible-frame 0…1.
    static func sourcePointToFrame(_ point: CGPoint, _ edit: MediaEdit) -> CGPoint {
        let c = crop(edit)
        let r = normalized(edit.rotation)
        var ux = c.width == 0 ? 0 : (point.x - c.minX) / c.width
        var uy = c.height == 0 ? 0 : (point.y - c.minY) / c.height
        if edit.flipH { ux = 1 - ux }
        if edit.flipV { uy = 1 - uy }
        switch r {
        case 90: return CGPoint(x: 1 - uy, y: ux)
        case 180: return CGPoint(x: 1 - ux, y: 1 - uy)
        case 270: return CGPoint(x: uy, y: 1 - ux)
        default: return CGPoint(x: ux, y: uy)
        }
    }

    // MARK: Rect conversions

    /// A source-space rect, expressed in the displayed FULL frame's 0…1 coordinates.
    ///
    /// Built from the point converters rather than from its own rotation table: a
    /// 90°-multiple rotation maps an axis-aligned rectangle to an axis-aligned
    /// rectangle, so transforming two opposite corners and re-normalising is exact —
    /// and cannot drift out of step with where a stroke lands, which a second copy
    /// of the rotation cases eventually would.
    ///
    /// The crop is forced to nil because the FULL frame is the reference here.
    static func rectSourceToFrame(_ rect: CGRect, _ edit: MediaEdit) -> CGRect {
        var uncropped = edit
        uncropped.crop = nil
        let a = sourcePointToFrame(CGPoint(x: rect.minX, y: rect.minY), uncropped)
        let b = sourcePointToFrame(CGPoint(x: rect.maxX, y: rect.maxY), uncropped)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    /// The inverse.
    static func rectFrameToSource(_ rect: CGRect, _ edit: MediaEdit) -> CGRect {
        var uncropped = edit
        uncropped.crop = nil
        let a = framePointToSource(CGPoint(x: rect.minX, y: rect.minY), uncropped)
        let b = framePointToSource(CGPoint(x: rect.maxX, y: rect.maxY), uncropped)
        return CGRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(b.x - a.x), height: abs(b.y - a.y))
    }

    /// Keep a source-space crop rect legal: inside the frame, and not vanishingly small.
    static func clampCrop(_ rect: CGRect) -> CGRect {
        let w = min(max(rect.width, MediaEditLimits.minCropSpan), 1)
        let h = min(max(rect.height, MediaEditLimits.minCropSpan), 1)
        return CGRect(
            x: min(max(rect.minX, 0), 1 - w),
            y: min(max(rect.minY, 0), 1 - h),
            width: w, height: h
        )
    }

    /// Clamp a rect the user is dragging, in FRAME space, honouring a locked ratio.
    ///
    /// The ratio is applied here rather than in source space because here it is what
    /// it says it is: the displayed rect's pixel width over its pixel height. In
    /// source space the same constraint has to be inverted for a quarter-turned
    /// image, which is exactly the sign error that ships as "16:9 gave me 9:16".
    ///
    /// `anchor` is the corner or edge being dragged, so the rect grows away from the
    /// point the finger is not holding. Without it a ratio correction on a top-left
    /// drag visibly pulls the bottom-right corner around.
    static func clampFrameRect(
        _ rect: CGRect,
        frame: CGSize,
        ratio: CGFloat?,
        anchor: CropAnchor?
    ) -> CGRect {
        var w = min(max(rect.width, MediaEditLimits.minCropSpan), 1)
        var h = min(max(rect.height, MediaEditLimits.minCropSpan), 1)
        var x = rect.minX
        var y = rect.minY

        if let ratio {
            // Normalised units are not square, so the constraint is applied in pixels.
            if (w * frame.width) / (h * frame.height) > ratio {
                w = (h * frame.height * ratio) / frame.width
            } else {
                h = (w * frame.width) / ratio / frame.height
            }
            // Ratio-correcting only ever shrinks, so it can push the rect under the
            // minimum. Grow both axes back together, up to whatever the frame allows.
            let grow = min(
                max(MediaEditLimits.minCropSpan / w, MediaEditLimits.minCropSpan / h, 1),
                1 / w, 1 / h
            )
            w *= grow
            h *= grow

            // Re-anchor: whichever edges the drag was NOT holding are the ones that move.
            if let anchor {
                if anchor.holdsWest { x = (rect.maxX) - w }
                else if anchor.holdsEast { x = rect.minX }
                else { x = rect.minX + (rect.width - w) / 2 }

                if anchor.holdsNorth { y = (rect.maxY) - h }
                else if anchor.holdsSouth { y = rect.minY }
                else { y = rect.minY + (rect.height - h) / 2 }
            }
        }

        return CGRect(
            x: min(max(x, 0), max(0, 1 - w)),
            y: min(max(y, 0), max(0, 1 - h)),
            width: w, height: h
        )
    }

    /// The largest frame rect of the given ratio that fits, centred.
    static func centeredFrameRect(frame: CGSize, ratio: CGFloat?) -> CGRect {
        guard let ratio else { return fullCrop }
        let frameRatio = frame.width / frame.height
        var w: CGFloat = 1
        var h: CGFloat = 1
        if frameRatio > ratio { w = ratio / frameRatio } else { h = frameRatio / ratio }
        return CGRect(x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h)
    }

    // MARK: Frame-relative sizes

    /// A pen chosen against what is on screen, converted to the stored width.
    ///
    /// The stored value is a fraction of the SOURCE short edge, but the user picked a
    /// thickness relative to the frame in front of them. Without this conversion a
    /// Bold pen would come out hairline-thin on a tightly cropped region of a 12MP
    /// photo, because the same fraction of the whole sensor is a much bigger number
    /// of pixels than the crop is wide.
    static func penWidth(fraction: CGFloat, source: CGSize, edit: MediaEdit) -> CGFloat {
        let cropped = croppedPixelSize(source, edit)
        let frameShort = min(cropped.width, cropped.height)
        let sourceShort = max(1, min(source.width, source.height))
        return (fraction * frameShort) / sourceShort
    }

    /// The same conversion for type, which is sized against the frame's height.
    static func fontSize(fraction: CGFloat, source: CGSize, edit: MediaEdit) -> CGFloat {
        let cropped = croppedPixelSize(source, edit)
        let frameHeight = isQuarterTurned(edit) ? cropped.width : cropped.height
        return (fraction * frameHeight) / max(1, source.height)
    }

    /// …and for a wrap width, sized against the frame's width.
    static func boxWidth(fraction: CGFloat, source: CGSize, edit: MediaEdit) -> CGFloat {
        let cropped = croppedPixelSize(source, edit)
        let frameWidth = isQuarterTurned(edit) ? cropped.height : cropped.width
        return (fraction * frameWidth) / max(1, source.width)
    }

    /// The two inverses, so the size sliders can be labelled in terms of the frame.
    static func frameFontFraction(_ fontSize: CGFloat, source: CGSize, edit: MediaEdit) -> CGFloat {
        let cropped = croppedPixelSize(source, edit)
        let frameHeight = max(1, isQuarterTurned(edit) ? cropped.width : cropped.height)
        return (fontSize * source.height) / frameHeight
    }

    static func frameBoxFraction(_ boxWidth: CGFloat, source: CGSize, edit: MediaEdit) -> CGFloat {
        let cropped = croppedPixelSize(source, edit)
        let frameWidth = max(1, isQuarterTurned(edit) ? cropped.height : cropped.width)
        return (boxWidth * source.width) / frameWidth
    }

    // MARK: The render transform

    /// Put a context into SOURCE-PIXEL space, with the pipeline already applied.
    ///
    /// After this returns, drawing at source-pixel coordinates lands in the right
    /// place and everything outside the crop is off-canvas and clipped. That is the
    /// whole trick: image, strokes and text all go through one transform, so they
    /// cannot drift apart, and the preview and the export share the code that
    /// computes it.
    ///
    /// `UIGraphicsImageRenderer` hands over a UIKit-oriented context (origin
    /// top-left, y increasing downwards) which is the same convention the web's
    /// canvas uses, so this is a direct transcription of `applyEditTransform` —
    /// including the direction a positive rotation turns.
    static func apply(to cg: CGContext, source: CGSize, edit: MediaEdit, output: Output) {
        let c = crop(edit)
        let radians = CGFloat(normalized(edit.rotation)) * .pi / 180
        cg.translateBy(x: output.size.width / 2, y: output.size.height / 2)
        cg.rotate(by: radians)
        cg.scaleBy(x: edit.flipH ? -1 : 1, y: edit.flipV ? -1 : 1)
        cg.translateBy(x: -output.unrotated.width / 2, y: -output.unrotated.height / 2)
        cg.scaleBy(x: output.scale, y: output.scale)
        cg.translateBy(x: -c.minX * source.width, y: -c.minY * source.height)
    }
}

/// Which handle of the crop rectangle a drag is holding.
enum CropAnchor: String, CaseIterable, Identifiable {
    case nw, n, ne, e, se, s, sw, w

    var id: String { rawValue }

    var holdsNorth: Bool { self == .nw || self == .n || self == .ne }
    var holdsSouth: Bool { self == .sw || self == .s || self == .se }
    var holdsWest: Bool { self == .nw || self == .w || self == .sw }
    var holdsEast: Bool { self == .ne || self == .e || self == .se }

    var label: String { "Resize crop \(rawValue)" }

    /// Unit position inside the crop rect, for placing the handle.
    var unitPoint: UnitPoint {
        switch self {
        case .nw: return .topLeading
        case .n: return .top
        case .ne: return .topTrailing
        case .e: return .trailing
        case .se: return .bottomTrailing
        case .s: return .bottom
        case .sw: return .bottomLeading
        case .w: return .leading
        }
    }
}
