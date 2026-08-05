import { useEffect, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, Lock, LockOpen, Mic, Pause, Send, Trash2, Loader2 } from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
import { LiveWaveform } from './Waveform';
import { formatDuration } from '../../utils/audioFormat';

/**
 * Replaces the composer row while a voice note is being recorded or reviewed.
 *
 * THREE stages:
 *   recording — pulsing dot, live elapsed, discard / pause / finish.
 *   paused    — the same AudioPlayer the bubble uses, playing back what has been
 *               captured so far, plus Resume to carry on into the SAME take.
 *   preview   — the finished recording, awaiting send.
 *
 * Pause and finish are separate controls on purpose. Reviewing mid-recording and
 * ending a recording are different intentions, and collapsing them into one
 * button would mean the only way to hear yourself was to commit to having
 * stopped. Resume appends rather than starting a second take — see
 * useAudioRecorder for why concatenating two files is not an option.
 *
 * Nothing is uploaded until Send: discard at any stage costs one round trip of
 * nothing, matching the confirmation model the file picker uses.
 */
export const AudioRecorderBar = ({
  stage,
  elapsed,
  result,
  stream,
  onCancel,
  onPause,
  onResume,
  onStop,
  onSend,
  sending = false,
  /* Live gesture state, present only on touch. `hold` means a finger is down on
     the mic and the recording is following it. */
  hold = null,
}) => {
  const recording = stage === 'recording';
  const paused = stage === 'paused';

  /**
   * Whether the mid-recording preview can actually be played.
   *
   * Not a Safari-only problem, despite how it is usually described.
   * pickAudioFormat puts audio/mp4 FIRST because the backend classifies .webm
   * as video and AAC-in-MP4 is the only universally playable output — and an
   * MP4's moov atom is written on STOP. Current Chrome supports recording MP4
   * too, so both browsers hand back a partial blob no player can open. Only
   * Firefox, which falls through to Ogg/Opus, reliably previews mid-recording.
   *
   * So the control is made honest rather than left dead: the player is replaced
   * by a line saying the review is only available once the recording is
   * finished. Resume and Send both still work — only the review is unavailable.
   */
  const [previewBroken, setPreviewBroken] = useState(false);
  // A new take, or a resumed one, deserves a fresh attempt.
  useEffect(() => { setPreviewBroken(false); }, [result?.url]);

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 bg-[#141414] border-t border-[#1F1F1F]"
      data-testid="audio-recorder-bar"
      data-stage={stage}
    >
      <button
        type="button"
        onClick={onCancel}
        disabled={sending}
        aria-label="Discard recording"
        title="Discard"
        data-testid="audio-discard-btn"
        className="w-9 h-9 rounded-full flex items-center justify-center text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors flex-shrink-0 disabled:opacity-40"
      >
        <Trash2 size={18} />
      </button>

      {recording && hold?.held && !hold.locked ? (
        /* Finger down. The strip fades toward the cancel threshold rather than
           flipping at it, so the gesture is legible before it commits, and the
           "slide to cancel" label trails the thumb at half rate. */
        <div
          className="flex-1 flex items-center gap-2 min-w-0"
          data-testid="hold-to-talk-strip"
          data-cancel-armed={hold.cancelArmed || undefined}
          style={{ opacity: hold.cancelArmed ? 0.35 : 1 - Math.min(0.6, -hold.drag.x / 200) }}
        >
          <span aria-hidden="true" className="w-2 h-2 rounded-full bg-[#EF4444] animate-pulse flex-shrink-0" />
          <span className="text-sm text-[#F5F5F5] tabular-nums flex-shrink-0" aria-live="polite">
            {formatDuration(elapsed)}
          </span>
          <div className="flex-1 min-w-0 flex items-center justify-center">
            <span
              className="flex items-center gap-1 text-xs text-[#A3A3A3] whitespace-nowrap"
              style={{ transform: `translateX(${Math.max(-60, hold.drag.x * 0.5)}px)` }}
            >
              <ChevronLeft size={12} /> slide to cancel
            </span>
          </div>
          {/* Lock affordance, riding upward with the drag. Fills in at 75% of
              the threshold so the user knows it is about to take. */}
          <span
            className="flex-shrink-0 text-[#10B981]"
            style={{ transform: `translateY(${Math.max(-40, hold.drag.y * 0.6)}px)`, opacity: 0.4 + hold.lockProgress * 0.6 }}
            data-testid="hold-lock-affordance"
          >
            {hold.lockProgress > 0.75 ? <Lock size={16} /> : <LockOpen size={16} />}
          </span>
        </div>
      ) : recording ? (
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span
            aria-hidden="true"
            className="w-2 h-2 rounded-full bg-[#EF4444] animate-pulse flex-shrink-0"
          />
          <Mic size={16} className="text-[#EF4444] flex-shrink-0" />
          <span
            className="text-sm text-[#F5F5F5] tabular-nums flex-shrink-0"
            data-testid="audio-elapsed"
            aria-live="polite"
          >
            {formatDuration(elapsed)}
          </span>
          {/* Replaces a static "Recording…" label. Reading your own voice back
              as moving bars is the only feedback that the microphone is
              actually picking you up — a timer ticking up looks identical
              whether the input is live or muted. */}
          <LiveWaveform stream={stream} className="flex-1 min-w-0" />
        </div>
      ) : (
        previewBroken || (paused && !result) ? (
          <div
            className="flex-1 min-w-0 flex items-center gap-2 px-1"
            data-testid="audio-preview-unavailable"
          >
            <AlertTriangle size={14} className="text-[#F59E0B] flex-shrink-0" />
            <span className="text-xs text-[#A3A3A3] leading-tight">
              Review is available once you finish recording.
            </span>
          </div>
        ) : (
          <AudioPlayer
            // Keyed on the object URL so pausing again after resuming mounts a
            // fresh element. Reusing one across a src swap leaves the old buffered
            // audio playing and the scrubber pointing at the previous take.
            key={result?.url || 'empty'}
            src={result?.url}
            fallbackDuration={result?.duration}
            onUnplayable={() => setPreviewBroken(true)}
            className="flex-1 min-w-0"
          />
        )
      )}

      {recording && (
        <>
          <button
            type="button"
            onClick={onPause}
            aria-label="Pause and review"
            title="Pause and review"
            data-testid="audio-pause-btn"
            className="w-9 h-9 rounded-full flex items-center justify-center text-[#F5F5F5] bg-[#2D2D2D] hover:bg-[#3A3A3A] transition-colors flex-shrink-0"
          >
            <Pause size={16} />
          </button>
          <button
            type="button"
            onClick={onStop}
            aria-label="Finish recording"
            title="Finish"
            data-testid="audio-stop-btn"
            className="w-10 h-10 rounded-full bg-[#EF4444] text-white flex items-center justify-center hover:opacity-90 transition-opacity flex-shrink-0"
          >
            <Check size={18} />
          </button>
        </>
      )}

      {paused && (
        <button
          type="button"
          onClick={onResume}
          aria-label="Resume recording"
          title="Resume recording"
          data-testid="audio-resume-btn"
          className="w-9 h-9 rounded-full flex items-center justify-center text-white bg-[#EF4444] hover:opacity-90 transition-opacity flex-shrink-0"
        >
          <Mic size={16} />
        </button>
      )}

      {!recording && (
        <button
          type="button"
          onClick={onSend}
          disabled={sending}
          aria-busy={sending}
          aria-label={sending ? 'Sending voice message' : 'Send voice message'}
          data-testid="audio-send-btn"
          className="w-10 h-10 rounded-full bg-[#10B981] text-white flex items-center justify-center hover:bg-[#059669] disabled:opacity-50 transition-colors flex-shrink-0"
        >
          {sending ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      )}
    </div>
  );
};

export default AudioRecorderBar;
