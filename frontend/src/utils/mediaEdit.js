/**
 * The edit model for a staged attachment, and the compositor that bakes it.
 *
 * Two features live on top of this file: crop/rotate/flip, and freehand drawing
 * plus text boxes. Both are pre-send edits — nothing here touches the network,
 * exactly like the confirmation tray it hangs off (see MessageComposer.jsx).
 *
 * ## One rule makes revert free
 *
 * A staged file keeps its ORIGINAL bytes forever and carries an edit model
 * beside them. The bytes that get uploaded are re-derived from
 * original + model every time the user presses Save, and "revert to original"
 * is `emptyEdit()` — not an inverse transform, not an undo stack replayed
 * backwards. That is also why re-opening the editor can show the crop handles
 * where they were left and the strokes still live: the model, not a flattened
 * JPEG, is the source of truth.
 *
 * ## Everything is stored in SOURCE space
 *
 * Stroke points, text positions, pen widths and font sizes are all normalised
 * against the ORIGINAL image — 0..1 of its width/height, and widths as a
 * fraction of its short edge. Not against the visible frame.
 *
 * The alternative (store against what is on screen) looks simpler until the
 * user crops after drawing: annotations stored in frame space would slide
 * across the picture as the frame moved. Stored in source space they are glued
 * to the pixels they were drawn on, so crop, rotate and flip carry them along
 * and a tighter crop genuinely cuts a stroke in half — which is what everyone
 * expects. The cost is two coordinate conversions, `framePointToSource` and
 * `sourcePointToFrame`, and they are the only fiddly maths in the feature.
 *
 * ## The pipeline, in order
 *
 *     crop  →  flipH / flipV  →  rotate (multiples of 90°)
 *
 * Fixed and non-negotiable, because the on-screen preview and the exported
 * bytes must agree to the pixel: both go through `drawEdit`. The UI hides the
 * consequence — at 90°/270° the "flip horizontal" button toggles `flipV`, so
 * the control always flips what the user can actually see (see CropStage).
 *
 * Mirrors ios/RxHive/Features/Media/Editor/MediaEdit.swift: the same model, the
 * same pipeline order, the same pen fractions and the same rotation formulae.
 * A change on either side has to be made on both or a photo edited on a phone
 * and re-opened on the web would not survive the round trip.
 */

// A hair under one, so a crop dragged to the very edge is not reported as
// cropped by float noise (0.9999999999999998 happens routinely).
const EPSILON = 1e-4;

export const FULL_CROP = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

/** A brand-new, untouched edit. Also the value "revert to original" assigns. */
export const emptyEdit = () => ({
  /** Normalised rect in SOURCE space, pre-rotation. null means the whole frame. */
  crop: null,
  /** Clockwise, degrees. Only 0/90/180/270 — see the note about the straighten dial below. */
  rotation: 0,
  flipH: false,
  flipV: false,
  /** [{ id, color, width, points: [{ x, y }] }] — width is a fraction of the source short edge. */
  strokes: [],
  /** See `makeText` for the shape. */
  texts: [],
});

/**
 * Deliberately no free-angle straighten dial.
 *
 * The reference app has one, and it is tempting because `ctx.rotate` takes any
 * angle. What it actually costs is a crop rect that is no longer axis-aligned
 * in source space: every hit-test, every handle drag and both coordinate
 * conversions in this file gain a rotation term, and the crop can no longer be
 * expressed as `{x,y,w,h}`. Multiples of 90° keep the model a rectangle, which
 * is what makes crop-after-draw provably correct rather than approximately
 * correct. Rotation is stored as a number rather than an enum so adding it
 * later is a change to the geometry, not to the persisted shape.
 */
export const ROTATIONS = [0, 90, 180, 270];

/** The four pen widths, as a fraction of the VISIBLE frame's short edge. */
export const PEN_SIZES = Object.freeze([
  { key: 'fine', label: 'Fine', fraction: 0.006, dot: 4 },
  { key: 'medium', label: 'Medium', fraction: 0.013, dot: 7 },
  { key: 'bold', label: 'Bold', fraction: 0.024, dot: 11 },
  { key: 'marker', label: 'Marker', fraction: 0.042, dot: 16 },
]);

export const DEFAULT_PEN_KEY = 'medium';

/**
 * Aspect presets for the crop bar. `ratio` is width / height of the VISIBLE
 * frame, so a portrait photo cropped 16:9 still comes out landscape.
 */
export const ASPECT_PRESETS = Object.freeze([
  { key: 'free', label: 'Free', ratio: null },
  { key: 'square', label: '1:1', ratio: 1 },
  { key: 'landscape43', label: '4:3', ratio: 4 / 3 },
  { key: 'portrait34', label: '3:4', ratio: 3 / 4 },
  { key: 'wide', label: '16:9', ratio: 16 / 9 },
  { key: 'tall', label: '9:16', ratio: 9 / 16 },
]);

/**
 * The swatch row, and the ends of the colour slider.
 *
 * White first, not emerald: the overwhelmingly common annotation is an arrow or
 * a ring drawn on a screenshot, and the app's own emerald is the one colour
 * guaranteed to collide with RX HIVE chrome inside a screenshot of RX HIVE.
 */
export const SWATCHES = Object.freeze([
  '#FFFFFF', '#0A0A0A', '#EF4444', '#F59E0B', '#FBBF24',
  '#10B981', '#22D3EE', '#3B82F6', '#A855F7', '#F472B6',
]);

export const DEFAULT_INK = '#22D3EE';

// ── The colour slider ────────────────────────────────────────────────────────

