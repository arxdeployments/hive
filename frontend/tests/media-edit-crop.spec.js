import { expect, test } from '@playwright/test';
import { MIN_CROP_SPAN, clampFrameRect, foldDragRect } from '../src/utils/mediaEdit.js';

/**
 * Crop-drag geometry, run in Node against the real functions.
 *
 * `utils/mediaEdit.js` has no imports and touches no browser API at module scope, so
 * the rect maths can be exercised directly — no page, no editor, no login. That matters
 * for what is being tested here: the failure is a couple of decimal places in one
 * clamp, and a UI test that drags a handle across a picture cannot tell "the fixed edge
 * moved by 0.1" from "the fitted stage is a few pixels wider than I measured".
 *
 * The regression: a drag that crosses its own opposite edge is FOLDED (a negative span
 * would render inside-out), and folding swaps which edge the finger is on — after an
 * east drag folds, the moving edge is the west one and the fixed edge is `x + w`.
 * `clampFrameRect` pins whichever edge the anchor names, and it was still being handed
 * the pre-fold anchor, so it pinned the edge that was moving and let the one the user
 * had left behind slide. On screen: pull the right handle left past the left edge and
 * keep going, and the crop's left side stays put while its RIGHT side creeps outward —
 * the box grows on the side the finger is nowhere near.
 */

const FRAME = { width: 400, height: 300 };

/**
 * One pointermove of a resize drag, exactly as CropStage assembles it: apply the
 * pointer delta to whichever edges the anchor names, fold, clamp.
 *
 * The four delta lines mirror `CropStage.onPointerMove`. Everything the bug lives in —
 * the fold, the anchor it produces, and the clamp that consumes both — is the real
 * shared code.
 */
function drag(startRect, anchor, dx, dy, { ratio = null, frame = FRAME } = {}) {
  const next = { ...startRect };
  if (anchor.includes('w')) { next.x = startRect.x + dx; next.w = startRect.w - dx; }
  if (anchor.includes('e')) { next.w = startRect.w + dx; }
  if (anchor.includes('n')) { next.y = startRect.y + dy; next.h = startRect.h - dy; }
  if (anchor.includes('s')) { next.h = startRect.h + dy; }
  const folded = foldDragRect(next, anchor);
  return clampFrameRect(folded.rect, frame.width, frame.height, ratio, folded.anchor);
}

const right = (r) => r.x + r.w;
const bottom = (r) => r.y + r.h;

/** What a locked ratio actually means: displayed pixel width over displayed pixel height. */
const displayedRatio = (r, frame) => (r.w * frame.width) / (r.h * frame.height);

test.describe('foldDragRect', () => {
  test('swaps only the axis that folded, and leaves an unfolded drag alone', () => {
    // No fold: untouched, or the swap would fire on ordinary drags.
    expect(foldDragRect({ x: 0.2, y: 0.2, w: 0.3, h: 0.3 }, 'ne')).toEqual({
      rect: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 },
      anchor: 'ne',
    });

    // Horizontal fold: e→w, and the 'n' is left as it was.
    const h = foldDragRect({ x: 0.2, y: 0.2, w: -0.5, h: 0.3 }, 'ne');
    expect(h.anchor).toBe('nw');
    expect(h.rect.x).toBeCloseTo(-0.3, 10);
    expect(h.rect.w).toBeCloseTo(0.5, 10);
    expect(h.rect.y).toBeCloseTo(0.2, 10);
    expect(h.rect.h).toBeCloseTo(0.3, 10);

    // Vertical fold: n→s, and the 'e' is left as it was.
    expect(foldDragRect({ x: 0.2, y: 0.2, w: 0.3, h: -0.5 }, 'ne').anchor).toBe('se');

    // Both.
    expect(foldDragRect({ x: 0.2, y: 0.2, w: -0.3, h: -0.5 }, 'ne').anchor).toBe('sw');
    expect(foldDragRect({ x: 0.2, y: 0.2, w: -0.3, h: -0.5 }, 'sw').anchor).toBe('ne');

    // Single-edge anchors too.
    expect(foldDragRect({ x: 0.2, y: 0.2, w: -0.3, h: 0.3 }, 'e').anchor).toBe('w');
    expect(foldDragRect({ x: 0.2, y: 0.2, w: -0.3, h: 0.3 }, 'w').anchor).toBe('e');
    expect(foldDragRect({ x: 0.2, y: 0.2, w: 0.3, h: -0.3 }, 's').anchor).toBe('n');
    expect(foldDragRect({ x: 0.2, y: 0.2, w: 0.3, h: -0.3 }, 'n').anchor).toBe('s');
  });
});

