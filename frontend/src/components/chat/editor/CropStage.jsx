import React, { useCallback, useMemo, useRef, useState } from 'react';
import { FlipHorizontal, FlipVertical, RotateCcw, RotateCw } from 'lucide-react';
import {
  ASPECT_PRESETS,
  FULL_CROP,
  centeredFrameRect,
  clamp,
  clampCrop,
  clampFrameRect,
  cropOf,
  frameSize,
  isQuarterTurned,
  normalizeRotation,
  rectFrameToSource,
  rectSourceToFrame,
} from '../../../utils/mediaEdit';
import {
  AspectRow,
  Chip,
  EditedCanvas,
  ToolButton,
  capturePointer,
  releasePointer,
  useFittedBox,
} from './editorKit';

/**
 * The crop stage.
 *
 * ## It shows the whole picture, not the crop
 *
 * The base canvas here is rendered with `crop: null` — rotation and flips
 * applied, crop deliberately not — because a crop UI whose job is to let you
 * decide what to cut away cannot hide what is being cut away. The crop rect is
 * an overlay on top, and everything outside it is dimmed by a single enormous
 * `box-shadow` spread rather than four positioned scrims.
 *
 * ## Dragging happens in FRAME space
 *
 * The model stores the crop in source-image coordinates, but the user drags it on
 * the rotated, flipped picture in front of them. So every gesture converts:
 * `rectSourceToFrame` on the way in, `rectFrameToSource` on the way out — both
 * built out of `mediaEdit`'s point converters, so a handle cannot end up
 * describing a different rectangle than the exporter will cut.
 *
 * A locked aspect ratio is also applied in frame space, where it means what it
 * says: displayed pixel width over displayed pixel height. Applying it in source
 * space needs an inversion for a quarter-turned image, which is precisely the
 * sign error that ships as "16:9 gave me 9:16".
 *
 * ## The delta is measured from where the drag started
 *
 * `startRef` captures the rect at pointer-down and every move recomputes from
 * `start + totalDelta`, rather than accumulating frame-to-frame. Accumulating
 * drifts: each intermediate rect is clamped, and clamping a clamped value fifty
 * times a second walks the rect away from the finger.
 */