/**
 * Fraction of the slider's travel given to greys before the hue ramp starts.
 *
 * The reference's strip is white → black → rainbow, and the grey band is
 * narrow. It has to exist: white and black are the two most-used annotation
 * colours and a pure-hue slider cannot reach either.
 */
export const GREY_STOP = 0.16;

/**
 * Slider position (0 at the top, 1 at the bottom) → CSS colour.
 *
 * Returns `#RRGGBB` rather than `hsl()` so the value can go straight into a
 * canvas `strokeStyle`, a DOM `color`, and — unchanged — into the iOS model.
 */
export function inkForSliderPosition(position) {
  const t = clamp(position, 0, 1);
  if (t <= GREY_STOP) {
    // White at the very top down to black at the end of the band.
    const level = Math.round(255 * (1 - t / GREY_STOP));
    return rgbToHex(level, level, level);
  }
  // 0 → 330 rather than 0 → 360: ending on magenta instead of wrapping back to
  // red means the bottom of the strip is not a duplicate of its own middle.
  const hue = ((t - GREY_STOP) / (1 - GREY_STOP)) * 330;
  const [r, g, b] = hslToRgb(hue, 0.85, 0.55);
  return rgbToHex(r, g, b);
}

/** The inverse, so the thumb can be parked correctly when a swatch is tapped. */
export function sliderPositionForInk(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return GREY_STOP + 0.35;
  const [r, g, b] = rgb;
  if (r === g && g === b) {
    return clamp((1 - r / 255) * GREY_STOP, 0, GREY_STOP);
  }
  const hue = rgbToHue(r, g, b);
  // A hue past the 330 end of the ramp is nearer red than magenta, so it parks
  // at the top of the ramp rather than off the end of the slider.
  const ramp = hue > 345 ? 0 : Math.min(hue, 330) / 330;
  return GREY_STOP + ramp * (1 - GREY_STOP);
}

/** CSS for the strip itself. Kept here so web and iOS read from one place. */
export function sliderGradientStops() {
  const stops = ['#FFFFFF 0%', `#000000 ${(GREY_STOP * 100).toFixed(1)}%`];
  for (let i = 0; i <= 6; i += 1) {
    const t = GREY_STOP + (i / 6) * (1 - GREY_STOP);
    stops.push(`${inkForSliderPosition(t)} ${(t * 100).toFixed(1)}%`);
  }
  return stops;
}

// ── Text boxes ───────────────────────────────────────────────────────────────

/**
 * A text box.
 *
 * The two size controls the brief asks for are genuinely independent: `fontSize`
 * scales the glyphs, `boxWidth` sets the wrap width — so the same sentence can
 * be one tall column or one wide line at the same type size. Likewise `color`
 * and `boxColor`/`boxOpacity` are separate, and `boxOpacity` defaults to 0, which
 * is the transparent background the brief asks for: nothing is drawn behind the
 * glyphs at all until the user asks for a plate.
 */
export const makeText = (overrides = {}) => ({
  id: overrides.id || `t${Math.random().toString(36).slice(2, 10)}`,
  text: '',
  /** Normalised SOURCE coords of the box CENTRE. */
  x: 0.5,
  y: 0.5,
  /** Wrap width of the text, as a fraction of source width. */
  boxWidth: 0.6,
  /** Fraction of source HEIGHT — so type stays the same visual size on a portrait or landscape photo. */
  fontSize: 0.055,
  /** Inner padding, as a fraction of source height. */
  padding: 0.014,
  color: '#FFFFFF',
  boxColor: '#0A0A0A',
  /** 0 = the transparent background this feature is specified around. */
  boxOpacity: 0,
  align: 'center',
  ...overrides,
});

export const TEXT_LINE_HEIGHT = 1.26;

/**
 * Slider limits, expressed against the VISIBLE frame rather than the source.
 *
 * These are what the two size controls travel between, and they are the numbers
 * the user is really choosing: "3% to 30% of the frame's height" for type, "15%
 * to the full width" for the wrap box. The stored values stay source-relative;
 * `frameFontFraction` / `frameBoxFraction` translate.
 */
export const FONT_FRAME_MIN = 0.03;
export const FONT_FRAME_MAX = 0.30;
export const FONT_FRAME_DEFAULT = 0.075;
export const BOX_FRAME_MIN = 0.15;
export const BOX_FRAME_MAX = 1.0;
export const BOX_FRAME_DEFAULT = 0.7;

/**
 * The one font stack used by the preview canvas, the export canvas and the
 * editor's DOM chrome. They must agree or a text box would reflow between what
 * the user placed and what gets sent.
 */
export const TEXT_FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

export const canvasFont = (pixelSize) => `600 ${pixelSize}px ${TEXT_FONT_STACK}`;

/**
 * Greedy word wrap, with explicit newlines honoured and over-long words broken.
 *
 * Greedy is what CSS `word-wrap` does for the overwhelming majority of content,
 * which matters because the editor's drag handles are DOM elements sized from
 * THIS function's answer while the glyphs are drawn on canvas. A word longer
 * than the box is split mid-word rather than allowed to overflow, matching
 * `word-break: break-word`.
 */
