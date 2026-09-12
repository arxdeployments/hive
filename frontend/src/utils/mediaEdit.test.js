/**
 * The colour slider's two halves, and the coordinate maths they sit beside.
 *
 * mediaEdit.js is 1135 lines and had no tests. Its own header calls
 * framePointToSource/sourcePointToFrame "the only fiddly maths in the feature",
 * and every size the annotation tools store is a fraction converted through a
 * matching pair — so the file is a stack of inverse relationships, none of which
 * anything checked.
 *
 * One of them was broken. `sliderPositionForInk` maps EVERY red to exactly
 * GREY_STOP, because hue 0 is where the hue ramp starts. `inkForSliderPosition`
 * gave that position to the grey band, whose end is black. So:
 *
 *   sliderPositionForInk('#EF4444')                -> 0.16   (= GREY_STOP)
 *   inkForSliderPosition(0.16)                     -> '#000000'
 *
 * Picking the red swatch parked the thumb on the gradient's black stop — a red
 * thumb sitting on black — and one ArrowUp from there turned the pen '#202020'.
 * The strip never painted red at all: sliderGradientStops emitted '#000000' at
 * 16% and interpolated from black to orange, so the ramp's first colour was
 * missing from the control that is supposed to show it.
 *
 * Red is not an arbitrary swatch to lose in a clinical tool. It is the colour
 * for circling the thing that is wrong, and black on a dark screenshot is not
 * visible at all.
 *
 * The boundary now belongs to the ramp. The grey band gives up nothing a swatch
 * needs: its own black is '#0A0A0A', which sits inside the band at 0.1537.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ASPECT_PRESETS,
  BLACK_STOP,
  FULL_CROP,
  GREY_STOP,
  SWATCHES,
  emptyEdit,
  framePointToSource,
  frameBoxFraction,
  frameFontFraction,
  boxWidthForFrame,
  clampFrameRect,
  foldDragRect,
  fontSizeForFrame,
  MIN_CROP_SPAN,
  inkForSliderPosition,
  rectFrameToSource,
  rectSourceToFrame,
  sliderGradientStops,
  sliderPositionForInk,
  sourcePointToFrame,
} from './mediaEdit.js';

/** Hue in degrees, computed here so the assertions do not lean on the module. */
const hueOf = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return null; // grey has no hue
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};

const isRed = (hex) => {
  const hue = hueOf(hex);
  return hue !== null && (hue <= 20 || hue >= 340);
};

const near = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

