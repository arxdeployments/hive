import React from 'react';
import { Mic, Send, Trash2, Square, Loader2 } from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
import { formatDuration } from '../../utils/audioFormat';

/**
 * Replaces the composer row while a voice note is being recorded or reviewed.
 *
 * Two stages, deliberately distinct:
 *   recording — pulsing dot, live elapsed time, discard, stop.
 *   preview   — the same AudioPlayer the bubble uses, so what you hear before
 *               sending is exactly what the recipient gets, plus discard/send.
 *
 * Nothing is uploaded until Send: discard at either stage costs one round trip of
 * nothing, matching the confirmation model the file picker now uses.
 */
export const AudioRecorderBar = ({
  stage,
  elapsed,
  result,
  onCancel,
  onStop,
  onSend,
  sending = false,
}) => {
  const recording = stage === 'recording';

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 bg-[#141414] border-t border-[#1F1F1F]"
      data-testid="audio-recorder-bar"
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
          src={result?.url}
          fallbackDuration={result?.duration}
          className="flex-1 min-w-0"
        />
      )}

      {recording ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop recording"
          title="Stop"
          data-testid="audio-stop-btn"
          className="w-10 h-10 rounded-full bg-[#EF4444] text-white flex items-center justify-center hover:opacity-90 transition-opacity flex-shrink-0"
        >
          <Square size={16} />
        </button>
      ) : (
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
