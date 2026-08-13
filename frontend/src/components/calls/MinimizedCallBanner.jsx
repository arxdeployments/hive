import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useMotionValue } from 'framer-motion';
import { Mic, MicOff, PhoneOff, Video } from 'lucide-react';
import useCallStore, { isCallStalled, formatCallDuration } from '../../stores/callStore';
import livekitClient from '../../services/livekitLazy';
import wsClient from '../../services/websocket';
import { StreamVideo } from './StreamVideo';

/**
 * The minimised call: a DRAGGABLE floating window, not the fixed full-width top
 * bar this used to be.
 *
 * The filename and the `minimized-call-banner` test id are kept so nothing else
 * has to move, but the component is otherwise rebuilt:
 *
 *  - Draggable via framer-motion (already a dependency). Its drag is
 *    pointer-event based and sets `touch-action: none` itself, which matters
 *    because Chat.jsx installs a document-level non-passive touchmove listener
 *    that preventDefaults anything outside `.scrollable-area` — a hand-rolled
 *    touchmove drag would fight it.
 *  - dragConstraints is a NUMERIC box, not a ref: the element is position:fixed
 *    and so has no measurable container to constrain against.
 *  - Shows the remote video on a video call, choosing the ACTIVE SPEAKER rather
 *    than remoteParticipants[0], so a group call minimises to whoever is talking.
 *  - Carries end-call and mute, so hanging up no longer requires restoring first.
 *  - Visible during `connecting` and `outgoing_ringing` too. It previously
 *    required `connected` while ActiveCallView hides on isMinimized, so
 *    minimising a still-connecting call showed NOTHING, with no way back.
 *
 * Restore is a tap on the body. A `didDrag` ref suppresses the click that follows
 * a drag — otherwise letting go after moving the window yanks the user to full
 * screen.
 *
 * No <audio> here, deliberately: remote audio is played by exactly one element
 * per participant in CallAudioSink, mounted at App level. Adding one here would
 * double-play and echo.
 */

const POSITION_KEY = 'rxhive_mini_call_pos';

// Kept in sync with the rendered size below — the constraint box needs real numbers.
const SIZE = {
  video: { w: 132, h: 184 },
  voice: { w: 216, h: 76 },
};
const EDGE = 12;

const readStoredPosition = () => {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') return parsed;
  } catch {
    /* corrupt value — fall back to the default corner */
  }
  return null;
};