export function wrapText(ctx, text, maxWidth) {
  const lines = [];
  const paragraphs = String(text ?? '').split('\n');

  for (const paragraph of paragraphs) {
    const words = paragraph.split(/(\s+)/).filter((w) => w !== '');
    if (words.length === 0) { lines.push(''); continue; }

    let line = '';
    for (const word of words) {
      const candidate = line + word;
      if (line !== '' && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(word) ? '' : word;
      } else {
        line = candidate;
      }
      // A single word wider than the box: break it rather than overflow.
      //
      // The cut point is found by BISECTION, not by walking back a character at a
      // time. A linear walk is O(n) shaping calls per broken line and O(n) lines, so
      // a pasted URL or an accession number typed without spaces turns into O(n²)
      // `measureText` calls — and this runs on every layout of the box, i.e. on every
      // keystroke. At a few hundred characters that is a visibly frozen editor.
      while (ctx.measureText(line.trimEnd()).width > maxWidth && line.trim().length > 1) {
        let low = 1;
        let high = line.length;
        while (low < high) {
          const mid = (low + high + 1) >> 1;
          if (ctx.measureText(line.slice(0, mid)).width > maxWidth) high = mid - 1;
          else low = mid;
        }
        lines.push(line.slice(0, low));
        line = line.slice(low);
      }
    }
    lines.push(line.trimEnd());
  }

  // A box with nothing in it still needs one line's worth of height, or its
  // handles collapse to a sliver the moment the user clears the text.
  return lines.length > 0 ? lines : [''];
}

/**
 * Lay one text box out in SOURCE pixels.
 *
 * `ctx` only has to be a 2D context with the right font set — it is never drawn
 * to here, so the editor can measure against its preview canvas and the
 * exporter against its own, and both get the same answer.
 */
export function measureTextBox(ctx, item, sourceWidth, sourceHeight) {
  const fontPx = Math.max(1, item.fontSize * sourceHeight);
  ctx.font = canvasFont(fontPx);
  const contentWidth = Math.max(1, item.boxWidth * sourceWidth);
  const pad = item.padding * sourceHeight;
  const lines = wrapText(ctx, item.text, contentWidth);
  const lineHeight = fontPx * TEXT_LINE_HEIGHT;
  return {
    lines,
    fontPx,
    pad,
    lineHeight,
    contentWidth,
    boxWidth: contentWidth + pad * 2,
    boxHeight: lines.length * lineHeight + pad * 2,
  };
}

// ── Geometry ─────────────────────────────────────────────────────────────────

export const cropOf = (edit) => (edit && edit.crop) || FULL_CROP;

export const isQuarterTurned = (edit) => {
  const r = normalizeRotation(edit?.rotation);
  return r === 90 || r === 270;
};

export function normalizeRotation(rotation) {
  const r = Math.round((Number(rotation) || 0) / 90) * 90;
  return ((r % 360) + 360) % 360;
}

export function hasCrop(edit) {
  const c = cropOf(edit);
  return c.x > EPSILON || c.y > EPSILON || c.w < 1 - EPSILON || c.h < 1 - EPSILON;
}

/** Is there anything to bake — and therefore anything for Revert to undo? */
export function hasEdits(edit) {
  if (!edit) return false;
  return (
    hasCrop(edit)
    || normalizeRotation(edit.rotation) !== 0
    || Boolean(edit.flipH)
    || Boolean(edit.flipV)
    || (edit.strokes?.length ?? 0) > 0
    || (edit.texts?.length ?? 0) > 0
  );
}

/**
 * Drop text boxes nobody typed into.
 *
 * Tapping "Add text" creates the box before there is anything in it, so leaving the
 * editor at that moment — switching to the pen, or pressing Done — would otherwise
 * leave an invisible empty box in the model. `hasEdits` counts it, so the item gets
 * badged as edited, Revert appears with nothing to undo, and Save re-encodes the
 * photo to add precisely nothing.
 *
 * Applied at the save chokepoint rather than in the stage, so it holds for every way
 * out of the editor rather than only the one that happens to call back into the text
 * tool.
 */
export function pruneEmptyTexts(edit) {
  if (!edit?.texts?.length) return edit;
  const kept = edit.texts.filter((t) => (t.text || '').trim().length > 0);
  return kept.length === edit.texts.length ? edit : { ...edit, texts: kept };
}

/** A one-line "Cropped · Drawn · Text" summary for the staged tile's tooltip. */
export function describeEdits(edit) {
  if (!edit) return '';
  const parts = [];
  if (hasCrop(edit)) parts.push('cropped');
  if (normalizeRotation(edit.rotation) !== 0) parts.push(`rotated ${normalizeRotation(edit.rotation)}°`);
  if (edit.flipH || edit.flipV) parts.push('flipped');
  if ((edit.strokes?.length ?? 0) > 0) parts.push('drawn on');
  if ((edit.texts?.length ?? 0) > 0) parts.push((edit.texts.length === 1) ? 'text added' : `${edit.texts.length} texts`);
  return parts.join(' · ');
}

/** The cropped region, in source pixels, before rotation. */
export function croppedPixelSize(sourceWidth, sourceHeight, edit) {
  const c = cropOf(edit);
  return {
    width: Math.max(1, Math.round(c.w * sourceWidth)),
    height: Math.max(1, Math.round(c.h * sourceHeight)),
  };
}

/**
 * Output pixel size, after rotation and after fitting inside `maxEdge`.
 *
 * Never upscales — the same rule `transcodeImage` follows, and for the same
 * reason: a 700px screenshot must not be sent as a soft 1600px one.
 */