const HANDLES = [
  { key: 'nw', className: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2', cursor: 'nwse-resize' },
  { key: 'n', className: 'left-1/2 top-0 -translate-x-1/2 -translate-y-1/2', cursor: 'ns-resize' },
  { key: 'ne', className: 'right-0 top-0 translate-x-1/2 -translate-y-1/2', cursor: 'nesw-resize' },
  { key: 'e', className: 'right-0 top-1/2 translate-x-1/2 -translate-y-1/2', cursor: 'ew-resize' },
  { key: 'se', className: 'right-0 bottom-0 translate-x-1/2 translate-y-1/2', cursor: 'nwse-resize' },
  { key: 's', className: 'left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2', cursor: 'ns-resize' },
  { key: 'sw', className: 'left-0 bottom-0 -translate-x-1/2 translate-y-1/2', cursor: 'nesw-resize' },
  { key: 'w', className: 'left-0 top-1/2 -translate-x-1/2 -translate-y-1/2', cursor: 'ew-resize' },
];

const ratioForKey = (key) => ASPECT_PRESETS.find((p) => p.key === key)?.ratio ?? null;

export const CropStage = ({
  image,
  sourceWidth,
  sourceHeight,
  edit,
  onEdit,
  onCommit,
  aspectKey,
  onAspectKey,
}) => {
  // `crop: null` for the base render — see the header.
  //
  // Memoised on everything EXCEPT the crop, deliberately. Keyed on `edit` it would get a
  // new identity on every pointermove of a drag, and `EditedCanvas` would repaint the
  // whole picture sixty times a second to produce the identical bitmap.
  const uncropped = useMemo(
    () => ({ ...edit, crop: null }),
    [edit.rotation, edit.flipH, edit.flipV, edit.strokes, edit.texts]
  );
  const frame = useMemo(() => frameSize(sourceWidth, sourceHeight, edit), [sourceWidth, sourceHeight, edit]);
  const { ref: stageRef, box } = useFittedBox(frame.width / frame.height, 28);

  const frameRect = useMemo(() => rectSourceToFrame(cropOf(edit), edit), [edit]);
  const ratio = ratioForKey(aspectKey);

  const startRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  const writeFrameRect = useCallback((rect) => {
    onEdit((prev) => ({ ...prev, crop: clampCrop(rectFrameToSource(rect, prev)) }));
  }, [onEdit]);

  const beginDrag = (anchor) => (event) => {
    event.preventDefault();
    event.stopPropagation();
    capturePointer(event);
    // History is pushed HERE, before the first write — `pushHistory` records the
    // CURRENT model, so committing at the end of the drag would store the rect the
    // drag produced and Undo's first press would restore what is already on screen.
    // One push per gesture, at the start of it.
    onCommit?.();
    startRef.current = { anchor, rect: frameRect, origin: { x: event.clientX, y: event.clientY } };
    setDragging(true);
  };

  const onPointerMove = (event) => {
    const start = startRef.current;
    if (!start || !box.width || !box.height) return;
    const dx = (event.clientX - start.origin.x) / box.width;
    const dy = (event.clientY - start.origin.y) / box.height;

    if (start.anchor === 'move') {
      // A move never changes the size, so it never needs the ratio pass.
      writeFrameRect({
        x: clamp(start.rect.x + dx, 0, 1 - start.rect.w),
        y: clamp(start.rect.y + dy, 0, 1 - start.rect.h),
        w: start.rect.w,
        h: start.rect.h,
      });
      return;
    }

    let next = { ...start.rect };
    if (start.anchor.includes('w')) { next.x = start.rect.x + dx; next.w = start.rect.w - dx; }
    if (start.anchor.includes('e')) { next.w = start.rect.w + dx; }
    if (start.anchor.includes('n')) { next.y = start.rect.y + dy; next.h = start.rect.h - dy; }
    if (start.anchor.includes('s')) { next.h = start.rect.h + dy; }
    // Dragged past the opposite edge: fold the rect rather than letting a
    // negative span through, which would render inside-out.
    if (next.w < 0) { next.x += next.w; next.w = -next.w; }
    if (next.h < 0) { next.y += next.h; next.h = -next.h; }

    writeFrameRect(clampFrameRect(next, frame.width, frame.height, ratio, start.anchor));
  };

  const endDrag = (event) => {
    if (!startRef.current) return;
    releasePointer(event);
    startRef.current = null;
    setDragging(false);
  };

  // ── Rotate / flip / reset ─────────────────────────────────────────────────

  const rotate = (delta) => {
    onCommit?.();
    onEdit((prev) => {
      const rotation = normalizeRotation((prev.rotation || 0) + delta);
      if (!ratio) return { ...prev, rotation };
      // A quarter turn inverts the frame's own aspect, so a rect locked to 16:9
      // is no longer 16:9 of what is on screen. Re-fit rather than silently
      // leaving the lock broken.
      const rotated = { ...prev, rotation };
      const rotatedFrame = frameSize(sourceWidth, sourceHeight, rotated);
      const fitted = centeredFrameRect(rotatedFrame.width, rotatedFrame.height, ratio);
      return { ...rotated, crop: clampCrop(rectFrameToSource(fitted, rotated)) };
    });
  };

  /**
   * Flip what the user can see.
   *
   * The pipeline applies flips BEFORE rotation, so on a quarter-turned image the
   * axis the user is pointing at is the other one. Swapping here keeps the button
   * honest; doing it in the model would mean the exporter and the preview
   * disagreeing about what `flipH` means.
   */
  const flip = (axis) => {
    onCommit?.();
    onEdit((prev) => {
      const swap = isQuarterTurned(prev);
      const key = (axis === 'h') === !swap ? 'flipH' : 'flipV';
      return { ...prev, [key]: !prev[key] };
    });
  };

  const reset = () => {
    onCommit?.();
    onAspectKey('free');
    onEdit((prev) => ({ ...prev, crop: { ...FULL_CROP }, rotation: 0, flipH: false, flipV: false }));
  };

  const pickAspect = (key) => {
    onCommit?.();
    onAspectKey(key);
    const nextRatio = ratioForKey(key);
    if (!nextRatio) return;
    onEdit((prev) => {
      const prevFrame = frameSize(sourceWidth, sourceHeight, prev);
      const fitted = centeredFrameRect(prevFrame.width, prevFrame.height, nextRatio);
      return { ...prev, crop: clampCrop(rectFrameToSource(fitted, prev)) };
    });
  };

  const cropPixels = useMemo(() => {
    const c = cropOf(edit);
    const w = Math.round(c.w * sourceWidth);
    const h = Math.round(c.h * sourceHeight);
    return isQuarterTurned(edit) ? `${h} × ${w}` : `${w} × ${h}`;
  }, [edit, sourceWidth, sourceHeight]);

  return (
    <>
      <div ref={stageRef} className="flex-1 min-h-0 flex items-center justify-center px-4">
        {box.width > 0 && (
          <div
            className="relative select-none"
            style={{ width: box.width, height: box.height, touchAction: 'none' }}
            data-testid="editor-crop-stage"
          >
            <EditedCanvas
              image={image}
              sourceWidth={sourceWidth}
              sourceHeight={sourceHeight}
              edit={uncropped}
              width={box.width}
              height={box.height}
              className="rounded-[4px]"
            />

            {/* The crop window. One spread shadow dims everything outside it —
                four scrims would need four more layout calculations that could
                disagree with each other by a pixel. */}
            <div
              className="absolute"
              style={{
                left: frameRect.x * box.width,
                top: frameRect.y * box.height,
                width: frameRect.w * box.width,
                height: frameRect.h * box.height,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.62)',
                outline: '1px solid rgba(255,255,255,0.9)',
                cursor: 'move',
              }}
              onPointerDown={beginDrag('move')}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {/* Rule of thirds, only while a gesture is live — a permanent grid
                  over a photo is noise, and the grid's job is to help place an
                  edge you are currently moving. */}
              {dragging && (
                <>
                  <span className="absolute inset-y-0 left-1/3 w-px bg-white/35 pointer-events-none" />
                  <span className="absolute inset-y-0 left-2/3 w-px bg-white/35 pointer-events-none" />
                  <span className="absolute inset-x-0 top-1/3 h-px bg-white/35 pointer-events-none" />
                  <span className="absolute inset-x-0 top-2/3 h-px bg-white/35 pointer-events-none" />
                </>
              )}

              {/* Corner brackets, for the same reason the reference has them: at
                  a glance they say "this rectangle is the thing you can grab". */}
              {['nw', 'ne', 'se', 'sw'].map((corner) => (
                <span
                  key={`bracket-${corner}`}
                  aria-hidden="true"
                  className={`absolute w-5 h-5 pointer-events-none border-[#10B981] ${
                    corner === 'nw' ? 'left-0 top-0 border-l-[3px] border-t-[3px]'
                      : corner === 'ne' ? 'right-0 top-0 border-r-[3px] border-t-[3px]'
                      : corner === 'se' ? 'right-0 bottom-0 border-r-[3px] border-b-[3px]'
                      : 'left-0 bottom-0 border-l-[3px] border-b-[3px]'
                  }`}
                />
              ))}

              {HANDLES.map((handle) => (
                <span
                  key={handle.key}
                  role="button"
                  tabIndex={-1}
                  aria-label={`Resize crop ${handle.key}`}
                  data-testid={`editor-crop-handle-${handle.key}`}
                  onPointerDown={beginDrag(handle.key)}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  onPointerCancel={endDrag}
                  className={`absolute w-8 h-8 rounded-full ${handle.className}`}
                  style={{ cursor: handle.cursor, touchAction: 'none' }}
                >
                  {/* A 32px touch target with a 12px visible dot inside it: the
                      dot is what reads, the target is what a thumb can hit. */}
                  <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow-[0_1px_4px_rgba(0,0,0,0.7)]" />
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 px-3 pb-3 pt-2 space-y-2">
        <div className="flex items-center gap-1.5 overflow-x-auto scrollable-area">
          <AspectRow value={aspectKey} onChange={pickAspect} />
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <ToolButton icon={RotateCcw} label="Rotate left" onClick={() => rotate(-90)} testId="editor-rotate-left" />
            <ToolButton icon={RotateCw} label="Rotate right" onClick={() => rotate(90)} testId="editor-rotate-right" />
            <ToolButton icon={FlipHorizontal} label="Flip horizontally" onClick={() => flip('h')} testId="editor-flip-h" />
            <ToolButton icon={FlipVertical} label="Flip vertically" onClick={() => flip('v')} testId="editor-flip-v" />
          </div>
          <span className="text-[11px] text-[#A3A3A3] tabular-nums flex-shrink-0" data-testid="editor-crop-size">
            {cropPixels}
          </span>
          <Chip label="Reset" onClick={reset} testId="editor-crop-reset" title="Undo the crop, rotation and flips" />
        </div>
      </div>
    </>
  );
};

export default CropStage;
