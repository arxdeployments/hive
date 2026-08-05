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

    // MARK: Dragging a crop handle off the edge of the picture

    /// One drag update of a resize gesture, exactly as `CropStageView` assembles it: apply
    /// the translation to whichever edges the anchor holds, fold, clamp.
    ///
    /// The four delta lines mirror `CropStageView.dragGesture`. Everything the bugs below
    /// live in — the fold, the anchor it produces, and the clamp that consumes both — is
    /// the real shared code. The web client pins the same cases the same way in
    /// `frontend/tests/media-edit-crop.spec.js`, with the same numbers.
    private func drag(
        from start: CGRect,
        _ anchor: CropAnchor,
        dx: CGFloat = 0,
        dy: CGFloat = 0,
        ratio: CGFloat? = nil,
        frame: CGSize = CGSize(width: 400, height: 300)
    ) -> CGRect {
        var next = start
        if anchor.holdsWest { next.origin.x = start.minX + dx; next.size.width = start.width - dx }
        if anchor.holdsEast { next.size.width = start.width + dx }
        if anchor.holdsNorth { next.origin.y = start.minY + dy; next.size.height = start.height - dy }
        if anchor.holdsSouth { next.size.height = start.height + dy }
        let folded = MediaEditGeometry.foldDragRect(next, anchor: anchor)
        return MediaEditGeometry.clampFrameRect(
            folded.rect, frame: frame, ratio: ratio, anchor: folded.anchor
        )
    }

    func test_overshoot_stopsTheDraggedEdgeAndLeavesTheOppositeOneWhereItWas() {
        // The rect is fitted into the frame by capping the SPAN, not by sliding the origin.
        // Without that, an ordinary overshoot past the edge of the picture drags the edge
        // the finger is not holding along with it, and a big enough one selects the whole
        // image.
        let box = CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3)

        // Far enough that the east edge really does leave the picture (0.2 + 0.3 + 0.7).
        let east = drag(from: box, .e, dx: 0.7)
        XCTAssertEqual(east.minX, 0.2, accuracy: 1e-9, "pulling the east handle past the right edge of the picture must not drag the left edge inward — that is the whole crop sliding instead of one edge stopping, and it used to saturate at x=0,w=1 and select the whole image")
        XCTAssertEqual(east.maxX, 1, accuracy: 1e-9, "the dragged edge stops at the picture's edge")

        let west = drag(from: box, .w, dx: -0.4)
        XCTAssertEqual(west.maxX, 0.5, accuracy: 1e-9, "same on the way out to the left: the fixed right edge stays put")
        XCTAssertEqual(west.minX, 0, accuracy: 1e-9, "the dragged edge stops at 0")

        let south = drag(from: box, .s, dy: 0.7)
        XCTAssertEqual(south.minY, 0.2, accuracy: 1e-9, "and in the other axis, which had the identical bug")
        XCTAssertEqual(south.maxY, 1, accuracy: 1e-9, "the dragged edge stops at the bottom")

        let north = drag(from: box, .n, dy: -0.4)
        XCTAssertEqual(north.maxY, 0.5, accuracy: 1e-9, "the fixed bottom edge stays put")
        XCTAssertEqual(north.minY, 0, accuracy: 1e-9, "the dragged edge stops at 0")
    }

    func test_foldDragRect_swapsOnlyTheAxisThatFolded() {
        let unfolded = MediaEditGeometry.foldDragRect(
            CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3), anchor: .ne
        )
        XCTAssertEqual(unfolded.anchor, .ne, "a drag that did not cross over must keep its anchor, or ordinary drags start holding the wrong edge")
        XCTAssertEqual(unfolded.rect, CGRect(x: 0.2, y: 0.2, width: 0.3, height: 0.3))

        let horizontal = MediaEditGeometry.foldDragRect(
            CGRect(x: 0.2, y: 0.2, width: -0.5, height: 0.3), anchor: .ne
        )
        XCTAssertEqual(horizontal.anchor, .nw, "a horizontal fold swaps east for west and leaves the north half alone")
        XCTAssertEqual(horizontal.rect.minX, -0.3, accuracy: 1e-9, "the fold puts the origin on the minimum corner")
        XCTAssertEqual(horizontal.rect.width, 0.5, accuracy: 1e-9, "and makes the span positive")
        XCTAssertEqual(horizontal.rect.minY, 0.2, accuracy: 1e-9, "the untouched axis is untouched")
        XCTAssertEqual(horizontal.rect.height, 0.3, accuracy: 1e-9, "same, on height")

        XCTAssertEqual(
            MediaEditGeometry.foldDragRect(CGRect(x: 0.2, y: 0.2, width: 0.3, height: -0.5), anchor: .ne).anchor,
            .se, "a vertical fold swaps north for south and leaves the east half alone"
        )
        XCTAssertEqual(
            MediaEditGeometry.foldDragRect(CGRect(x: 0.2, y: 0.2, width: -0.3, height: -0.5), anchor: .ne).anchor,
            .sw, "both axes folding is both swaps"
        )
        XCTAssertEqual(
            MediaEditGeometry.foldDragRect(CGRect(x: 0.2, y: 0.2, width: -0.3, height: -0.5), anchor: .sw).anchor,
            .ne, "and it is its own inverse"
        )

        for (anchor, expected): (CropAnchor, CropAnchor) in [(.e, .w), (.w, .e)] {
            XCTAssertEqual(
                MediaEditGeometry.foldDragRect(CGRect(x: 0.2, y: 0.2, width: -0.3, height: 0.3), anchor: anchor).anchor,
                expected, "single-edge handles fold too"
            )
        }
        for (anchor, expected): (CropAnchor, CropAnchor) in [(.n, .s), (.s, .n)] {
            XCTAssertEqual(
                MediaEditGeometry.foldDragRect(CGRect(x: 0.2, y: 0.2, width: 0.3, height: -0.3), anchor: anchor).anchor,
                expected, "same, vertically"
            )
        }
    }

    func test_foldedDrag_holdsTheEdgeTheFingerLeftBehind() {
        // A drag dragged back across its own opposite edge is folded, and folding swaps
        // which edge the finger is on: after an east drag folds, the MOVING edge is the
        // west one and the FIXED edge is maxX. Handed the pre-fold anchor, `clampFrameRect`
        // pins the edge that is moving and lets the one the user left behind slide — so
        // pulling the right handle left past the left edge and continuing keeps the crop's
        // left side put while its RIGHT side creeps outward.
        let small = CGRect(x: 0.2, y: 0.2, width: 0.1, height: 0.1)

        let east = drag(from: small, .e, dx: -0.5)
        XCTAssertEqual(east.maxX, 0.2, accuracy: 1e-9, "the fixed edge moved: handed the unfolded east anchor this returned x=0,w=0.4 and shoved the right edge out to 0.4")
        XCTAssertEqual(east.minX, 0, accuracy: 1e-9, "the folded edge stops at the picture's edge")
        XCTAssertEqual(east.minY, 0.2, accuracy: 1e-9, "a horizontal fold leaves the vertical axis alone")
        XCTAssertEqual(east.height, 0.1, accuracy: 1e-9, "same, on height")

        // Folding a west drag past the east edge and out of the picture.
        let west = drag(from: CGRect(x: 0.6, y: 0.2, width: 0.1, height: 0.1), .w, dx: 0.5)
        XCTAssertEqual(west.minX, 0.7, accuracy: 1e-9, "the fixed edge — the old right edge, now the left one — must not slide")
        XCTAssertEqual(west.maxX, 1, accuracy: 1e-9, "the folded edge stops at the picture's edge")

        let south = drag(from: small, .s, dy: -0.5)
        XCTAssertEqual(south.maxY, 0.2, accuracy: 1e-9, "and in the other axis")
        XCTAssertEqual(south.minY, 0, accuracy: 1e-9, "the folded edge stops at 0")

        let north = drag(from: CGRect(x: 0.2, y: 0.6, width: 0.1, height: 0.1), .n, dy: 0.5)
        XCTAssertEqual(north.minY, 0.7, accuracy: 1e-9, "the fixed bottom edge, now the top one")
        XCTAssertEqual(north.maxY, 1, accuracy: 1e-9, "the folded edge stops at the bottom")
    }

    func test_foldedCornerDrag_keepsTheAxisThatDidNotFoldAnchoredAsItWas() {
        // `.ne` holds the left edge (0.2) and the bottom edge (0.6). Only the horizontal
        // span crosses over, so the vertical anchoring has to survive untouched — which is
        // why the fold swaps one axis rather than reflecting the whole anchor.
        let corner = CGRect(x: 0.2, y: 0.4, width: 0.1, height: 0.2)

        let horizontal = drag(from: corner, .ne, dx: -0.5)
        XCTAssertEqual(horizontal.maxX, 0.2, accuracy: 1e-9, "the fixed left edge became the fixed right edge")
        XCTAssertEqual(horizontal.maxY, 0.6, accuracy: 1e-9, "the axis that did not fold must still hold the edge it always held")
        XCTAssertEqual(horizontal.height, 0.2, accuracy: 1e-9, "and must not be resized by the other axis folding")

        let both = drag(from: corner, .ne, dx: -0.5, dy: 0.5)
        XCTAssertEqual(both.maxX, 0.2, accuracy: 1e-9, "both fixed edges survive both folds")
        XCTAssertEqual(both.minY, 0.6, accuracy: 1e-9, "the fixed bottom edge became the fixed top edge")
    }

    func test_foldedDrag_underALockedRatio_reAnchorsToTheFoldedEdge() {
        // The ratio pass has its own re-anchor branch keyed off the same anchor, so it
        // needs the folded one too. Square frame and 1:1 keeps the expected rect obvious.
        let out = drag(
            from: CGRect(x: 0.4, y: 0.4, width: 0.1, height: 0.1), .e,
            dx: -0.5, ratio: 1, frame: CGSize(width: 400, height: 400)
        )

        XCTAssertEqual(out.maxX, 0.4, accuracy: 1e-9, "the ratio re-anchor used the pre-fold edge: with the unfolded anchor it pinned minX and the right edge collapsed to 0.1")
        XCTAssertEqual(out.width, out.height, accuracy: 1e-9, "and the lock still holds on a square frame")
    }

    func test_lockedRatio_survivesBeingFittedAgainstAFixedEdgeAtTheFrameBoundary() {
        // The fit is one uniform scale, so it is ratio-safe on its own; the minimum-span
        // floor used to be applied per axis AFTER it, so a fit that drove one axis under
        // `minCropSpan` lifted only that axis and the lock came out at the wrong shape. It
        // takes a fixed edge within a few percent of the frame's edge to trigger — which is
        // exactly what dragging a handle to the far side of the picture produces.
        //
        // Hand-checked case, so a failure is readable: bottom edge fixed at 0.05, north
        // handle hurled to the top of the frame, locked to 9:16 on a 4:3 frame. The fit
        // wants 0.0211 x 0.05 and the old per-axis floor lifted the width alone to 0.04,
        // giving a displayed ratio of 1.067 against the 0.5625 the user picked — nearly 2x
        // wrong, and baked straight into the export.
        let frame = CGSize(width: 400, height: 300)
        let out = drag(
            from: CGRect(x: 0.3, y: 0.01, width: 0.3, height: 0.04), .n,
            dy: -0.91, ratio: 9.0 / 16.0, frame: frame
        )
        XCTAssertEqual(
            (out.width * frame.width) / (out.height * frame.height), 9.0 / 16.0, accuracy: 1e-6,
            "the minimum-span floor broke the lock the user set, and nothing re-applies it before the export"
        )
        XCTAssertGreaterThanOrEqual(out.width, MediaEditLimits.minCropSpan - 1e-12, "and the minimum is still reachable here")
        XCTAssertGreaterThanOrEqual(out.height, MediaEditLimits.minCropSpan - 1e-12, "same, on height")

        // The same conflict from every direction, ratio and frame shape. Each gesture parks
        // the FIXED edge 5% from the frame's edge and throws the moving edge at the opposite
        // side, which is the only geometry that makes the fit this severe.
        let gestures: [(start: CGRect, anchor: CropAnchor, dx: CGFloat, dy: CGFloat)] = [
            (CGRect(x: 0.3, y: 0.01, width: 0.3, height: 0.04), .n, 0, -0.91),
            (CGRect(x: 0.3, y: 0.95, width: 0.3, height: 0.04), .s, 0, 0.91),
            (CGRect(x: 0.01, y: 0.3, width: 0.04, height: 0.3), .w, -0.91, 0),
            (CGRect(x: 0.95, y: 0.3, width: 0.04, height: 0.3), .e, 0.91, 0),
        ]
        let ratios: [CGFloat] = [1, 4.0 / 3.0, 3.0 / 4.0, 16.0 / 9.0, 9.0 / 16.0]
        let frames = [
            CGSize(width: 400, height: 300),
            CGSize(width: 300, height: 400),
            CGSize(width: 400, height: 400),
        ]

        for frame in frames {
            for ratio in ratios {
                for gesture in gestures {
                    let rect = drag(
                        from: gesture.start, gesture.anchor,
                        dx: gesture.dx, dy: gesture.dy, ratio: ratio, frame: frame
                    )
                    let where_ = "\(gesture.anchor.rawValue) @ \(ratio) on \(Int(frame.width))x\(Int(frame.height))"
                    XCTAssertEqual(
                        (rect.width * frame.width) / (rect.height * frame.height), ratio, accuracy: 1e-6,
                        "lock broken (\(where_))"
                    )
                    // Reachable for every preset: the most extreme displayed ratio here is a
                    // bit over 3:1, and the minimum only becomes unreachable past 25:1.
                    XCTAssertGreaterThanOrEqual(min(rect.width, rect.height), MediaEditLimits.minCropSpan - 1e-12, "under the minimum span (\(where_))")
                    // Still a legal crop, whatever the fit had to give up.
                    XCTAssertTrue(
                        rect.minX >= -1e-12 && rect.minY >= -1e-12
                            && rect.maxX <= 1 + 1e-12 && rect.maxY <= 1 + 1e-12,
                        "outside the frame (\(where_))"
                    )
                }
            }
        }
    }

    func test_foldedDrag_draggedAllTheWayThrough_staysLegal() {
        // Folded so far that the fixed edge is at the frame boundary: the span still cannot
        // collapse, and the rect still has to be inside the picture.
        let out = drag(from: CGRect(x: 0, y: 0, width: 0.2, height: 0.2), .se, dx: -0.9, dy: -0.9)

        XCTAssertGreaterThanOrEqual(out.width, MediaEditLimits.minCropSpan - 1e-9, "the rect must not be allowed to collapse under the minimum, or the eight handles pile up on each other")
        XCTAssertGreaterThanOrEqual(out.height, MediaEditLimits.minCropSpan - 1e-9, "same, on height")
        XCTAssertTrue(
            out.minX >= -1e-9 && out.minY >= -1e-9 && out.maxX <= 1 + 1e-9 && out.maxY <= 1 + 1e-9,
            "and it must stay inside the picture however far the finger went"
        )
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
