import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ASPECT_PRESETS,
  PEN_SIZES,
  SWATCHES,
  clamp,
  croppedPixelSize,
  drawEdit,
  inkForSliderPosition,
  isQuarterTurned,
  sliderGradientStops,
  sliderPositionForInk,
} from '../../../utils/mediaEdit';

/**
 * The shared parts of the pre-send media editor.
 *
 * Everything here is presentation plus one piece of real machinery — the canvas
 * that renders `mediaEdit`'s model — so `MediaEditor`, `CropStage` and
 * `AnnotateStage` can stay about their own interaction and nothing else.
 *
 * ## House style notes
 *
 * The app has no design-token classes wired into Tailwind (`tailwind.config.js`
 * extends only `borderRadius`), so colours here are the same raw arbitrary
 * values the rest of `src/` uses — `#10B981`, `#1A1A1A`, `#2D2D2D`, `#F5F5F5`,
 * `#A3A3A3`. There is also no `type="range"` anywhere in the codebase and
 * `AudioPlayer.jsx` says why ("Bars, not a range input"), so the colour slider
 * is a `role="slider"` div driven by pointer events and
 * `getBoundingClientRect`, following `Waveform.jsx`'s seek control.
 *
 * Every interactive surface that the finger draws or drags on sets
 * `touch-action: none`. That is not optional: `pages/Chat.jsx` installs a
 * document-level non-passive `touchmove` listener which `preventDefault`s
 * anything outside `.scrollable-area`, and the browser's own pan/pinch would
 * otherwise claim the gesture before a pointer event was ever delivered — the
 * same reasoning as `FullscreenImageViewer.jsx` and `MinimizedCallBanner.jsx`.
 */

/**
 * Take the pointer, without letting a refusal abort the gesture.
 *
 * `setPointerCapture` throws `NotFoundError` for a pointer id that is no longer
 * active, and `InvalidStateError` for an element that has just been detached.
 * Both are reachable — a fast release during a re-render, a synthetic event from
 * a test harness — and in every case the right answer is "carry on without
 * capture", not "abandon the handler half-done". `useZoomPan` optional-chains the
 * method for the same class of reason; this also covers the throw.
 */
export function capturePointer(event) {
  try {
    event.currentTarget.setPointerCapture?.(event.pointerId);
  } catch {
    // Capture is an optimisation, not a requirement.
  }
}

export function releasePointer(event) {
  try {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  } catch {
    // Already released, or the pointer is gone.
  }
}

// ── Fitting the media into whatever space is left ────────────────────────────

/**
 * The largest box of a given aspect that fits the measured container.
 *
 * A `ResizeObserver`, not a one-off measurement: the editor's footer changes
 * height when the mode changes and when a text box is selected, and the stage
 * has to re-fit or the crop overlay ends up describing a box that is no longer
 * where the image is.
 */
