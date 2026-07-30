import React from 'react';
import { Check, Mic, Pause, Send, Trash2, Loader2 } from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
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
  onCancel,
  onPause,
  onResume,
  onStop,
  onSend,
  sending = false,
}) => {
  const recording = stage === 'recording';
  const paused = stage === 'paused';

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

      {recording ? (
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span
            aria-hidden="true"
            className="w-2 h-2 rounded-full bg-[#EF4444] animate-pulse flex-shrink-0"
          />
          <Mic size={16} className="text-[#EF4444] flex-shrink-0" />
          <span
            className="text-sm text-[#F5F5F5] tabular-nums"
            data-testid="audio-elapsed"
            aria-live="polite"
          >
            {formatDuration(elapsed)}
          </span>
          <span className="text-xs text-[#525252] truncate">Recording…</span>
        </div>
      ) : (
        <AudioPlayer
          // Keyed on the object URL so pausing again after resuming mounts a
          // fresh element. Reusing one across a src swap leaves the old buffered
          // audio playing and the scrubber pointing at the previous take.
          key={result?.url || 'empty'}
          src={result?.url}
          fallbackDuration={result?.duration}
          className="flex-1 min-w-0"
        />
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
