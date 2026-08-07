import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hold-to-talk, swipe-up-to-lock and slide-left-to-cancel — for touch only.
 *
 * ADAPTED, not ported. The gesture is entirely doable in a browser with Pointer
 * Events, but a mouse-hold is a poor primary interaction, so this attaches only
 * on COARSE pointers and the existing click-to-start toggle is left untouched
 * for a mouse. On desktop the click flow already IS the locked state.
 *
 * Three things needed real thought that SwiftUI does not have to deal with:
 *
 *  1. THE PERMISSION PROMPT STEALS THE POINTER. The first hold triggers
 *     getUserMedia, whose prompt takes focus and swallows the pointerup — so
 *     release-to-send would never fire and the user would be left recording. The
 *     first grant is therefore treated as a tap-to-start: the gesture arms only
 *     once permission is already held.
 *  2. MediaRecorder HAS START-UP LATENCY. A sub-300ms hold captures a zero-byte
 *     blob, which the hook's empty-blob guard turns into a silent no-op. The
 *     minimum-duration guard in useAudioRecorder is what makes that legible, and
 *     this adds the "hold to record" coaching for the specific case of a tap
 *     that was never a hold.
 *  3. LONG PRESS FIGHTS THE PLATFORM. Mobile Safari raises the selection callout
 *     on a long press, so the surface needs touch-action: none and
 *     -webkit-touch-callout: none, which the caller applies.
 */

/** Travel up, in px, before the recording locks hands-free. */
const LOCK_THRESHOLD = 55;
/** Travel left, in px, before releasing discards instead of sending. */
const CANCEL_THRESHOLD = 90;
/** Under this, the press was a tap and not a hold. */
const MIN_HOLD_MS = 300;

export const isCoarsePointer = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;

export function useHoldToTalk({ onStart, onSend, onCancel, onLock, enabled = true }) {
  const [held, setHeld] = useState(false);
  const [drag, setDrag] = useState({ x: 0, y: 0 });
  const [locked, setLocked] = useState(false);
  const origin = useRef(null);
  const startedAt = useRef(0);
  const armed = useRef(false);
  /**
   * A gesture is owned by the first pointer that lands, until it is released.
   * `held` cannot express that: it is React state, so it has not updated yet
   * while onStart is still awaiting the microphone, and a second finger reads
   * the same stale value.
   *
   * The owning pointer's ID rather than a bare boolean, because move and up have
   * to be scoped to it as well. A boolean keeps a second finger from STARTING a
   * recording, but its release still ran the owner's `onPointerUp` — `held` is
   * true, so a non-owner lifting off sent or discarded the recording the first
   * finger was still holding.
   */
  const ownerRef = useRef(null);
  const [coarse, setCoarse] = useState(false);

  // Read at mount rather than at module load: a hybrid device can change
  // pointer type, and a module-level constant would freeze the first answer.
  useEffect(() => { setCoarse(isCoarsePointer()); }, []);

  const reset = useCallback(() => {
    setHeld(false);
    setLocked(false);
    setDrag({ x: 0, y: 0 });
    origin.current = null;
    armed.current = false;
    ownerRef.current = null;
  }, []);

  const onPointerDown = useCallback(async (e) => {
    if (!enabled || !coarse || e.button !== 0) return;
    e.preventDefault();
    // Read once, up front: everything below the await has to compare against the
    // pointer that started THIS gesture, and `e` is the wrong place to keep that.
    const pointerId = e.pointerId;
    // The recorder refuses a second start while the first is still opening the
    // device, and that refusal comes back as `{ ok: false }` — which the failure
    // path below treats as "nothing to hold" and resets the gesture, disarming
    // the finger that IS holding one. Claiming the gesture synchronously here
    // keeps the second finger out of it entirely, so release-to-send still
    // belongs to the first.
    //
    // A stale owner must never lock the button out, and it can go stale easily: the
    // composer swaps this button for the recorder bar the moment recording starts,
    // so the release often reaches a button that no longer exists and `reset` never
    // runs. `hasPointerCapture` tells the two cases apart — a finger genuinely still
    // down is still captured, while an owner left over from a previous gesture is
    // not. Missing capture support reads as "not held", which gives back the old
    // free-for-all rather than a control that cannot be pressed at all.
    const owner = ownerRef.current;
    if (owner !== null && owner !== pointerId
      && e.currentTarget.hasPointerCapture?.(owner)) return;

    ownerRef.current = pointerId;
    e.currentTarget.setPointerCapture?.(pointerId);

    origin.current = { x: e.clientX, y: e.clientY };
    startedAt.current = Date.now();
    setHeld(true);
    setDrag({ x: 0, y: 0 });

    const res = await onStart?.();
    // The device can take long enough to open that this finger is gone and the
    // NEXT one already owns the gesture — a quick double-tap is all it takes. Both
    // lines below write refs that are no longer this gesture's to write: `reset`
    // would tear down whoever owns it now, and `armed` is worse for being
    // survivable. It outlives the release that should have consumed it, so a later
    // hold reads wasArmed=true and sends a recording that was never started.
    if (ownerRef.current !== pointerId) return;
    // Permission was refused, or the device is unavailable. Nothing to hold.
    if (res && res.ok === false) { reset(); return; }
    // Only arm once the recorder is genuinely running. If the prompt ate the
    // pointerup, `held` is already false by now and this does nothing.
    armed.current = true;
  }, [enabled, coarse, onStart, reset]);

  const onPointerMove = useCallback((e) => {
    if (e.pointerId !== ownerRef.current) return;
    if (!held || !origin.current || locked) return;
    const dx = e.clientX - origin.current.x;
    const dy = e.clientY - origin.current.y;
    setDrag({ x: dx, y: dy });

    // Lock is checked BEFORE cancel so a diagonal drag locks rather than
    // reading as a half-hearted cancel — same ordering as iOS micGesture.
    if (-dy > LOCK_THRESHOLD) {
      setLocked(true);
      onLock?.();
    }
  }, [held, locked, onLock]);

  // Also the pointercancel handler — a non-owner's cancel must not tear down the
  // owner's recording either.
  const onPointerUp = useCallback((e) => {
    if (e.pointerId !== ownerRef.current) return;
    if (!held) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);

    const heldMs = Date.now() - startedAt.current;
    const cancelled = -drag.x > CANCEL_THRESHOLD;
    const wasArmed = armed.current;
    const wasLocked = locked;
    reset();

    // Locked recordings survive the release — that is the point of locking.
    if (wasLocked) return;
    if (!wasArmed) return;

    if (cancelled) { onCancel?.(); return; }
    if (heldMs < MIN_HOLD_MS) {
      // A tap, not a hold. Discarded rather than sent, because a 200ms note is
      // never what was meant, and the coaching says how to do it properly.
      onCancel?.({ tooShort: true });
      return;
    }
    onSend?.();
  }, [held, drag.x, locked, reset, onCancel, onSend]);

  return {
    /** True only where the gesture is actually attached. */
    active: coarse && enabled,
    held,
    locked,
    drag,
    cancelArmed: -drag.x > CANCEL_THRESHOLD,
    lockProgress: Math.min(1, Math.max(0, -drag.y / LOCK_THRESHOLD)),
    handlers: coarse && enabled
      ? {
        onPointerDown,
        onPointerMove,
        onPointerUp,
        onPointerCancel: onPointerUp,
        // The browser context menu on a long press would otherwise interrupt.
        onContextMenu: (e) => e.preventDefault(),
      }
      : {},
    LOCK_THRESHOLD,
    CANCEL_THRESHOLD,
  };
}

export default useHoldToTalk;