export const MinimizedCallBanner = () => {
  const callState = useCallStore((s) => s.callState);
  const callType = useCallStore((s) => s.callType);
  const callDuration = useCallStore((s) => s.callDuration);
  const isMinimized = useCallStore((s) => s.isMinimized);
  const incomingCaller = useCallStore((s) => s.incomingCaller);
  const isMuted = useCallStore((s) => s.isMuted);
  const callId = useCallStore((s) => s.callId);
  const remoteParticipants = useCallStore((s) => s.remoteParticipants);
  const activeSpeakerIds = useCallStore((s) => s.activeSpeakerIds);
  const storedPosition = useCallStore((s) => s.miniPosition);
  // A minimised call is exactly when a user most needs to be told the connection
  // has gone: they are looking at something else and would otherwise discover it
  // by talking into silence.
  const reconnecting = useCallStore(isCallStalled);

  const isVideo = callType === 'video';
  const size = isVideo ? SIZE.video : SIZE.voice;

  // Default corner: bottom-right, clear of the composer.
  const seed = storedPosition
    || readStoredPosition()
    || {
      x: Math.max(EDGE, (typeof window === 'undefined' ? 1024 : window.innerWidth) - size.w - EDGE),
      y: Math.max(EDGE, (typeof window === 'undefined' ? 768 : window.innerHeight) - size.h - 96),
    };

  const x = useMotionValue(seed.x);
  const y = useMotionValue(seed.y);
  const didDrag = useRef(false);

  const [bounds, setBounds] = useState({ left: EDGE, top: EDGE, right: EDGE, bottom: EDGE });

  // Recompute the constraint box from the viewport, and re-clamp the CURRENT
  // position when the window shrinks — a rotate or resize could otherwise leave
  // the window stranded off-screen with no way to reach it.
  useEffect(() => {
    const recompute = () => {
      const maxX = Math.max(EDGE, window.innerWidth - size.w - EDGE);
      const maxY = Math.max(EDGE, window.innerHeight - size.h - EDGE);
      setBounds({ left: EDGE, top: EDGE, right: maxX, bottom: maxY });
      if (x.get() > maxX) x.set(maxX);
      if (y.get() > maxY) y.set(maxY);
      if (x.get() < EDGE) x.set(EDGE);
      if (y.get() < EDGE) y.set(EDGE);
    };
    recompute();
    window.addEventListener('resize', recompute);
    return () => window.removeEventListener('resize', recompute);
  }, [size.w, size.h, x, y]);

  const persist = useCallback(() => {
    const pos = { x: Math.round(x.get()), y: Math.round(y.get()) };
    useCallStore.getState().setMiniPosition(pos);
    try {
      localStorage.setItem(POSITION_KEY, JSON.stringify(pos));
    } catch {
      /* private mode / quota — the in-memory position still holds this session */
    }
  }, [x, y]);

  const restore = useCallback(() => {
    if (didDrag.current) {
      didDrag.current = false;
      return;
    }
    // Only flips the flag. Never joinCall()/leave() — the room is already joined
    // and leave() would wipe localStream and the screen-share state.
    useCallStore.getState().toggleMinimize();
  }, []);

  const endCall = useCallback((e) => {
    e.stopPropagation();
    livekitClient.leave();
    if (callId) wsClient.send({ type: 'call:end', call_id: callId });
    useCallStore.getState().endCall();
  }, [callId]);

  const toggleMute = useCallback((e) => {
    e.stopPropagation();
    // Target read from the STORE, not from this render's `isMuted`: two taps inside one
    // frame would otherwise both see the same stale flag, ask for the same state, and
    // the second would do nothing. livekitClient moves the flag optimistically and rolls
    // it back if the mic refuses, so the icon still cannot lie beyond the attempt.
    livekitClient.setMicEnabled(useCallStore.getState().isMuted);
  }, []);

  const live = callState === 'connected'
    || callState === 'connecting'
    || callState === 'outgoing_ringing';
  const visible = live && isMinimized;

  // Prefer whoever is speaking; a group call should not always minimise to the
  // first participant who happened to join.
  const speaking = (activeSpeakerIds || [])
    .map((id) => remoteParticipants.find((p) => p.id === id))
    .find(Boolean);
  const shown = speaking || remoteParticipants[0] || null;
  const stream = shown?.screenStream || shown?.stream || null;

  const label = incomingCaller?.display_name
    || shown?.display_name
    || (callState === 'outgoing_ringing' ? 'Calling…' : 'Active call');

  // Reconnecting outranks the duration here for the same reason as in the full
  // view: a clock ticking over dead audio is worse than no clock at all.
  const status = reconnecting
    ? 'Connecting…'
    : callState === 'connected'
      ? formatCallDuration(callDuration)
      : callState === 'outgoing_ringing' ? 'Ringing…' : 'Connecting…';

  return (
    // AnimatePresence WRAPS the conditional. It used to sit below an early
    // `return null`, so unmounting removed the AnimatePresence itself and the
    // exit animation could never run.
    <AnimatePresence>
      {visible && (
        <motion.div
          drag
          dragMomentum={false}
          dragElastic={0}
          dragConstraints={bounds}
          onDragStart={() => { didDrag.current = true; }}
          onDragEnd={persist}
          style={{ position: 'fixed', top: 0, left: 0, x, y, width: size.w }}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          /* Above the chat UI but BELOW IncomingCallOverlay / OutgoingCallScreen
             at z-[9999], so an incoming call is never hidden behind this. */
          className="z-[9998] rounded-[12px] overflow-hidden shadow-2xl bg-[#0F0F0F] border border-[#10B981]/40 cursor-grab active:cursor-grabbing select-none"
          data-testid="minimized-call-banner"
        >
          <button
            type="button"
            onClick={restore}
            aria-label="Return to call"
            data-testid="mini-call-restore"
            className="block w-full text-left"
          >
            {isVideo && stream ? (
              <div className="relative w-full bg-black" style={{ height: size.h - 34 }}>
                <StreamVideo stream={stream} className="w-full h-full object-cover" />
                <span className="absolute top-1 left-1 flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-[#10B981] animate-pulse" />
                  <span className="text-[10px] text-white tabular-nums">{status}</span>
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1">
                <span className="w-8 h-8 rounded-full bg-[#10B981]/15 flex items-center justify-center flex-shrink-0">
                  {isVideo
                    ? <Video size={14} className="text-[#10B981]" />
                    : <Mic size={14} className="text-[#10B981]" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs text-[#F5F5F5] truncate">{label}</span>
                  <span className="block text-[11px] text-[#10B981] tabular-nums">{status}</span>
                </span>
              </div>
            )}
          </button>

          {/* Controls are SIBLINGS of the restore button, not nested inside it —
              nested interactive elements are invalid HTML and the outer click
              would swallow them. Each stopPropagation so acting on a control does
              not also restore the call. */}
          <div className="flex items-center gap-1 px-2 pb-2 pt-1">
            {isVideo && stream && (
              <span className="text-[10px] text-[#A3A3A3] truncate flex-1 min-w-0">{label}</span>
            )}
            <div className="flex items-center gap-1 ml-auto">
              <button
                type="button"
                onClick={toggleMute}
                aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
                title={isMuted ? 'Unmute' : 'Mute'}
                /* NOT `call-mute-btn`: calling.spec.js asserts visibility on that
                   id for the full-screen control. */
                data-testid="mini-call-mute-btn"
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
                  isMuted ? 'bg-[#EF4444] text-white' : 'bg-[#2D2D2D] text-[#F5F5F5] hover:bg-[#3D3D3D]'
                }`}
              >
                {isMuted ? <MicOff size={13} /> : <Mic size={13} />}
              </button>
              <button
                type="button"
                onClick={endCall}
                aria-label="End call"
                title="End call"
                /* NOT `call-end-btn`: that spec asserts it reaches count 0 after a
                   call ends, and a second visible copy would break it. */
                data-testid="mini-call-end-btn"
                className="w-7 h-7 rounded-full bg-[#EF4444] text-white flex items-center justify-center hover:opacity-90 transition-opacity"
              >
                <PhoneOff size={13} />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default MinimizedCallBanner;