test.describe('a folded crop drag holds the edge the finger left behind', () => {
  test('east drag folded past the west edge keeps the fixed edge at the start x', () => {
    // Left edge fixed at 0.2, and the drag folds well past it and out of the frame.
    const out = drag({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, 'e', -0.5, 0);

    // The fixed edge is now the RIGHT one, and it must still be 0.2. Handed the
    // unfolded 'e', this came back { x: 0, w: 0.4 } — right edge shoved out to 0.4.
    expect(right(out), 'the fixed edge moved').toBeCloseTo(0.2, 10);
    expect(out.x).toBeCloseTo(0, 10);
    // Vertical untouched by a horizontal fold.
    expect(out.y).toBeCloseTo(0.2, 10);
    expect(out.h).toBeCloseTo(0.1, 10);
  });

  test('west drag folded past the east edge keeps the fixed edge at the start right', () => {
    // Right edge fixed at 0.7; folding puts the moving edge past 1, so the clamp bites.
    const out = drag({ x: 0.6, y: 0.2, w: 0.1, h: 0.1 }, 'w', 0.5, 0);

    // The fixed edge is now the LEFT one, at the old right edge. Handed 'w', this came
    // back { x: 0.6, w: 0.4 }: the fixed edge slid inward to 0.6.
    expect(out.x, 'the fixed edge moved').toBeCloseTo(0.7, 10);
    // The moving edge stops at the frame boundary rather than dragging the fixed one.
    expect(right(out)).toBeCloseTo(1, 10);
  });

  test('south drag folded past the north edge keeps the fixed edge at the start y', () => {
    const out = drag({ x: 0.2, y: 0.2, w: 0.1, h: 0.1 }, 's', 0, -0.5);

    expect(bottom(out), 'the fixed edge moved').toBeCloseTo(0.2, 10);
    expect(out.y).toBeCloseTo(0, 10);
    expect(out.x).toBeCloseTo(0.2, 10);
    expect(out.w).toBeCloseTo(0.1, 10);
  });

  test('north drag folded past the south edge keeps the fixed edge at the start bottom', () => {
    const out = drag({ x: 0.2, y: 0.6, w: 0.1, h: 0.1 }, 'n', 0, 0.5);

    expect(out.y, 'the fixed edge moved').toBeCloseTo(0.7, 10);
    expect(bottom(out)).toBeCloseTo(1, 10);
  });

  test('a corner drag that folds one axis keeps the other axis anchored as it was', () => {
    // 'ne' holds the left edge (0.2) and the bottom edge (0.6). Only the horizontal
    // span folds, so the vertical anchoring must survive untouched.
    const out = drag({ x: 0.2, y: 0.4, w: 0.1, h: 0.2 }, 'ne', -0.5, 0);

    expect(right(out), 'the fixed left edge did not become the fixed right edge')
      .toBeCloseTo(0.2, 10);
    expect(bottom(out), 'the untouched axis moved').toBeCloseTo(0.6, 10);
    expect(out.h).toBeCloseTo(0.2, 10);
  });

  test('a corner drag that folds both axes keeps both fixed edges', () => {
    // Both spans cross over: the fixed left/bottom pair becomes the fixed right/top pair.
    const out = drag({ x: 0.2, y: 0.4, w: 0.1, h: 0.2 }, 'ne', -0.5, 0.5);

    expect(right(out)).toBeCloseTo(0.2, 10);
    expect(out.y).toBeCloseTo(0.6, 10);
  });

  test('a locked ratio re-anchors to the folded edge', () => {
    // The ratio pass has its own re-anchor branch, keyed off the same anchor, so it
    // needs the folded one too. Square frame and 1:1 so the expected rect is obvious.
    const out = drag(
      { x: 0.4, y: 0.4, w: 0.1, h: 0.1 },
      'e',
      -0.5,
      0,
      { ratio: 1, frame: { width: 400, height: 400 } }
    );

    // Fixed edge at 0.4 throughout. Handed 'e', the ratio branch re-anchored to
    // `rect.x` (0 after the fold) and the right edge collapsed to 0.1.
    expect(right(out), 'the ratio re-anchor used the pre-fold edge').toBeCloseTo(0.4, 10);
    expect(out.w).toBeCloseTo(out.h, 10);
  });

  test('an unfolded overshoot still holds the edge it always held', () => {
    // The guard against over-applying the swap, and the case the existing clamp comment
    // describes: pulling east from { x: 0.5, w: 0.3 } must stop the east edge at the
    // frame and leave the left edge alone — not slide it inward to 0.3.
    const out = drag({ x: 0.5, y: 0.2, w: 0.3, h: 0.1 }, 'e', 0.4, 0);

    expect(out.x).toBeCloseTo(0.5, 10);
    expect(right(out)).toBeCloseTo(1, 10);
  });

  test('a locked ratio survives being fitted against a fixed edge at the frame boundary', () => {
    // The fit is one uniform scale, so it is ratio-safe on its own; the minimum-span floor
    // used to be applied per axis AFTER it, so a fit that drove one axis under
    // MIN_CROP_SPAN lifted only that axis and the lock came out at the wrong shape. It
    // takes a fixed edge within a few percent of the frame's edge to trigger — which is
    // exactly what dragging a handle to the far side of the picture produces.
    //
    // Hand-checked case, so a failure is readable: bottom edge fixed at 0.05, north handle
    // hurled to the top of the frame, locked to 9:16 on a 4:3 frame. The fit wants
    // 0.0211 x 0.05 and the old per-axis floor lifted the width alone to 0.04, giving a
    // displayed ratio of 1.067 against the 0.5625 the user picked — nearly 2x wrong, and
    // baked straight into the export.
    const out = drag(
      { x: 0.3, y: 0.01, w: 0.3, h: 0.04 },
      'n',
      0,
      -0.91,
      { ratio: 9 / 16, frame: { width: 400, height: 300 } }
    );
    expect(displayedRatio(out, { width: 400, height: 300 }), 'the minimum-span floor broke the lock')
      .toBeCloseTo(9 / 16, 6);
    expect(out.w).toBeGreaterThanOrEqual(MIN_CROP_SPAN - 1e-12);
    expect(out.h).toBeGreaterThanOrEqual(MIN_CROP_SPAN - 1e-12);

    // And the same conflict from every direction, ratio and frame shape. Each gesture
    // parks the FIXED edge 5% from the frame's edge and throws the moving edge at the
    // opposite side, which is the only geometry that makes the fit this severe.
    const GESTURES = [
      { start: { x: 0.3, y: 0.01, w: 0.3, h: 0.04 }, anchor: 'n', dx: 0, dy: -0.91 },
      { start: { x: 0.3, y: 0.95, w: 0.3, h: 0.04 }, anchor: 's', dx: 0, dy: 0.91 },
      { start: { x: 0.01, y: 0.3, w: 0.04, h: 0.3 }, anchor: 'w', dx: -0.91, dy: 0 },
      { start: { x: 0.95, y: 0.3, w: 0.04, h: 0.3 }, anchor: 'e', dx: 0.91, dy: 0 },
    ];
    // The presets, and frames both ways up plus square.
    const RATIOS = [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16];
    const FRAMES = [
      { width: 400, height: 300 },
      { width: 300, height: 400 },
      { width: 400, height: 400 },
    ];

    for (const frame of FRAMES) {
      for (const ratio of RATIOS) {
        for (const g of GESTURES) {
          const rect = drag(g.start, g.anchor, g.dx, g.dy, { ratio, frame });
          const where = `${g.anchor} @ ${ratio.toFixed(3)} on ${frame.width}x${frame.height}`;
          expect(displayedRatio(rect, frame), `lock broken (${where})`).toBeCloseTo(ratio, 6);
          // Reachable for every preset: the most extreme displayed ratio here is a bit
          // over 3:1, and the minimum only becomes unreachable past 25:1.
          expect(rect.w, `under the minimum span (${where})`)
            .toBeGreaterThanOrEqual(MIN_CROP_SPAN - 1e-12);
          expect(rect.h, `under the minimum span (${where})`)
            .toBeGreaterThanOrEqual(MIN_CROP_SPAN - 1e-12);
          // Still a legal crop, whatever the fit had to give up.
          expect(rect.x, `outside the frame (${where})`).toBeGreaterThanOrEqual(-1e-12);
          expect(rect.y, `outside the frame (${where})`).toBeGreaterThanOrEqual(-1e-12);
          expect(right(rect), `outside the frame (${where})`).toBeLessThanOrEqual(1 + 1e-12);
          expect(bottom(rect), `outside the frame (${where})`).toBeLessThanOrEqual(1 + 1e-12);
        }
      }
    }
  });

  test('folding all the way through still respects the minimum span', () => {
    // Dragged so far that the fixed edge is at the frame boundary: the span cannot be
    // zero, and the rect has to stay inside the frame.
    const out = drag({ x: 0, y: 0, w: 0.2, h: 0.2 }, 'se', -0.9, -0.9);

    expect(out.w).toBeGreaterThanOrEqual(MIN_CROP_SPAN);
    expect(out.h).toBeGreaterThanOrEqual(MIN_CROP_SPAN);
    expect(out.x).toBeGreaterThanOrEqual(0);
    expect(out.y).toBeGreaterThanOrEqual(0);
    expect(right(out)).toBeLessThanOrEqual(1);
    expect(bottom(out)).toBeLessThanOrEqual(1);
  });
});
