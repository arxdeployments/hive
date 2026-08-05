import UIKit
import XCTest
@testable import RxHive

/// The pre-send editor's coordinate maths.
///
/// The invariant worth a test is the one that cannot be eyeballed: the transform used to
/// RENDER has to agree, exactly, with the point converters used to place a stroke and to
/// hit-test a text box. If they drift, a stroke lands somewhere other than where the
/// finger was, and it drifts silently — the preview and the export would still match each
/// other, so nothing looks broken until someone compares the picture with the gesture
/// that drew on it.
///
/// The web client has the same properties pinned in the same way; the two models are
/// deliberately identical (see `MediaEdit`).
final class MediaEditGeometryTests: XCTestCase {

    // Sub-pixel. `output` rounds the canvas to whole pixels while `scale` stays exact, so
    // a corner can land up to half a pixel from its ideal position. That is invisible and
    // deliberate; anything larger is a real disagreement.
    private let tolerance: CGFloat = 0.6

    private let rotations = [0, 90, 180, 270]
    private let flips: [(Bool, Bool)] = [(false, false), (true, false), (false, true), (true, true)]
    private let crops: [CGRect?] = [
        nil,
        CGRect(x: 0, y: 0, width: 1, height: 1),
        CGRect(x: 0.1, y: 0.2, width: 0.5, height: 0.6),
        CGRect(x: 0.33, y: 0.05, width: 0.4, height: 0.9),
        CGRect(x: 0.5, y: 0.5, width: 0.5, height: 0.5),
    ]
    private let sizes = [
        CGSize(width: 1000, height: 1000),
        CGSize(width: 4032, height: 3024),
        CGSize(width: 750, height: 1334),
        CGSize(width: 1920, height: 1080),
    ]
    private let points = [
        CGPoint(x: 0, y: 0), CGPoint(x: 1, y: 1), CGPoint(x: 0.5, y: 0.5),
        CGPoint(x: 0.13, y: 0.77), CGPoint(x: 0.9, y: 0.02),
    ]

    private func edit(_ crop: CGRect?, _ rotation: Int, _ flip: (Bool, Bool)) -> MediaEdit {
        var value = MediaEdit()
        value.crop = crop
        value.rotation = rotation
        value.flipH = flip.0
        value.flipV = flip.1
        return value
    }