describe('the colour slider is its own inverse', () => {
  it('does not turn the red swatch black', () => {
    const position = sliderPositionForInk('#EF4444');
    const back = inkForSliderPosition(position);
    assert.equal(position, GREY_STOP, 'every red maps to the boundary; that is why it is the case that broke');
    assert.ok(isRed(back), `the red swatch round-tripped to ${back}`);
  });

  it('still reaches pure black, below the boundary', () => {
    // Giving GREY_STOP to the ramp took black's only position with it — the
    // greys ran to exactly GREY_STOP, so #000000 started round-tripping to red.
    // Black now ends the band at BLACK_STOP instead, which is why that constant
    // exists.
    assert.ok(BLACK_STOP < GREY_STOP, 'black must sit inside the grey band');
    assert.equal(sliderPositionForInk('#000000'), BLACK_STOP);
    assert.equal(inkForSliderPosition(BLACK_STOP), '#000000');
    assert.equal(inkForSliderPosition(sliderPositionForInk('#000000')), '#000000');
  });

  it('is black across the whole sliver, not just at one point', () => {
    // The reason for a band rather than an exact position: dragging can land
    // anywhere, and a single representable point is not reachable by hand.
    const midway = (BLACK_STOP + GREY_STOP) / 2;
    assert.equal(inkForSliderPosition(midway), '#000000');
  });

  it('paints that sliver solid rather than fading it into red', () => {
    const stops = sliderGradientStops();
    const blacks = stops.filter((stop) => stop.startsWith('#000000'));
    assert.equal(blacks.length, 2, `expected black at both ends of the sliver: ${stops.join(', ')}`);
    // Compared as numbers, not as the strings CSS happens to be given: '16.0%'
    // and '16.00%' are different text and the same position, and rounding the
    // two sides of the sliver onto one offset is exactly how it disappears.
    const offsets = stops.map((stop) => Number.parseFloat(stop.split(' ')[1]));
    assert.equal(
      new Set(offsets).size,
      stops.length,
      `two stops land on the same offset: ${stops.join(', ')}`,
    );
    assert.ok(
      offsets.every((offset, i) => i === 0 || offset > offsets[i - 1]),
      `stops are not in ascending order: ${stops.join(', ')}`,
    );
  });

  it('gives the shared boundary to the hue ramp, not the greys', () => {
    assert.ok(
      isRed(inkForSliderPosition(GREY_STOP)),
      `GREY_STOP decodes to ${inkForSliderPosition(GREY_STOP)}; the greys own a point only reds can reach`,
    );
  });

  for (const hex of ['#FF0000', '#EF4444', '#DC2626', '#E11D48', '#FF1A1A']) {
    it(`round-trips ${hex} to a red`, () => {
      const back = inkForSliderPosition(sliderPositionForInk(hex));
      assert.ok(isRed(back), `${hex} round-tripped to ${back}`);
    });
  }

  for (const hex of ['#FFFFFF', '#0A0A0A', '#808080']) {
    it(`round-trips the grey ${hex} exactly`, () => {
      assert.equal(inkForSliderPosition(sliderPositionForInk(hex)), hex);
    });
  }

  for (const hex of SWATCHES) {
    it(`keeps ${hex} on its own side of the boundary`, () => {
      // The slider only makes colours at one saturation and lightness, so a
      // swatch cannot come back byte-identical unless it is a grey. What must
      // hold is that a colour does not change kind: a hue stays a hue.
      const back = inkForSliderPosition(sliderPositionForInk(hex));
      assert.equal(
        hueOf(back) === null,
        hueOf(hex) === null,
        `${hex} round-tripped to ${back}, crossing between grey and hue`,
      );
    });
  }

  it('does not end the ramp where it started it', () => {
    // 0 -> 330, not 0 -> 360: the comment in the source says the bottom of the
    // strip must not be a duplicate of its own middle. Round-tripping cannot see
    // this — a ramp to 360 still round-trips — so the ends are named directly.
    const top = inkForSliderPosition(GREY_STOP);
    const bottom = inkForSliderPosition(1);
    assert.ok(isRed(top), `the ramp should start at red, not ${top}`);
    assert.ok(!isRed(bottom), `the ramp wraps back to red at the bottom: ${bottom}`);
    assert.ok(
      Math.abs(hueOf(bottom) - 330) < 2,
      `the ramp should end near magenta (330), not ${hueOf(bottom)}`,
    );
  });

  it('paints the ramp it can actually produce', () => {
    // The strip hid the defect: with black owning the boundary it interpolated
    // straight from black to orange, so red was never drawn.
    const stops = sliderGradientStops();
    assert.ok(
      stops.some((stop) => isRed(stop.split(' ')[0])),
      `no red anywhere on the strip: ${stops.join(', ')}`,
    );
  });
});

const EDITS = [];
for (const rotation of [0, 90, 180, 270]) {
  for (const flipH of [false, true]) {
    for (const flipV of [false, true]) {
      for (const crop of [FULL_CROP, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, { x: 0, y: 0, w: 0.25, h: 1 }]) {
        EDITS.push({ ...emptyEdit(), rotation, flipH, flipV, crop });
      }
    }
  }
}

const SIZES = [
  [4000, 3000],
  [1000, 1000],
  [640, 1136],
];

const label = (edit) => `rot${edit.rotation}${edit.flipH ? ' H' : ''}${edit.flipV ? ' V' : ''} crop ${edit.crop.w}x${edit.crop.h}`;

