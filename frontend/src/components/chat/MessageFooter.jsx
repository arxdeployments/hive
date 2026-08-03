import React from 'react';
import { Check, CheckCheck, Clock, Star, Pin } from 'lucide-react';

/**
 * A message's trailing metadata: pinned / starred glyphs, the time, the edited
 * marker, and — on your own messages — the delivery tick or a retry control.
 *
 * Extracted from MessageBubble because it now has to render in FOUR different
 * places depending on message type, which one shared block inside the bubble
 * could not do:
 *
 *   beside    text — a sibling of the paragraph in a bottom-aligned row, so a
 *                    short message is "hi  10:24 AM ✓" on ONE line instead of two.
 *   overlaid  photo/video — pinned to the media's bottom-right inside a dark
 *                    scrim, so no band of bubble colour is added under the picture.
 *   inline    a captioned photo/video, or media that failed to render — back to
 *                    its own row, because there is nothing to overlay it onto.
 *   (passed)  audio/document — handed to the card as a prop and rendered on a row
 *                    the card already has, so the fixed-width card is not followed
 *                    by a full-width strip of empty bubble.
 *
 * The scrim on `overlaid` is not decoration: a photo can be white exactly where
 * the timestamp lands, and white-on-white is how the timestamp disappears.
 *
 * WhatsApp tick semantics, unchanged. These only ever render on your own bubble,
 * which is bg-[#10B981] green, so every tick colour is judged against THAT
 * background rather than against the page.
 *
 * The double tick is white. Read is pure white; delivered stays the dimmer
 * white/70 it already was, because the two states share one icon (CheckCheck)
 * and would otherwise be indistinguishable — the brightness step is the only
 * thing left carrying the difference once the colour is common.
 *
 * Measured contrast against #10B981 (WCAG relative luminance):
 *   old read  #53BDEB  1.19:1   <- barely visible; blue on green is near-tonal
 *   new read  #FFFFFF  2.56:1   <- more than twice the contrast
 *   delivered white/70 1.92:1
 */

const StatusIcon = ({ status }) => {
  switch (status) {
    case 'sending':
      return <Clock size={12} className="text-white/50" data-testid="message-status" data-status="sending" aria-label="Sending" />;
    case 'delivered':
      return <CheckCheck size={12} className="text-white/70" data-testid="message-status" data-status="delivered" aria-label="Delivered" />;
    case 'read':
      return <CheckCheck size={12} className="text-white" data-testid="message-status" data-status="read" aria-label="Read" />;
    case 'sent':
    default:
      return <Check size={12} className="text-white/70" data-testid="message-status" data-status="sent" aria-label="Sent" />;
  }
};

const formatTime = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
};

export const MessageFooter = ({
  message,
  isOwn,
  onRetry,
  variant = 'inline',
  className = '',
}) => {
  const overlaid = variant === 'overlaid';
  // On a scrim everything is white regardless of who sent it — the scrim, not
  // the bubble, is what the text sits on.
  const muted = overlaid ? 'text-white/85' : isOwn ? 'text-white/70' : 'text-[#A3A3A3]';

  return (
    <div
      data-testid="message-footer"
      data-variant={variant}
      className={`flex items-center gap-1 flex-shrink-0 ${
        overlaid
          ? 'absolute bottom-1.5 right-1.5 z-[1] px-[7px] py-[3px] rounded-full bg-black/45 backdrop-blur-[2px] pointer-events-none'
          : ''
      } ${className}`}
    >
      {message.is_pinned && (
        <Pin size={11} className={muted} data-testid="message-pinned-indicator" aria-label="Pinned" />
      )}
      {message.is_starred && (
        <Star size={11} fill="currentColor" className={muted} data-testid="message-starred-indicator" aria-label="Starred" />
      )}
      <span className={`text-[11px] whitespace-nowrap ${muted}`}>{formatTime(message.created_at)}</span>
      {message.edited_at && (
        <span className={`text-[11px] whitespace-nowrap ${muted}`} data-testid="edited-indicator">
          · edited
        </span>
      )}
      {isOwn && (
        message.status === 'failed' ? (
          <button
            type="button"
            // pointer-events are off on the overlaid scrim so a tap reaches the
            // photo underneath; the retry control is the one thing that has to
            // stay clickable, so it opts back in.
            onClick={(e) => { e.stopPropagation(); onRetry && onRetry(message); }}
            title="Failed to send. Tap to retry."
            data-testid="message-retry"
            className="pointer-events-auto flex items-center justify-center w-4 h-4 rounded-full bg-[#EF4444] text-white text-[10px] font-bold leading-none hover:bg-[#DC2626] transition-colors"
          >
            !
          </button>
        ) : (
          <StatusIcon status={message.status || 'sent'} />
        )
      )}
    </div>
  );
};

export default MessageFooter;