export function useFittedBox(aspect, inset = 0) {
  const ref = useRef(null);
  const [container, setContainer] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => {
      const rect = node.getBoundingClientRect();
      setContainer({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const box = useMemo(() => {
    const availableWidth = Math.max(0, container.width - inset * 2);
    const availableHeight = Math.max(0, container.height - inset * 2);
    if (!availableWidth || !availableHeight || !aspect || !Number.isFinite(aspect)) {
      return { width: 0, height: 0 };
    }
    let width = availableWidth;
    let height = width / aspect;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * aspect;
    }
    return { width: Math.round(width), height: Math.round(height) };
  }, [container.width, container.height, aspect, inset]);

  return { ref, box, container };
}

/**
 * The `output` descriptor `drawEdit` needs to paint into a box of display pixels.
 *
 * `outputPixelSize` derives its scale from a maximum edge, which is the right
 * question for an export and the wrong one here: the preview has to land on
 * exactly the canvas the layout gave it. `Math.max` of the two axis scales
 * rather than `min`, because the box is fitted to the frame's aspect and the two
 * differ only by a rounding remainder — erring large costs a fraction of a pixel
 * of overscan, erring small leaves a transparent hairline down one edge.
 */
export function outputForDisplay(sourceWidth, sourceHeight, edit, pixelWidth, pixelHeight) {
  const quarter = isQuarterTurned(edit);
  const unrotatedWidth = quarter ? pixelHeight : pixelWidth;
  const unrotatedHeight = quarter ? pixelWidth : pixelHeight;
  const cropped = croppedPixelSize(sourceWidth, sourceHeight, edit);
  const scale = Math.max(unrotatedWidth / cropped.width, unrotatedHeight / cropped.height);
  return {
    width: pixelWidth,
    height: pixelHeight,
    scale,
    unrotatedWidth,
    unrotatedHeight,
  };
}

/** Capped at 2: a 3x display would otherwise back a full-bleed canvas with 9x the pixels. */
const maxDevicePixelRatio = () => Math.min(2, window.devicePixelRatio || 1);

/**
 * The live preview.
 *
 * Renders through the SAME `drawEdit` the exporter uses, so what the user is
 * looking at is the composite that will be sent — including the text, which is
 * drawn on canvas here rather than as DOM so its wrapping and metrics cannot
 * disagree with the exported bytes. The editor's own text chrome (selection
 * outline, handles, the caret) is separate DOM sitting on top; see
 * `AnnotateStage`.
 */
export const EditedCanvas = ({
  image,
  sourceWidth,
  sourceHeight,
  edit,
  width,
  height,
  baseOnly = false,
  skipTextId = null,
  className = '',
  style,
}) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !width || !height) return;
    const dpr = maxDevicePixelRatio();
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const output = outputForDisplay(sourceWidth, sourceHeight, edit, pixelWidth, pixelHeight);
    drawEdit(ctx, image, sourceWidth, sourceHeight, edit, output, { baseOnly, skipTextId });
  }, [image, sourceWidth, sourceHeight, edit, width, height, baseOnly, skipTextId]);

  return (
    <canvas
      ref={canvasRef}
      className={`block ${className}`}
      style={{ width: `${width}px`, height: `${height}px`, ...style }}
      aria-hidden="true"
    />
  );
};

// ── Buttons ──────────────────────────────────────────────────────────────────

/**
 * A toolbar button.
 *
 * `active` is rendered as the emerald pill the HD toggle uses, so "this tool is
 * selected" reads the same here as "HD is on" does in the tray two layers below.
 */