    /// The transform `MediaEditGeometry.apply(to:)` installs, expressed in the renderer's
    /// own UIKit space.
    ///
    /// `UIGraphicsImageRenderer` hands over a context whose CTM already flips y for UIKit
    /// coordinates, so the raw CTM afterwards maps source pixels all the way to device
    /// pixels. Dividing the base back out leaves only what `apply` contributed, which is
    /// the thing under test.
    private func editTransform(source: CGSize, edit: MediaEdit, output: MediaEditGeometry.Output) -> CGAffineTransform {
        var result = CGAffineTransform.identity
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4), format: format).image { context in
            let cg = context.cgContext
            let base = cg.ctm
            MediaEditGeometry.apply(to: cg, source: source, edit: edit, output: output)
            result = cg.ctm.concatenating(base.inverted())
        }
        return result
    }

    // MARK: The converters are inverses of each other

    func test_pointConverters_roundTripForEveryRotationAndFlip() {
        for rotation in rotations {
            for flip in flips {
                for crop in crops {
                    let value = edit(crop, rotation, flip)
                    for point in points {
                        let back = MediaEditGeometry.sourcePointToFrame(
                            MediaEditGeometry.framePointToSource(point, value), value
                        )
                        XCTAssertEqual(
                            back.x, point.x, accuracy: 1e-9,
                            "frame→source→frame must be the identity, else a stroke moves the instant it is committed (r\(rotation) h\(flip.0) v\(flip.1))"
                        )
                        XCTAssertEqual(back.y, point.y, accuracy: 1e-9, "same, on y")
                    }
                }
            }
        }
    }

    func test_rectConverters_roundTripForEveryRotationAndFlip() {
        for rotation in rotations {
            for flip in flips {
                let value = edit(nil, rotation, flip)
                for rect in crops.compactMap({ $0 }) {
                    let back = MediaEditGeometry.rectSourceToFrame(
                        MediaEditGeometry.rectFrameToSource(rect, value), value
                    )
                    XCTAssertEqual(back.minX, rect.minX, accuracy: 1e-9, "a dragged crop rect must survive the trip into source space and back, or the handle stops tracking the finger")
                    XCTAssertEqual(back.minY, rect.minY, accuracy: 1e-9, "same, on y")
                    XCTAssertEqual(back.width, rect.width, accuracy: 1e-9, "same, on width")
                    XCTAssertEqual(back.height, rect.height, accuracy: 1e-9, "same, on height")
                }
            }
        }
    }

    // MARK: The render transform agrees with the converters

    func test_renderTransform_landsWhereThePointConverterSays() {
        for source in sizes {
            for rotation in rotations {
                for flip in flips {
                    for crop in crops {
                        let value = edit(crop, rotation, flip)
                        let output = MediaEditGeometry.output(source, value, maxEdge: 1600)
                        let transform = editTransform(source: source, edit: value, output: output)
                        for point in points {
                            let sourcePoint = MediaEditGeometry.framePointToSource(point, value)
                            let drawn = CGPoint(
                                x: sourcePoint.x * source.width,
                                y: sourcePoint.y * source.height
                            ).applying(transform)
                            XCTAssertEqual(
                                drawn.x, point.x * output.size.width, accuracy: tolerance,
                                "the transform used to draw must put a source pixel exactly where sourcePointToFrame says it goes, or strokes land off the finger (\(Int(source.width))x\(Int(source.height)) r\(rotation) h\(flip.0) v\(flip.1))"
                            )
                            XCTAssertEqual(drawn.y, point.y * output.size.height, accuracy: tolerance, "same, on y")
                        }
                    }
                }
            }
        }
    }

    // MARK: Text comes out upright, unmirrored, and still glued

    func test_textCounterRotation_leavesOnlyAUniformScale() {
        let anchor = CGPoint(x: 0.4, y: 0.6)
        for source in sizes {
            for rotation in rotations {
                for flip in flips {
                    let value = edit(CGRect(x: 0.1, y: 0.1, width: 0.7, height: 0.8), rotation, flip)
                    let output = MediaEditGeometry.output(source, value, maxEdge: 1600)

                    var linear = CGAffineTransform.identity
                    var centre = CGPoint.zero
                    let format = UIGraphicsImageRendererFormat.default()
                    format.scale = 1
                    UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4), format: format).image { context in
                        let cg = context.cgContext
                        let base = cg.ctm
                        MediaEditGeometry.apply(to: cg, source: source, edit: value, output: output)
                        // Exactly what `MediaEditRenderer.drawTexts` does per box.
                        cg.translateBy(x: anchor.x * source.width, y: anchor.y * source.height)
                        cg.scaleBy(x: value.flipH ? -1 : 1, y: value.flipV ? -1 : 1)
                        cg.rotate(by: -CGFloat(MediaEditGeometry.normalized(rotation)) * .pi / 180)
                        linear = cg.ctm.concatenating(base.inverted())
                        centre = CGPoint.zero.applying(linear)
                    }

                    XCTAssertEqual(linear.a, output.scale, accuracy: 1e-9, "after undoing the rotation and the mirroring, type must be left on a pure uniform scale — otherwise a caption comes out sideways or mirrored (r\(rotation) h\(flip.0) v\(flip.1))")
                    XCTAssertEqual(linear.d, output.scale, accuracy: 1e-9, "same, on the y scale")
                    XCTAssertEqual(linear.b, 0, accuracy: 1e-9, "no shear or rotation may survive, or the glyphs tilt")
                    XCTAssertEqual(linear.c, 0, accuracy: 1e-9, "no shear or rotation may survive, or the glyphs tilt")

                    let expected = MediaEditGeometry.sourcePointToFrame(anchor, value)
                    XCTAssertEqual(centre.x, expected.x * output.size.width, accuracy: tolerance, "the box must stay anchored to the pixel it was placed on, even though its glyphs are turned back upright")
                    XCTAssertEqual(centre.y, expected.y * output.size.height, accuracy: tolerance, "same, on y")
                }
            }
        }
    }

    // MARK: Output sizing

    func test_output_swapsOnAQuarterTurnAndNeverUpscales() {
        for source in sizes {
            for rotation in rotations {
                let value = edit(nil, rotation, (false, false))
                let full = MediaEditGeometry.output(source, value, maxEdge: .greatestFiniteMagnitude)
                let quarter = MediaEditGeometry.isQuarterTurned(value)
                XCTAssertEqual(full.size.width, quarter ? source.height : source.width, "a quarter turn swaps the output's axes; anything else means the canvas and the picture disagree about their own shape")
                XCTAssertEqual(full.size.height, quarter ? source.width : source.height, "same, on height")
                XCTAssertEqual(full.scale, 1, "an image smaller than the ceiling must be left alone — upscaling would send a soft copy of a sharp screenshot")

                let capped = MediaEditGeometry.output(source, value, maxEdge: 100)
                XCTAssertLessThanOrEqual(max(capped.size.width, capped.size.height), 100, "the long edge must actually be fitted inside the ceiling it was given")
            }
        }
    }

    // MARK: Locked aspect ratios

    func test_aspectPresets_areHonouredInFramePixelsAtEveryRotation() {
        let ratios: [CGFloat] = [1, 4.0 / 3.0, 3.0 / 4.0, 16.0 / 9.0, 9.0 / 16.0]
        for source in sizes {
            for rotation in rotations {
                let value = edit(nil, rotation, (false, false))
                let frame = MediaEditGeometry.frameSize(source, value)
                for ratio in ratios {
                    let centred = MediaEditGeometry.centeredFrameRect(frame: frame, ratio: ratio)
                    XCTAssertEqual(
                        (centred.width * frame.width) / (centred.height * frame.height), ratio, accuracy: 1e-6,
                        "a preset has to mean the ratio of what is ON SCREEN — applying it in source space instead is what turns 16:9 into 9:16 on a rotated photo (r\(rotation))"
                    )
                    XCTAssertTrue(
                        centred.minX >= -1e-9 && centred.minY >= -1e-9
                            && centred.maxX <= 1 + 1e-9 && centred.maxY <= 1 + 1e-9,
                        "a centred preset rect must fit inside the frame it was fitted to"
                    )

                    for anchor in CropAnchor.allCases {
                        let dragged = MediaEditGeometry.clampFrameRect(
                            CGRect(x: 0.2, y: 0.15, width: 0.9, height: 0.35),
                            frame: frame, ratio: ratio, anchor: anchor
                        )
                        XCTAssertEqual(
                            (dragged.width * frame.width) / (dragged.height * frame.height), ratio, accuracy: 1e-6,
                            "a drag must not be able to break the ratio the user locked (anchor \(anchor.rawValue))"
                        )
                        XCTAssertTrue(
                            dragged.minX >= -1e-9 && dragged.minY >= -1e-9
                                && dragged.maxX <= 1 + 1e-9 && dragged.maxY <= 1 + 1e-9,
                            "a ratio correction must never push the crop outside the picture (anchor \(anchor.rawValue))"
                        )
                        XCTAssertGreaterThanOrEqual(
                            min(dragged.width, dragged.height), MediaEditLimits.minCropSpan - 1e-9,
                            "the rect must not be allowed to collapse under the minimum, or the eight handles pile up on each other"
                        )
                    }
                }
            }
        }
    }

    // MARK: The frame-relative size helpers

    func test_frameRelativeSizes_areExactInverses() {
        for source in sizes {
            for rotation in rotations {
                for crop in crops {
                    let value = edit(crop, rotation, (false, false))
                    for fraction: CGFloat in [0.03, 0.075, 0.3, 0.7, 1] {
                        let storedFont = MediaEditGeometry.fontSize(fraction: fraction, source: source, edit: value)
                        XCTAssertEqual(
                            MediaEditGeometry.frameFontFraction(storedFont, source: source, edit: value),
                            fraction, accuracy: 1e-9,
                            "the Text size slider reads its value back through the inverse, so a drift here makes the thumb jump away from the finger"
                        )
                        let storedBox = MediaEditGeometry.boxWidth(fraction: fraction, source: source, edit: value)
                        XCTAssertEqual(
                            MediaEditGeometry.frameBoxFraction(storedBox, source: source, edit: value),
                            fraction, accuracy: 1e-9,
                            "same, for Box width"
                        )
                    }

                    // A pen is the same visual thickness whatever the crop, which is the
                    // whole reason the width is converted rather than stored raw.
                    let width = MediaEditGeometry.penWidth(fraction: 0.024, source: source, edit: value)
                    let cropped = MediaEditGeometry.croppedPixelSize(source, value)
                    let drawnPixels = width * min(source.width, source.height)
                    XCTAssertEqual(
                        drawnPixels / min(cropped.width, cropped.height), 0.024, accuracy: 1e-3,
                        "a Bold pen must look Bold on a tight crop of a 12MP photo, not hairline-thin"
                    )
                }
            }
        }
    }

    // MARK: hasEdits gates the Revert button and the "Edited" chip

    func test_hasEdits_isFalseForAPristineModelAndTrueForEachKindOfEdit() {
        XCTAssertFalse(MediaEdit().hasEdits, "a pristine model must not report edits, or every picked photo is badged as edited and Revert appears with nothing to undo")

        var fullCrop = MediaEdit()
        fullCrop.crop = MediaEditGeometry.fullCrop
        XCTAssertFalse(fullCrop.hasEdits, "an explicit whole-frame crop is not a crop — Reset assigns exactly this and must clear the badge")

        var cropped = MediaEdit()
        cropped.crop = CGRect(x: 0.1, y: 0, width: 0.8, height: 1)
        XCTAssertTrue(cropped.hasEdits, "a real crop counts")

        var turned = MediaEdit()
        turned.rotation = 90
        XCTAssertTrue(turned.hasEdits, "a rotation counts")

        var mirrored = MediaEdit()
        mirrored.flipV = true
        XCTAssertTrue(mirrored.hasEdits, "a flip counts")

        var drawn = MediaEdit()
        drawn.strokes = [EditStroke(colorHex: "#FFFFFF", width: 0.01, points: [CGPoint(x: 0.5, y: 0.5)])]
        XCTAssertTrue(drawn.hasEdits, "a stroke counts")

        var captioned = MediaEdit()
        captioned.texts = [EditText()]
        XCTAssertTrue(captioned.hasEdits, "a text box counts")
    }

    // MARK: The colour strip

    func test_colourStrip_roundTripsEverySwatchAndReachesBlackAndWhite() {
        XCTAssertEqual(EditorInk.ink(atPosition: 0), "#FFFFFF", "the top of the strip has to be pure white — it is the most-used annotation colour and a hue ramp cannot reach it")
        XCTAssertEqual(EditorInk.ink(atPosition: EditorInk.greyStop), "#000000", "the end of the grey band has to be pure black, for the same reason")

        for hex in EditorInk.swatches {
            let position = EditorInk.position(forInk: hex)
            XCTAssertTrue(position >= 0 && position <= 1, "tapping a swatch parks the strip's thumb, so every swatch must map to a real position on it (\(hex))")
        }

        for step in 0...20 {
            let t = CGFloat(step) / 20
            let hex = EditorInk.ink(atPosition: t)
            XCTAssertEqual(EditorInk.position(forInk: hex), t, accuracy: 0.02, "dragging the strip and reading the thumb back must not fight each other")
        }
    }
}