describe('the frame/source conversions land where they should', () => {
  // Round-tripping cannot catch an error both directions share: drop the flip
  // from framePointToSource and sourcePointToFrame still undoes it exactly.
  // These are absolute, and derived from what each transform means rather than
  // from what the code currently returns. The point is asymmetric in both axes
  // on purpose — 0.5 is its own mirror and would prove nothing.
  const POINT = { x: 0.25, y: 0.3 };
  const CROP = { x: 0.1, y: 0.2, w: 0.5, h: 0.4 };

  for (const [name, edit, expected] of [
    ['no edit at all', {}, { x: 0.25, y: 0.3 }],
    ['flipH mirrors x and leaves y', { flipH: true }, { x: 0.75, y: 0.3 }],
    ['flipV mirrors y and leaves x', { flipV: true }, { x: 0.25, y: 0.7 }],
    ['rot180 mirrors both', { rotation: 180 }, { x: 0.75, y: 0.7 }],
  ]) {
    it(name, () => {
      const got = framePointToSource(POINT, { ...emptyEdit(), ...edit });
      assert.ok(near(got.x, expected.x) && near(got.y, expected.y), `got ${JSON.stringify(got)}`);
    });
  }

  it('places the frame corners on the crop corners', () => {
    const edit = { ...emptyEdit(), crop: CROP };
    const origin = framePointToSource({ x: 0, y: 0 }, edit);
    const corner = framePointToSource({ x: 1, y: 1 }, edit);
    assert.ok(near(origin.x, CROP.x) && near(origin.y, CROP.y), `origin ${JSON.stringify(origin)}`);
    assert.ok(
      near(corner.x, CROP.x + CROP.w) && near(corner.y, CROP.y + CROP.h),
      `corner ${JSON.stringify(corner)}`,
    );
  });
});

describe('the frame/source conversions are inverses under every transform', () => {
  it('covers all four rotations, both flips and a crop', () => {
    assert.equal(EDITS.length, 48);
  });

  for (const edit of EDITS) {
    it(`maps points both ways under ${label(edit)}`, () => {
      for (const point of [{ x: 0, y: 0 }, { x: 0.3, y: 0.7 }, { x: 1, y: 1 }]) {
        const back = sourcePointToFrame(framePointToSource(point, edit), edit);
        assert.ok(near(back.x, point.x) && near(back.y, point.y), `${JSON.stringify(point)} -> ${JSON.stringify(back)}`);
      }
    });

    it(`maps rectangles both ways under ${label(edit)}`, () => {
      const rect = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
      const back = rectFrameToSource(rectSourceToFrame(rect, edit), edit);
      for (const key of ['x', 'y', 'w', 'h']) {
        assert.ok(near(back[key], rect[key]), `${key}: ${rect[key]} -> ${back[key]}`);
      }
    });

    it(`converts type and wrap sizes both ways under ${label(edit)}`, () => {
      for (const [width, height] of SIZES) {
        // Mirrored signatures, deliberately called as declared: fontSizeForFrame
        // takes (sourceHeight, sourceWidth) and frameFontFraction the other way.
        // Asserting the round-trip is what makes tidying one of them into a
        // failure rather than a silent change of every font size.
        const font = frameFontFraction(fontSizeForFrame(0.075, edit, height, width), edit, width, height);
        assert.ok(near(font, 0.075), `font ${width}x${height}: 0.075 -> ${font}`);
        const box = frameBoxFraction(boxWidthForFrame(0.7, edit, width, height), edit, width, height);
        assert.ok(near(box, 0.7), `box ${width}x${height}: 0.7 -> ${box}`);
      }
    });
  }
});


/**
 * clampFrameRect is 117 lines and carries three fixed bugs in its comments, each
 * with the exact drag that produced it. None of them had a test, so each was one
 * refactor from coming back — and they come back silently, in an exported image,
 * not in anything that throws.
 */
