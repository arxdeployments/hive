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
  FULL_CROP,
  GREY_STOP,
  SWATCHES,
  emptyEdit,
  framePointToSource,
  frameBoxFraction,
  frameFontFraction,
  boxWidthForFrame,
  fontSizeForFrame,
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