export function outputPixelSize(sourceWidth, sourceHeight, edit, maxEdge = Infinity) {
  const cropped = croppedPixelSize(sourceWidth, sourceHeight, edit);
  const fit = Math.min(1, maxEdge / Math.max(cropped.width, cropped.height));
  const w = Math.max(1, Math.round(cropped.width * fit));
  const h = Math.max(1, Math.round(cropped.height * fit));

  // The scale is re-derived FROM the rounded canvas, against the UNROUNDED crop, and
  // the larger of the two axes wins.
  //
  // Using `fit` directly leaves a gap: the canvas is `round(cropWidth * fit)` but the
  // image is positioned from the unrounded crop, so it covers exactly
  // `cropWidth * fit`. Where rounding goes up — about half of ordinary crops — the
  // canvas is up to a pixel wider than the pixels drawn into it. Everywhere except a
  // crop flush with the source's right or bottom edge there is more image to clip,
  // so nothing shows; flush against that edge there is not, and the last column keeps
  // the `clearRect` alpha, which a JPEG then composites onto black as a dark hairline
  // down the edge of the sent photo. The preview never showed it, because
  // `outputForDisplay` already erred large the same way this now does.
  //
  // Erring large costs under a pixel of overscan, which the canvas clips.
  const c = cropOf(edit);
  const exactWidth = Math.max(1e-6, c.w * sourceWidth);
  const exactHeight = Math.max(1e-6, c.h * sourceHeight);
  const scale = Math.max(w / exactWidth, h / exactHeight);

  return isQuarterTurned(edit)
    ? { width: h, height: w, scale, unrotatedWidth: w, unrotatedHeight: h }
    : { width: w, height: h, scale, unrotatedWidth: w, unrotatedHeight: h };
}

/** Aspect ratio (w/h) of what the user is looking at. */
export function frameAspect(sourceWidth, sourceHeight, edit) {
  const { width, height } = croppedPixelSize(sourceWidth, sourceHeight, edit);
  return isQuarterTurned(edit) ? height / width : width / height;
}

/**
 * Visible-frame coordinates (0..1 of the frame) → normalised SOURCE.
 *
 * Undoes rotate, then flip, then crop — the pipeline backwards.
 */
export function framePointToSource(point, edit) {
  const c = cropOf(edit);
  const r = normalizeRotation(edit?.rotation);
  const fx = point.x;
  const fy = point.y;

  let ux;
  let uy;
  if (r === 90) { ux = fy; uy = 1 - fx; }
  else if (r === 180) { ux = 1 - fx; uy = 1 - fy; }
  else if (r === 270) { ux = 1 - fy; uy = fx; }
  else { ux = fx; uy = fy; }

  if (edit?.flipH) ux = 1 - ux;
  if (edit?.flipV) uy = 1 - uy;

  return { x: c.x + ux * c.w, y: c.y + uy * c.h };
}

/** The forward direction: normalised SOURCE → visible-frame 0..1. */
export function sourcePointToFrame(point, edit) {
  const c = cropOf(edit);
  const r = normalizeRotation(edit?.rotation);

  let ux = c.w === 0 ? 0 : (point.x - c.x) / c.w;
  let uy = c.h === 0 ? 0 : (point.y - c.y) / c.h;
  if (edit?.flipH) ux = 1 - ux;
  if (edit?.flipV) uy = 1 - uy;

  if (r === 90) return { x: 1 - uy, y: ux };
  if (r === 180) return { x: 1 - ux, y: 1 - uy };
  if (r === 270) return { x: uy, y: 1 - ux };
  return { x: ux, y: uy };
}

/**
 * A pen chosen against what is on screen, converted to the stored width.
 *
 * The stored value is a fraction of the SOURCE short edge, but the user picked
 * a thickness relative to the frame in front of them. Without this conversion a
 * "Bold" pen would come out hairline-thin on a tightly cropped region of a 12MP
 * photo, because the same fraction of the whole sensor is a much bigger number
 * of pixels than the crop is wide.
 */
export function penWidthForFrame(fraction, edit, sourceWidth, sourceHeight) {
  const cropped = croppedPixelSize(sourceWidth, sourceHeight, edit);
  const frameShortEdge = Math.min(cropped.width, cropped.height);
  const sourceShortEdge = Math.max(1, Math.min(sourceWidth, sourceHeight));
  return (fraction * frameShortEdge) / sourceShortEdge;
}

/** The same conversion for type, which is sized against the frame's height. */
export function fontSizeForFrame(fraction, edit, sourceHeight, sourceWidth) {
  const cropped = croppedPixelSize(sourceWidth, sourceHeight, edit);
  const frameHeight = isQuarterTurned(edit) ? cropped.width : cropped.height;
  return (fraction * frameHeight) / Math.max(1, sourceHeight);
}

/** …and for a wrap width, which is sized against the frame's width. */
export function boxWidthForFrame(fraction, edit, sourceWidth, sourceHeight) {
  const cropped = croppedPixelSize(sourceWidth, sourceHeight, edit);
  const frameWidth = isQuarterTurned(edit) ? cropped.height : cropped.width;
  return (fraction * frameWidth) / Math.max(1, sourceWidth);
}

/**
 * The two inverses, so the size sliders can be labelled in terms of the frame.
 *
 * A slider that reads "font size 0.031" of an image the user cannot see the
 * dimensions of is meaningless; "8% of the frame's height" is the number they are
 * actually choosing. The stored values stay source-relative — there is one
 * source of truth, and these only translate it for display.
 */
export function frameFontFraction(fontSize, edit, sourceWidth, sourceHeight) {
  const cropped = croppedPixelSize(sourceWidth, sourceHeight, edit);
  const frameHeight = Math.max(1, isQuarterTurned(edit) ? cropped.width : cropped.height);
  return (fontSize * sourceHeight) / frameHeight;
}

export function frameBoxFraction(boxWidth, edit, sourceWidth, sourceHeight) {
  const cropped = croppedPixelSize(sourceWidth, sourceHeight, edit);
  const frameWidth = Math.max(1, isQuarterTurned(edit) ? cropped.height : cropped.width);
  return (boxWidth * sourceWidth) / frameWidth;
}

/**
 * 4% of the frame. Small enough to crop one face out of a group photo, large
 * enough that the eight drag handles do not sit on top of each other.
 */