export const ToolButton = ({
  icon: Icon,
  label,
  onClick,
  active = false,
  disabled = false,
  danger = false,
  size = 18,
  testId,
  children,
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-label={label}
    aria-pressed={active || undefined}
    title={label}
    data-testid={testId}
    className={`flex items-center justify-center gap-1.5 rounded-full transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      children ? 'px-3 h-9 text-[12px] font-medium' : 'w-9 h-9'
    } ${
      active
        ? 'bg-[#10B981] text-[#0A0A0A]'
        : danger
          ? 'text-white/70 hover:text-[#EF4444] hover:bg-[#EF4444]/15'
          : 'text-white/75 hover:text-white bg-white/10 hover:bg-white/20'
    }`}
  >
    {Icon ? <Icon size={size} /> : null}
    {children}
  </button>
);

/** A small text pill — aspect presets, alignment, the transparency toggle. */
export const Chip = ({ label, onClick, active = false, disabled = false, testId, title }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    aria-pressed={active}
    title={title || label}
    data-testid={testId}
    className={`flex-shrink-0 px-2.5 h-7 rounded-[4px] text-[11px] font-medium tabular-nums transition-colors disabled:opacity-40 ${
      active
        ? 'bg-[#10B981]/20 text-[#10B981] border border-[#10B981]/40'
        : 'bg-white/10 text-[#A3A3A3] border border-transparent hover:text-[#F5F5F5]'
    }`}
  >
    {label}
  </button>
);

// ── Pen sizes ────────────────────────────────────────────────────────────────

/**
 * Four discrete widths, shown as four dots.
 *
 * The codebase's own idiom for a small set of values is one cycling button
 * (`AudioPlayer.jsx`'s playback speed, and the reasoning at its :22). Four
 * pens are shown side by side instead, because a pen width is something the user
 * compares — "is that thick enough?" is answered by seeing the alternatives, not
 * by tapping through them — and because it is what the reference app does.
 */
export const PenSizeRow = ({ value, onChange, color }) => (
  <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Pen width">
    {PEN_SIZES.map((pen) => {
      const active = pen.key === value;
      return (
        <button
          key={pen.key}
          type="button"
          role="radio"
          aria-checked={active}
          aria-label={`${pen.label} pen`}
          title={`${pen.label} pen`}
          data-testid={`editor-pen-${pen.key}`}
          onClick={() => onChange(pen.key)}
          className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
            active ? 'bg-white/25 ring-1 ring-white/60' : 'bg-white/10 hover:bg-white/20'
          }`}
        >
          <span
            className="rounded-full block"
            style={{
              width: `${pen.dot}px`,
              height: `${pen.dot}px`,
              backgroundColor: color,
              // A white pen on a translucent white chip needs an edge to be
              // visible at all.
              boxShadow: '0 0 0 1px rgba(0,0,0,0.45)',
            }}
          />
        </button>
      );
    })}
  </div>
);

// ── Colour ───────────────────────────────────────────────────────────────────

/**
 * The ten quick colours, for when the strip is more precision than anyone wants.
 *
 * The coloured circle is a SPAN inside the button rather than the button itself.
 * `index.css` gives every `button` a `min-height: 36px` under 767px — the app's
 * mobile touch-target rule — which turns a `w-6 h-6` button into a 24×36 pill on
 * exactly the devices this feature matters most on. Sizing the target and the dot
 * separately keeps both right, and is what `PenSizeRow` already does.
 *
 * Ten 36px targets overflow a narrow phone, so the row scrolls. `scrollable-area`
 * is load-bearing, not decorative: `pages/Chat.jsx` preventDefaults every touchmove
 * whose ancestors lack that class, so without it the row could not be dragged.
 */
export const SwatchRow = ({ value, onChange }) => (
  <div className="flex items-center gap-1 overflow-x-auto scrollable-area" role="radiogroup" aria-label="Colour">
    {SWATCHES.map((hex) => {
      const active = hex.toUpperCase() === String(value).toUpperCase();
      return (
        <button
          key={hex}
          type="button"
          role="radio"
          aria-checked={active}
          aria-label={`Colour ${hex}`}
          title={hex}
          onClick={() => onChange(hex)}
          className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
        >
          <span
            className={`block w-6 h-6 rounded-full transition-transform ${active ? 'scale-110 ring-2 ring-white' : 'ring-1 ring-white/30'}`}
            style={{ backgroundColor: hex }}
          />
        </button>
      );
    })}
  </div>
);

/**
 * The vertical colour strip.
 *
 * White at the top through black, then a hue ramp — the arrangement the
 * reference uses, and the reason for the grey band is that white and black are
 * the two most-used annotation colours and a pure-hue slider can reach neither.
 * The gradient and the position→colour function both come from `mediaEdit` so the
 * strip cannot drift from the colour it hands back.
 *
 * Pointer events with capture, rather than a `range` input rotated 90°: a rotated
 * native slider mis-reports its own hit area and its thumb cannot be styled to
 * show the colour it has selected, which is the one thing this control has to do.
 */
export const ColorSlider = ({ value, onChange, height = '100%', testId = 'editor-color-slider' }) => {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const position = useMemo(() => sliderPositionForInk(value), [value]);

  const gradient = useMemo(
    () => `linear-gradient(to bottom, ${sliderGradientStops().join(', ')})`,
    []
  );

  const pick = useCallback((clientY) => {
    const node = trackRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (!rect.height) return;
    onChange(inkForSliderPosition(clamp((clientY - rect.top) / rect.height, 0, 1)));
  }, [onChange]);

  const onPointerDown = (event) => {
    event.preventDefault();
    capturePointer(event);
    setDragging(true);
    pick(event.clientY);
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    pick(event.clientY);
  };

  const stop = (event) => {
    if (!dragging) return;
    releasePointer(event);
    setDragging(false);
  };

  const onKeyDown = (event) => {
    // Arrows step, Home/End jump to white/magenta. A slider that cannot be
    // driven from the keyboard is not reachable at all for some users.
    const step = event.shiftKey ? 0.1 : 0.02;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault();
      onChange(inkForSliderPosition(clamp(position + step, 0, 1)));
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault();
      onChange(inkForSliderPosition(clamp(position - step, 0, 1)));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onChange(inkForSliderPosition(0));
    } else if (event.key === 'End') {
      event.preventDefault();
      onChange(inkForSliderPosition(1));
    }
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Pen colour"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(position * 100)}
      aria-valuetext={value}
      data-testid={testId}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onKeyDown={onKeyDown}
      className="relative w-7 rounded-full cursor-pointer select-none outline-none focus-visible:shadow-[0_0_0_3px_rgba(16,185,129,0.35)]"
      style={{
        height: typeof height === 'number' ? `${height}px` : height,
        background: gradient,
        touchAction: 'none',
        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.25)',
      }}
    >
      {/* The thumb wears the colour it has selected, so the control answers
          "what am I drawing with?" without a second swatch elsewhere. */}
      <span
        className="absolute left-1/2 w-6 h-6 rounded-full pointer-events-none"
        style={{
          top: `${position * 100}%`,
          transform: 'translate(-50%, -50%)',
          backgroundColor: value,
          boxShadow: '0 0 0 2px #FFFFFF, 0 2px 8px rgba(0,0,0,0.6)',
        }}
      />
    </div>
  );
};

// ── Aspect presets ───────────────────────────────────────────────────────────

export const AspectRow = ({ value, onChange }) => (
  <div className="flex items-center gap-1.5 overflow-x-auto scrollable-area" role="radiogroup" aria-label="Aspect ratio">
    {ASPECT_PRESETS.map((preset) => (
      <Chip
        key={preset.key}
        label={preset.label}
        active={preset.key === value}
        onClick={() => onChange(preset.key)}
        testId={`editor-aspect-${preset.key}`}
        title={preset.key === 'free' ? 'Crop freely' : `Lock to ${preset.label}`}
      />
    ))}
  </div>
);

// ── A labelled numeric slider, for type and box size ─────────────────────────

/**
 * Horizontal sibling of `ColorSlider`, for the two independent size controls a
 * text box has: how big the glyphs are, and how wide the box wraps.
 */
export const ValueSlider = ({
  label,
  value,
  min,
  max,
  onChange,
  format,
  testId,
}) => {
  const trackRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const fraction = clamp((value - min) / (max - min), 0, 1);

  const pick = useCallback((clientX) => {
    const node = trackRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    if (!rect.width) return;
    onChange(min + clamp((clientX - rect.left) / rect.width, 0, 1) * (max - min));
  }, [onChange, min, max]);

  const onPointerDown = (event) => {
    event.preventDefault();
    capturePointer(event);
    setDragging(true);
    pick(event.clientX);
  };

  const stop = (event) => {
    if (!dragging) return;
    releasePointer(event);
    setDragging(false);
  };

  const step = (delta) => onChange(clamp(value + delta * (max - min), min, max));

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className="text-[11px] text-[#A3A3A3] flex-shrink-0 w-[52px]">{label}</span>
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(fraction * 100)}
        data-testid={testId}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => { if (dragging) pick(event.clientX); }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') { event.preventDefault(); step(0.04); }
          else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-0.04); }
        }}
        className="relative flex-1 min-w-[80px] h-7 flex items-center cursor-pointer select-none outline-none"
        style={{ touchAction: 'none' }}
      >
        <span className="absolute left-0 right-0 h-1 rounded-full bg-white/20" />
        <span
          className="absolute left-0 h-1 rounded-full bg-[#10B981]"
          style={{ width: `${fraction * 100}%` }}
        />
        <span
          className="absolute w-4 h-4 rounded-full bg-white pointer-events-none"
          style={{ left: `${fraction * 100}%`, transform: 'translateX(-50%)', boxShadow: '0 1px 4px rgba(0,0,0,0.6)' }}
        />
      </div>
      {format ? (
        <span className="text-[11px] text-[#A3A3A3] tabular-nums flex-shrink-0 w-8 text-right">
          {format(value)}
        </span>
      ) : null}
    </div>
  );
};
