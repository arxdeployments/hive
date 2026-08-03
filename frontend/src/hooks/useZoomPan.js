import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Zoom and pan for the fullscreen image viewer.
 *
 * Clinical photos and screenshots of documents are exactly the images someone
 * needs to enlarge, and the only recourse on the web was Download.
 *
 * There is no browser equivalent of SwiftUI's MagnificationGesture, so the two
 * halves are built from what a browser does have:
 *
 *   trackpad / mouse — `wheel`. A pinch on a trackpad arrives as a wheel event
 *                      with ctrlKey set, which is how every browser reports it;
 *                      a plain wheel is treated as zoom too, since there is
 *                      nothing to scroll inside a fullscreen viewer.
 *   touch           — two pointers, with the distance between them tracked by
 *                      hand. `touch-action: none` on the surface is required or
 *                      the browser's own page pinch takes the gesture first.
 *
 * Zoom is ANCHORED at the cursor rather than at the image centre: zooming into
 * the middle when the user is pointing at a corner is the thing that makes a
 * homemade zoom feel broken.
 *
 * Panning is only enabled while zoomed in. At scale 1 the pointer is left alone
 * so the viewer's existing click-to-close and swipe-to-page still work — the
 * gesture arbitration iOS needs a single DragGesture for is avoided here by not
 * competing in the first place.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function useZoomPan({ resetKey } = {}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const containerRef = useRef(null);
  const pointers = useRef(new Map());
  const pinchStart = useRef(null);
  const panStart = useRef(null);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Paging must not land the user on a pre-zoomed photo.
  useEffect(() => { reset(); }, [resetKey, reset]);

  /**
   * Apply a scale change while keeping the point under the cursor fixed.
   *
   * The offset correction is what "anchored" means: as the image grows by
   * `ratio`, the vector from the anchor to the current origin grows by the same
   * ratio, so the origin has to move to compensate.
   */
  const zoomAt = useCallback((nextScale, clientX, clientY) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = clientX - rect.left - rect.width / 2;
    const cy = clientY - rect.top - rect.height / 2;

    setScale((prev) => {
      const target = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      const ratio = target / prev;
      setOffset((o) => (target === MIN_SCALE
        ? { x: 0, y: 0 }
        : { x: cx - (cx - o.x) * ratio, y: cy - (cy - o.y) * ratio }));
      return target;
    });
  }, []);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    // deltaY is per-line in some browsers and per-pixel in others; the
    // exponential keeps the step proportional either way, so a big delta does
    // not jump straight to the ceiling.
    setScale((prev) => {
      const target = clamp(prev * Math.exp(-e.deltaY / 400), MIN_SCALE, MAX_SCALE);
      zoomAt(target, e.clientX, e.clientY);
      return prev;
    });
  }, [zoomAt]);

  const onPointerDown = useCallback((e) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchStart.current = {
        distance: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        cx: (a.x + b.x) / 2,
        cy: (a.y + b.y) / 2,
      };
      panStart.current = null;
      return;
    }

    // Single pointer pans only when there is somewhere to pan TO. At scale 1
    // the event is left alone so the overlay's own click handling still runs.
    if (pointers.current.size === 1 && scale > 1) {
      e.currentTarget.setPointerCapture?.(e.pointerId);
      panStart.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    }
  }, [scale, offset]);

  const onPointerMove = useCallback((e) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 2 && pinchStart.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchStart.current.distance > 0) {
        const next = pinchStart.current.scale * (distance / pinchStart.current.distance);
        zoomAt(next, pinchStart.current.cx, pinchStart.current.cy);
      }
      return;
    }

    if (panStart.current) {
      e.preventDefault();
      setOffset({
        x: panStart.current.ox + (e.clientX - panStart.current.x),
        y: panStart.current.oy + (e.clientY - panStart.current.y),
      });
    }
  }, [zoomAt]);

  const endPointer = useCallback((e) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinchStart.current = null;
    if (pointers.current.size === 0) panStart.current = null;
  }, []);

  const onDoubleClick = useCallback((e) => {
    e.stopPropagation();
    if (scale > 1) reset();
    else zoomAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY);
  }, [scale, reset, zoomAt]);

  return {
    scale,
    offset,
    isZoomed: scale > 1,
    reset,
    containerRef,
    /** Spread onto the element that should receive the gestures. */
    handlers: {
      onWheel,
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onPointerLeave: endPointer,
      onDoubleClick,
    },
  };
}

export default useZoomPan;