export const MIN_CROP_SPAN = 0.04;

/** Keep a source-space crop rect legal: inside the frame, and not vanishingly small. */
export function clampCrop(rect) {
  const w = clamp(rect.w, MIN_CROP_SPAN, 1);
  const h = clamp(rect.h, MIN_CROP_SPAN, 1);
  return {
    x: clamp(rect.x, 0, 1 - w),
    y: clamp(rect.y, 0, 1 - h),
    w,
    h,
  };
}

/**
 * Pixel size of the whole rotated frame, ignoring the crop.
 *
 * This is the box the crop stage displays: a crop UI has to show what is being
 * cut away, so it renders the full image and dims the outside.
 */
export function frameSize(sourceWidth, sourceHeight, edit) {
  return isQuarterTurned(edit)
    ? { width: sourceHeight, height: sourceWidth }
    : { width: sourceWidth, height: sourceHeight };
}

/**
 * A source-space rect, expressed in the displayed full frame's 0..1 coordinates.
 *
 * Built from the point converters rather than from its own rotation table: a
 * 90°-multiple rotation maps an axis-aligned rectangle to an axis-aligned
 * rectangle, so transforming two opposite corners and re-normalising is exact —
 * and cannot drift out of step with where a stroke lands, which a second copy of
 * the rotation cases eventually would.
 *
 * `crop: null` is forced because the FULL frame is the reference here, not the
 * cropped one.
 */