describe('a crop drag stays where the finger put it', () => {
  const FRAME = [1600, 900];

  for (const [anchor, held, describeHeld] of [
    ['e', (r) => r.x, 'the left edge'],
    ['w', (r) => r.x + r.w, 'the right edge'],
    ['s', (r) => r.y, 'the top edge'],
    ['n', (r) => r.y + r.h, 'the bottom edge'],
  ]) {
    it(`dragging '${anchor}' past the frame holds ${describeHeld}`, () => {
      // The comment's own reproduction: "Pulling the east handle right from
      // x=0.5,w=0.3 returned x=0.3,w=0.7" — the edge the finger was NOT holding
      // jumped inward, and a big enough overshoot selected the whole image.
      const start = { x: 0.5, y: 0.5, w: 0.3, h: 0.3 };
      const overshoot = { ...start, w: anchor === 'e' ? 1.2 : start.w, h: anchor === 's' ? 1.2 : start.h };
      if (anchor === 'w') Object.assign(overshoot, { x: -0.7, w: 1.5 });
      if (anchor === 'n') Object.assign(overshoot, { y: -0.7, h: 1.5 });

      const out = clampFrameRect(overshoot, ...FRAME, null, anchor);
      assert.ok(
        Math.abs(held(out) - held(start)) < 1e-9,
        `${describeHeld} moved from ${held(start)} to ${held(out)}: ${JSON.stringify(out)}`,
      );
    });
  }

  it('holds the right edge when a locked ratio shrinks the span', () => {
    // The re-seat at the end of the function, which the ratio block alone does
    // not cover: it anchors x for the ratio correction, and then the frame fit
    // scales the span again underneath it. Dragging the south-west handle below
    // the picture must not pull the right edge left with it.
    const rect = { x: 0.0279, y: 0.1047, w: 0.5488, h: 1.2659 };
    const out = clampFrameRect(rect, ...FRAME, 0.5625, 'sw');
    assert.ok(
      Math.abs(out.x + out.w - (rect.x + rect.w)) < 1e-3,
      `right edge moved from ${rect.x + rect.w} to ${out.x + out.w}: ${JSON.stringify(out)}`,
    );
  });

  it('grows up from the held bottom edge when a drag is squeezed under the minimum', () => {
    // The same re-seat on the other axis, reached a different way: the span is
    // below MIN_CROP_SPAN and gets grown. It has to grow away from the edge the
    // finger is holding, not push that edge further down.
    const rect = { x: 0.2, y: 0.5838, w: 0.5, h: 0.0134 };
    const out = clampFrameRect(rect, ...FRAME, null, 'n');
    assert.ok(out.h > rect.h, 'the span should have been grown to the minimum');
    assert.ok(
      Math.abs(out.y + out.h - (rect.y + rect.h)) < 1e-3,
      `bottom edge moved from ${rect.y + rect.h} to ${out.y + out.h}: ${JSON.stringify(out)}`,
    );
  });

  it('keeps a locked ratio when the frame squeezes one axis under the minimum', () => {
    // The second comment: dragging the north handle to the top with the bottom
    // edge already near the frame returned "a rect whose displayed ratio was
    // 1.07 instead of the 0.5625 the user had chosen" — because the minimum was
    // applied per axis after the fit, and a ratio does not survive that.
    const ratio = 0.5625;
    const out = clampFrameRect({ x: 0.3, y: -0.4, w: 0.4, h: 1.35 }, ...FRAME, ratio, 'n');
    const shown = (out.w * FRAME[0]) / (out.h * FRAME[1]);
    assert.ok(Math.abs(shown - ratio) < 1e-9, `displayed ratio ${shown}, wanted ${ratio}`);
  });

  it('folds a drag that crosses its own opposite edge, and moves the anchor with it', () => {
    // clampFrameRect reads the anchor as given, so the fold has to hand over the
    // swapped one — by the time a rect reaches it the span is positive again and
    // nothing else knows a fold happened.
    const { rect, anchor } = foldDragRect({ x: 0.7, y: 0.6, w: -0.4, h: -0.3 }, 'se');
    assert.deepEqual(
      { x: +rect.x.toFixed(10), y: +rect.y.toFixed(10), w: +rect.w.toFixed(10), h: +rect.h.toFixed(10) },
      { x: 0.3, y: 0.3, w: 0.4, h: 0.3 },
    );
    assert.equal(anchor, 'nw');
  });

  it('keeps the unheld axis centred on the drag', () => {
    // Dragging 'n' or 's' constrains the vertical only, so a ratio lock is free
    // to choose the width — and it has to stay centred on the drag rather than
    // sliding sideways. The order matters: the span has to be final before the
    // re-centring, or the rect is centred at one width and then grown to
    // another. Both cases below drift by ~3% of the frame when it is not.
    for (const [anchor, rect, ratio, frame, axis] of [
      ['s', { x: 0.4792, y: 0.4484, w: 0.0101, h: 0.1825 }, 4 / 3, [900, 1600], 'x'],
      ['w', { x: 0.6115, y: 0.7908, w: 0.0755, h: 0.3049 }, 16 / 9, [900, 1600], 'y'],
    ]) {
      const out = clampFrameRect(rect, ...frame, ratio, anchor);
      const span = axis === 'x' ? 'w' : 'h';
      const wanted = rect[axis] + rect[span] / 2;
      const got = out[axis] + out[span] / 2;
      assert.ok(
        Math.abs(got - wanted) < 1e-3,
        `anchor '${anchor}': ${axis} centre moved from ${wanted} to ${got}: ${JSON.stringify(out)}`,
      );
    }
  });

  it('locks a ratio by shrinking, never by growing', () => {
    // Both axes can reach a given ratio — shrink the long one or grow the short
    // one — and both leave the ratio exactly right, so asserting the ratio alone
    // cannot tell them apart. Growing is wrong: the crop would cover more of the
    // picture than the drag asked for. Measured on the inverted branch, a
    // 0.61 x 0.65 drag at 3:4 came back 0.42 x 0.99 — nearly the full height.
    const ratios = ASPECT_PRESETS.map((preset) => preset.ratio).filter(Boolean);
    const rects = [
      { x: 0.21, y: 0.33, w: 0.61, h: 0.65 },
      { x: 0.31, y: 0.2, w: 0.52, h: 0.27 },
      { x: 0.1, y: 0.1, w: 0.8, h: 0.3 },
      { x: 0.25, y: 0.25, w: 0.3, h: 0.7 },
    ];
    for (const [width, height] of [FRAME, [900, 1600], [1000, 1000]]) {
      for (const ratio of ratios) {
        for (const anchor of [null, 'n', 'e', 'sw', 'ne']) {
          for (const rect of rects) {
            const out = clampFrameRect(rect, width, height, ratio, anchor);
            const where = `${width}x${height} ratio=${ratio} anchor=${anchor} ${JSON.stringify(rect)} -> ${JSON.stringify(out)}`;
            // These rects all sit inside the frame and well above the minimum,
            // so neither the fit nor the grow-to-minimum has anything to do.
            assert.ok(out.w <= rect.w + 1e-9, `width grew: ${where}`);
            assert.ok(out.h <= rect.h + 1e-9, `height grew: ${where}`);
          }
        }
      }
    }
  });

  it('never returns a rect outside the frame, under the minimum, or off-ratio', () => {
    // A deterministic sweep rather than a sample: every anchor against every
    // preset ratio, with rects that overshoot each way on purpose, since
    // overshooting is the case the function exists for.
    const anchors = [null, 'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    const ratios = [null, ...ASPECT_PRESETS.map((preset) => preset.ratio).filter(Boolean)];
    const rects = [
      { x: 0.5, y: 0.5, w: 1.2, h: 1.2 },
      { x: -0.3, y: -0.3, w: 1.4, h: 1.4 },
      { x: 0.9, y: 0.9, w: 0.5, h: 0.5 },
      { x: 0.5, y: 0.5, w: 0.0001, h: 0.0001 },
      { x: 0.02, y: 0.02, w: 0.01, h: 0.99 },
    ];
    for (const [width, height] of [FRAME, [900, 1600], [1000, 1000]]) {
      for (const anchor of anchors) {
        for (const ratio of ratios) {
          for (const rect of rects) {
            const out = clampFrameRect(rect, width, height, ratio, anchor);
            const where = `${width}x${height} ratio=${ratio} anchor=${anchor} ${JSON.stringify(rect)} -> ${JSON.stringify(out)}`;
            assert.ok(out.x >= -1e-9 && out.y >= -1e-9, `outside the frame: ${where}`);
            assert.ok(out.x + out.w <= 1 + 1e-9 && out.y + out.h <= 1 + 1e-9, `outside the frame: ${where}`);
            assert.ok(
              out.w >= MIN_CROP_SPAN - 1e-9 && out.h >= MIN_CROP_SPAN - 1e-9,
              `under the minimum span: ${where}`,
            );
            if (ratio) {
              const shown = (out.w * width) / (out.h * height);
              assert.ok(Math.abs(shown - ratio) < 1e-6 * ratio, `ratio ${shown} != ${ratio}: ${where}`);
            }
          }
        }
      }
    }
  });
});
