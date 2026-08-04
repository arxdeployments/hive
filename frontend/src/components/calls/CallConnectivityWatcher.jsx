import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import useCallStore, { isCallStalled } from '../../stores/callStore';

/**
 * The one place that turns call connectivity into words.
 *
 * Mounted at App level next to CallAudioSink, deliberately NOT inside a call view:
 * every call view unmounts when the call is minimised, and a connectivity warning
 * is at its most useful precisely when the user has minimised the call and is doing
 * something else. It renders nothing — the "Connecting…" label lives in the call
 * chrome; this owns the transient messages.
 *
 * Everything here is throttled and edge-triggered. Connection quality flaps by
 * design (LiveKit re-evaluates it every couple of seconds), so a naive `useEffect`
 * on the value would paper the screen with identical toasts during exactly the
 * moment the user most needs to read one.
 */

// One poor-network toast per this window, however many times quality flaps.
const POOR_TOAST_COOLDOWN_MS = 20000;
// A stall has to persist before it is worth mentioning: LiveKit recovers most
// interruptions inside a second, and a toast for every one of those is noise that
// makes the app feel broken when it is in fact working.
const STALL_ANNOUNCE_DELAY_MS = 1500;

const POOR_MESSAGE = 'Poor internet connection';
const STALLED_MESSAGE = 'Connection lost — reconnecting…';
const RESTORED_MESSAGE = 'Connection restored';

export const CallConnectivityWatcher = () => {
  const lastPoorToastAt = useRef(0);
  const stallTimer = useRef(null);
  const announcedStall = useRef(false);
  const toastId = useRef(null);

  useEffect(() => {
    const clearStallTimer = () => {
      if (stallTimer.current) {
        clearTimeout(stallTimer.current);
        stallTimer.current = null;
      }
    };

    const dismiss = () => {
      if (toastId.current !== null) {
        toast.dismiss(toastId.current);
        toastId.current = null;
      }
    };

    // Subscribed imperatively rather than through a selector hook so this component
    // never re-renders — it has no output, and a render per quality change during a
    // call is pure waste.
    const unsubscribe = useCallStore.subscribe((state, prev) => {
      const live = state.callState !== 'idle' && state.callState !== 'ended';

      if (!live) {
        clearStallTimer();
        if (announcedStall.current) dismiss();
        announcedStall.current = false;
        lastPoorToastAt.current = 0;
        return;
      }

      // ---- Something is wrong with the connection ----------------------------
      const stalled = isCallStalled(state);
      const wasStalled = isCallStalled(prev);

      if (stalled && !wasStalled) {
        clearStallTimer();
        stallTimer.current = setTimeout(() => {
          stallTimer.current = null;
          const current = useCallStore.getState();
          if (!isCallStalled(current)) return;
          announcedStall.current = true;
          // Held open (no duration) because the condition, not a timer, is what
          // ends it — a toast that vanishes while the call is still reconnecting
          // tells the user the problem went away when it did not.
          toastId.current = toast.loading(STALLED_MESSAGE, { id: 'call-connectivity' });
        }, STALL_ANNOUNCE_DELAY_MS);
      } else if (!stalled && wasStalled) {
        clearStallTimer();
        if (announcedStall.current) {
          announcedStall.current = false;
          toastId.current = null;
          toast.success(RESTORED_MESSAGE, { id: 'call-connectivity', duration: 2500 });
        }
      }

      // ---- Degraded but still connected --------------------------------------
      //
      // Either end's poor uplink is worth saying, and the sentence is the same
      // either way: the user cannot act on whose leg it is, only on the fact that
      // the call is struggling. Suppressed while a stall is being reported, since
      // "reconnecting" already says something stronger.
      if (stalled) return;
      const anyPoor = state.networkQuality === 'poor'
        || Object.values(state.peerStates).some((p) => p?.quality === 'poor');
      const wasPoor = prev.networkQuality === 'poor'
        || Object.values(prev.peerStates).some((p) => p?.quality === 'poor');
      if (anyPoor && !wasPoor) {
        const now = Date.now();
        if (now - lastPoorToastAt.current > POOR_TOAST_COOLDOWN_MS) {
          lastPoorToastAt.current = now;
          toast.warning(POOR_MESSAGE, { id: 'call-quality', duration: 4000 });
        }
      }
    });

    return () => {
      unsubscribe();
      clearStallTimer();
      dismiss();
    };
  }, []);

  return null;
};

export default CallConnectivityWatcher;