export function rectSourceToFrame(rect, edit) {
  const uncropped = { ...edit, crop: null };
  const a = sourcePointToFrame({ x: rect.x, y: rect.y }, uncropped);
  const b = sourcePointToFrame({ x: rect.x + rect.w, y: rect.y + rect.h }, uncropped);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

/** The inverse. */
export function rectFrameToSource(rect, edit) {
  const uncropped = { ...edit, crop: null };
  const a = framePointToSource({ x: rect.x, y: rect.y }, uncropped);
  const b = framePointToSource({ x: rect.x + rect.w, y: rect.y + rect.h }, uncropped);
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

// A fold swaps the two edges on the axis it folded, and leaves the other axis alone.
const FOLD_HORIZONTAL = { e: 'w', w: 'e' };
const FOLD_VERTICAL = { n: 's', s: 'n' };
const swapAnchor = (anchor, table) =>
  (anchor ? [...anchor].map((c) => table[c] || c).join('') : anchor);

/**
 * Fold a drag whose span has gone negative, and report which edge the finger is on
 * once it has.
 *
 * Dragging the east handle back past the west edge gives a negative width, which would
 * render inside-out, so the rect is folded. But folding also SWAPS the roles of the two
 * edges: the edge the gesture is not holding — the one fixed where the drag started — is
 * now `x + w` rather than `x`, and the moving edge is `x`. That is precisely what a 'w'
 * anchor describes, so the anchor has to fold with the rect.
 *
 * They are returned together because they are one fact, and a caller that applies the
 * fold without the swap is the bug this exists to prevent: `clampFrameRect` decides
 * which edge to pin from the anchor it is handed, so given the original 'e' it pins the
 * LEFT edge of a rect whose left edge is the one being dragged. An east drag from
 * `{ x: 0.2, w: 0.1 }` folded to `{ x: -0.2, w: 0.4 }` then came back as
 * `{ x: 0, w: 0.4 }` — the fixed right edge pushed from 0.2 out to 0.4 by a gesture
 * that was pulling the other way, so the crop grew on the side the finger had left.
 *
 * @returns {{rect: {x: number, y: number, w: number, h: number}, anchor: string}}
 */
export function foldDragRect(rect, anchor) {
  let { x, y, w, h } = rect;
  let folded = anchor;
  if (w < 0) {
    x += w;
    w = -w;
    folded = swapAnchor(folded, FOLD_HORIZONTAL);
  }
  if (h < 0) {
    y += h;
    h = -h;
    folded = swapAnchor(folded, FOLD_VERTICAL);
  }
  return { rect: { x, y, w, h }, anchor: folded };
}

/**
 * Clamp a rect the user is dragging, in FRAME space, honouring a locked ratio.
 *
 * The ratio is done here rather than in source space because here it is what it
 * says it is: the displayed rect's pixel width over its pixel height. In source
 * space the same constraint has to be inverted for a quarter-turned image, which
 * is exactly the kind of sign error that ships as "16:9 gives me 9:16".
 *
 * `anchor` is the corner or edge being dragged, so the rect grows away from the
 * point the finger is not holding. Without it a ratio correction on a
 * top-left drag visibly pulls the bottom-right corner around.
 */
export function clampFrameRect(rect, frameWidth, frameHeight, ratio = null, anchor = null) {
  let w = clamp(rect.w, MIN_CROP_SPAN, 1);
  let h = clamp(rect.h, MIN_CROP_SPAN, 1);
  let x = rect.x;
  let y = rect.y;

  if (ratio) {
    // Normalised units are not square, so the constraint is applied in pixels.
    const pxW = w * frameWidth;
    const pxH = h * frameHeight;
    if (pxW / pxH > ratio) {
      w = ((pxH * ratio) / frameWidth);
    } else {
      h = ((pxW / ratio) / frameHeight);
    }
    // Ratio-correcting only ever shrinks, so it can push the rect under the
    // minimum. Grow both axes back together, up to whatever the frame allows.
    const grow = Math.min(
      Math.max(MIN_CROP_SPAN / w, MIN_CROP_SPAN / h, 1),
      1 / w,
      1 / h
    );
    w *= grow;
    h *= grow;

    // Re-anchor: whichever edges the drag was NOT holding are the ones that move.
    if (anchor) {
      if (anchor.includes('e')) x = rect.x;
      else if (anchor.includes('w')) x = (rect.x + rect.w) - w;
      else x = rect.x + (rect.w - w) / 2;

      if (anchor.includes('s')) y = rect.y;
      else if (anchor.includes('n')) y = (rect.y + rect.h) - h;
      else y = rect.y + (rect.h - h) / 2;
    }
  }

  // Fit into the frame by stopping the DRAGGED edge at the boundary, not by
  // sliding the whole rect.
  //
  // This used to be `clamp(x, 0, 1 - w)` with the span left alone, which kept the
  // size and moved the position — so an ordinary overshoot past the edge of the
  // picture dragged the opposite edge along with it. Pulling the east handle right
  // from x=0.5,w=0.3 returned x=0.3,w=0.7: the left edge, which the finger was not
  // holding, jumped inward, and a big enough overshoot saturated at x=0,w=1 and
  // selected the whole image. Every resize anchor had it, in both axes.
  //
  // Which edge is fixed follows from the anchor: dragging 'e' holds the left edge,
  // 'w' holds the right, 's' holds the top, 'n' holds the bottom. For the 'w'/'n'
  // cases the incoming rect still carries that fixed edge — CropStage moves x and w
  // by equal and opposite amounts — so `x + w` is the edge to preserve.
  //
  // This reads the anchor as given, so a drag that folded past its opposite edge must
  // hand over the FOLDED anchor: see `foldDragRect`, which is the only thing that knows
  // a fold happened (by the time a rect arrives here its span is positive again).
  const holdLeft = !!anchor?.includes('e');
  const holdRight = !!anchor?.includes('w');
  const holdTop = !!anchor?.includes('s');
  const holdBottom = !!anchor?.includes('n');
  // From the INCOMING rect, not from the already-clamped span: `w` was capped to 1
  // at the top of this function, so once a drag overshoots far enough for that cap
  // to bite, `x + w` is no longer the edge the drag was holding.
  const fixedRight = clamp(rect.x + rect.w, MIN_CROP_SPAN, 1);
  const fixedBottom = clamp(rect.y + rect.h, MIN_CROP_SPAN, 1);

  let maxW = 1;
  let maxH = 1;
  if (holdLeft) maxW = 1 - clamp(x, 0, 1 - MIN_CROP_SPAN);
  else if (holdRight) maxW = fixedRight;
  if (holdTop) maxH = 1 - clamp(y, 0, 1 - MIN_CROP_SPAN);
  else if (holdBottom) maxH = fixedBottom;

  if (ratio) {
    // The fit AND the minimum in ONE uniform factor, because a ratio survives a uniform
    // scale and nothing else.
    //
    // The fit on its own is uniform and was fine. The minimum used to be applied after
    // it, per axis, by the two `Math.max` lines that now live in the `else` — and a fit
    // that drove one axis under MIN_CROP_SPAN then had only THAT axis lifted. So a crop
    // locked to 16:9 came back at some other shape: dragging the north handle to the top
    // of the picture with the bottom edge already 5% from the frame's edge returned a
    // rect whose displayed ratio was 1.07 instead of the 0.5625 the user had chosen, and
    // the lock is not re-applied afterwards, so that shape went into the export.
    //
    // Same construction as the `grow` step in the ratio pass above — clamp a single
    // factor between "big enough for the minimum" and "small enough for the frame" —
    // with the frame fit standing in for its floor of 1. Ordering the three the way it
    // does keeps the same precedence the free path has always had: the minimum beats the
    // fit (the fixed edge shifts by a hair rather than the handles piling up), and the
    // frame beats both, because it is the one constraint with nowhere left to give. On
    // an aspect so extreme that the minimum cannot be reached inside the frame at all,
    // that last cap wins and the rect stays correctly proportioned instead — no preset
    // gets anywhere near it (they would need a displayed ratio beyond 25:1).
    const fit = Math.min(1, maxW / w, maxH / h);
    const scale = Math.min(
      Math.max(MIN_CROP_SPAN / w, MIN_CROP_SPAN / h, fit),
      1 / w,
      1 / h
    );
    w *= scale;
    h *= scale;
  } else {
    w = Math.max(Math.min(w, maxW), MIN_CROP_SPAN);
    h = Math.max(Math.min(h, maxH), MIN_CROP_SPAN);
  }

  // Re-seat the held edge, now that the span is final.
  if (holdRight) x = fixedRight - w;
  if (holdBottom) y = fixedBottom - h;

  return {
    x: clamp(x, 0, Math.max(0, 1 - w)),
    y: clamp(y, 0, Math.max(0, 1 - h)),
    w,
    h,
  };
}

/** The largest frame rect of the given ratio that fits, centred. */
export function centeredFrameRect(frameWidth, frameHeight, ratio) {
  if (!ratio) return { ...FULL_CROP };
  const frameRatio = frameWidth / frameHeight;
  let w = 1;
  let h = 1;
  if (frameRatio > ratio) w = ratio / frameRatio;
  else h = frameRatio / ratio;
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

// ── The compositor ───────────────────────────────────────────────────────────

/**
 * Put the canvas into SOURCE-PIXEL space, with the pipeline already applied.
 *
 * After this returns, drawing at source-pixel coordinates lands in the right
 * place on the output canvas and everything outside the crop is off-canvas and
 * clipped by the browser. That is the whole trick: image, strokes and text all
 * go through one transform, so they cannot drift apart, and the preview and the
 * export share the code that computes it.
 */
export function applyEditTransform(ctx, sourceWidth, sourceHeight, edit, output) {
  const c = cropOf(edit);
  const r = normalizeRotation(edit?.rotation);
  const { scale, unrotatedWidth, unrotatedHeight } = output;

  ctx.translate(output.width / 2, output.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.scale(edit?.flipH ? -1 : 1, edit?.flipV ? -1 : 1);
  ctx.translate(-unrotatedWidth / 2, -unrotatedHeight / 2);
  ctx.scale(scale, scale);
  ctx.translate(-c.x * sourceWidth, -c.y * sourceHeight);
}

/** Draw the strokes. Source-pixel space; call inside `applyEditTransform`. */
export function drawStrokes(ctx, strokes, sourceWidth, sourceHeight) {
  if (!strokes || strokes.length === 0) return;
  const shortEdge = Math.max(1, Math.min(sourceWidth, sourceHeight));

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const stroke of strokes) {
    const points = stroke.points;
    if (!points || points.length === 0) continue;
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = Math.max(0.5, stroke.width * shortEdge);

    // A single tap is a dot, and a zero-length path strokes nothing at all —
    // so it is drawn as a filled circle rather than being silently lost.
    if (points.length === 1) {
      ctx.beginPath();
      ctx.fillStyle = stroke.color;
      ctx.arc(points[0].x * sourceWidth, points[0].y * sourceHeight, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x * sourceWidth, points[0].y * sourceHeight);
    // Quadratic midpoint smoothing. A polyline through raw pointer samples is
    // visibly faceted on a coarse pointer, where events arrive every ~16ms and
    // a fast swipe leaves 40px gaps between them.
    for (let i = 1; i < points.length - 1; i += 1) {
      const cx = points[i].x * sourceWidth;
      const cy = points[i].y * sourceHeight;
      const mx = ((points[i].x + points[i + 1].x) / 2) * sourceWidth;
      const my = ((points[i].y + points[i + 1].y) / 2) * sourceHeight;
      ctx.quadraticCurveTo(cx, cy, mx, my);
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x * sourceWidth, last.y * sourceHeight);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Draw the text boxes. Source-pixel space; call inside `applyEditTransform`.
 *
 * ## Text is glued in place but never turned or mirrored
 *
 * A stroke should rotate with the picture — a hand-drawn arrow that stopped
 * pointing at the thing it was drawn on would be wrong. Type should not: mirrored
 * text is unreadable and sideways text is nearly so, and nobody rotating a photo
 * is asking for their caption to end up on its side.
 *
 * So each box translates to its glued source-space point and then undoes the
 * outer transform's rotation and mirroring, leaving only the uniform scale. In
 * canvas terms the current matrix at that point is `s·R·F`; applying `scale(F)`
 * makes it `s·R` (F is its own inverse and s is scalar, so it commutes), and
 * `rotate(-θ)` then makes it `s·I`. Upright, unmirrored, correct size, still
 * anchored to the pixel it was placed on.
 *
 * This is also what lets the editor's drag handles be plain axis-aligned DOM:
 * with the box axis-aligned in output space, no CSS rotation is needed to make
 * the chrome line up with the glyphs.
 */
export function drawTexts(ctx, texts, sourceWidth, sourceHeight, edit, skipId = null) {
  if (!texts || texts.length === 0) return;

  const theta = (normalizeRotation(edit?.rotation) * Math.PI) / 180;
  const fx = edit?.flipH ? -1 : 1;
  const fy = edit?.flipV ? -1 : 1;

  for (const item of texts) {
    if (item.id === skipId) continue;
    if (!item.text) continue;

    ctx.save();
    ctx.translate(item.x * sourceWidth, item.y * sourceHeight);
    ctx.scale(fx, fy);
    ctx.rotate(-theta);

    // Measured only after the font has been set by `measureTextBox`, which is why
    // it is called inside the saved state rather than hoisted above the loop.
    const layout = measureTextBox(ctx, item, sourceWidth, sourceHeight);
    const left = -layout.boxWidth / 2;
    const top = -layout.boxHeight / 2;

    if (item.boxOpacity > 0) {
      ctx.globalAlpha = item.boxOpacity;
      ctx.fillStyle = item.boxColor;
      roundRect(ctx, left, top, layout.boxWidth, layout.boxHeight, layout.pad * 0.9);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = item.color;
    ctx.font = canvasFont(layout.fontPx);
    ctx.textBaseline = 'middle';
    ctx.textAlign = item.align === 'left' ? 'left' : item.align === 'right' ? 'right' : 'center';

    const textX = item.align === 'left'
      ? left + layout.pad
      : item.align === 'right'
        ? left + layout.boxWidth - layout.pad
        : 0;

    layout.lines.forEach((line, index) => {
      const baseline = top + layout.pad + layout.lineHeight * (index + 0.5);
      ctx.fillText(line, textX, baseline);
    });
    ctx.restore();
  }
}

/**
 * The whole composite, onto a caller-supplied 2D context.
 *
 * `output` must be the value `outputPixelSize` returned for the same edit and
 * the same `maxEdge`, and the canvas must already be that size.
 */
export function drawEdit(ctx, image, sourceWidth, sourceHeight, edit, output, options = {}) {
  ctx.save();
  ctx.clearRect(0, 0, output.width, output.height);
  applyEditTransform(ctx, sourceWidth, sourceHeight, edit, output);

  // Smoothing matters here and nowhere else in the app: a 4000px photo drawn
  // into an 800px preview without it aliases badly enough to look broken.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight);

  if (!options.baseOnly) {
    drawStrokes(ctx, edit?.strokes, sourceWidth, sourceHeight);
    drawTexts(ctx, edit?.texts, sourceWidth, sourceHeight, edit, options.skipTextId ?? null);
  }
  ctx.restore();
}

// ── Loading and exporting ────────────────────────────────────────────────────

/**
 * Decode a picked file into something drawable, plus its true pixel size.
 *
 * `imageOrientation: 'from-image'` bakes the EXIF rotation into the pixels, for
 * the same reason `transcodeImage` does it: the orientation tag is lost the
 * moment the bitmap is drawn to a canvas, so without this a portrait phone
 * photo would be edited — and sent — on its side.
 *
 * Falls back to an `<img>` when `createImageBitmap` is missing or refuses the
 * format. The fallback CANNOT honour EXIF orientation on every engine, so it is
 * a fallback rather than the primary path.
 */
export async function loadEditableImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return {
        image: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close?.(),
      };
    } catch {
      // HEIC on a browser with no decoder, or a corrupt file. Try the element.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const element = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This image could not be opened for editing'));
      img.decoding = 'sync';
      img.src = url;
    });
    return {
      image: element,
      width: element.naturalWidth,
      height: element.naturalHeight,
      release: () => URL.revokeObjectURL(url),
    };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * What an edited image should be saved as.
 *
 * PNG for sources that may carry alpha or crisp UI pixels (a cropped screenshot
 * re-encoded to JPEG picks up ringing around every glyph), JPEG for photographs.
 * Either way `transcodeImage` runs again at send time and keeps whichever of the
 * two is smaller, so choosing PNG here costs nothing on the wire — it only
 * decides what the tier pass starts from.
 */
export function outputFormatFor(file) {
  const mime = (file?.type || '').toLowerCase();
  const name = (file?.name || '').toLowerCase();
  const lossless = mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif'
    || /\.(png|webp|gif)$/.test(name);
  return lossless
    ? { mimeType: 'image/png', extension: 'png', quality: undefined }
    : { mimeType: 'image/jpeg', extension: 'jpg', quality: 0.92 };
}

/** Longest edge an exported edit is fitted inside. Above HD's 3024 so the tier pass still has room to work. */
export const EXPORT_MAX_EDGE = 4096;

/**
 * Above this, a lossless export is re-done as JPEG.
 *
 * A 4096px PNG of a photograph can run to 30 MB, and the composer's own
 * client-side image ceiling is 16 MB (MessageComposer.jsx). The tier pass at
 * send time would shrink it anyway, but a staged file that large makes the
 * measured-size label beside the send button alarming for no reason.
 */
const LOSSLESS_BUDGET = 8 * 1024 * 1024;

/**
 * Bake original + edit into a new `File`.
 *
 * The returned file is what `handleConfirmSend` uploads; the original is kept by
 * the caller, so Revert and a second editing pass are both free.
 *
 * NOTE on the interaction with `transcodeImage`: that runs again at send time on
 * whatever this returns, and its keep-the-smaller rule compares the re-encode
 * against THIS file — never against the untouched original, which it has never
 * seen. So there is no path by which the tier pass can resurrect the uncropped
 * bytes. Folding the crop into `transcodeImage` instead would have had exactly
 * that bug.
 */
export async function renderEditedFile(file, edit, options = {}) {
  const maxEdge = options.maxEdge ?? EXPORT_MAX_EDGE;
  const loaded = options.loaded ?? await loadEditableImage(file);
  const ownsImage = !options.loaded;

  try {
    const output = outputPixelSize(loaded.width, loaded.height, edit, maxEdge);
    const canvas = createCanvas(output.width, output.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser could not prepare the edited image');

    drawEdit(ctx, loaded.image, loaded.width, loaded.height, edit, output);

    let format = outputFormatFor(file);
    let blob = await canvasToBlob(canvas, format.mimeType, format.quality);
    if (blob && format.mimeType === 'image/png' && blob.size > LOSSLESS_BUDGET) {
      const jpeg = await canvasToBlob(canvas, 'image/jpeg', 0.92);
      if (jpeg && jpeg.size < blob.size) {
        blob = jpeg;
        format = { mimeType: 'image/jpeg', extension: 'jpg', quality: 0.92 };
      }
    }
    if (!blob) throw new Error('The edited image could not be saved');

    const base = (file.name || 'image').replace(/\.[^.]+$/, '');
    // The extension has to match the bytes: the server derives the stored MIME
    // type from it and ignores what we claim (backend/app/api/media.py:133).
    const edited = new File([blob], `${base}.${format.extension}`, {
      type: format.mimeType,
      lastModified: Date.now(),
    });
    return { file: edited, width: output.width, height: output.height };
  } finally {
    if (ownsImage) loaded.release?.();
  }
}

// ── Small shared helpers ─────────────────────────────────────────────────────

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function createCanvas(width, height) {
  // A plain canvas, not OffscreenCanvas: `convertToBlob` is unavailable on
  // Safari's OffscreenCanvas and this path has to produce bytes on every engine.
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

export function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mimeType, quality);
  });
}

/** `#RRGGBB` + alpha → `rgba(...)`, for the editor's in-place text box chrome. */
export function hexWithAlpha(hex, alpha) {
  const rgb = hexToRgb(hex) || [0, 0, 0];
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1)})`;
}

export function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function rgbToHex(r, g, b) {
  const hex = (v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`.toUpperCase();
}

function hexToRgb(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return [(int >> 16) & 0xFF, (int >> 8) & 0xFF, int & 0xFF];
}

function hslToRgb(hue, saturation, lightness) {
  const h = ((hue % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0]
    : h < 120 ? [x, c, 0]
    : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c]
    : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function rgbToHue(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let hue;
  if (max === r) hue = ((g - b) / d) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}
