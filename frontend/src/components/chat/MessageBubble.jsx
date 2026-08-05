import { memo, useCallback, useEffect, useRef } from 'react';
import { AlertTriangle, Ban, ChevronDown } from 'lucide-react';
import { ImageBubble } from './ImageBubble';
import { DocumentBubble } from './DocumentBubble';
import { AudioPlayer } from './AudioPlayer';
import { MessageFooter } from './MessageFooter';
import { VideoBubble } from './VideoBubble';

const LONG_PRESS_MS = 500;

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const resolveUrl = (url) => {
  if (!url) return '';
  return url.startsWith('http') ? url : `${backendUrl}${url}`;
};

const SENDER_COLORS = [
  '#F87171', '#FB923C', '#FBBF24', '#A3E635', '#34D399',
  '#22D3EE', '#818CF8', '#C084FC', '#F472B6', '#FB7185'
];

const getSenderColor = (userId) => {
  if (!userId) return SENDER_COLORS[0];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SENDER_COLORS[Math.abs(hash) % SENDER_COLORS.length];
};

// Aggregate reactions for display
const aggregateReactions = (reactions) => {
  const map = {};
  (reactions || []).forEach(r => {
    if (!map[r.emoji]) map[r.emoji] = { emoji: r.emoji, count: 0, users: [], userIds: [] };
    map[r.emoji].count++;
    map[r.emoji].users.push(r.user_name || 'Unknown');
    map[r.emoji].userIds.push(r.user_id);
  });
  return Object.values(map);
};

const replyPreview = (replyMsg) => {
  if (replyMsg.is_deleted) return 'This message was deleted';
  switch (replyMsg.type) {
    case 'image': return '📷 Photo';
    case 'video': return '🎥 Video';
    case 'audio': return '🎤 Audio';
    case 'file': return '📎 File';
    default: return (replyMsg.content || '').substring(0, 100);
  }
};

/**
 * The hover-revealed chevron, WhatsApp-style: parked in the bubble's top-right
 * corner, invisible until the bubble is hovered or something inside it takes
 * focus. Touch devices have no hover at all, so a coarse-pointer media query
 * pins it visible there — otherwise the menu would be unreachable on mobile.
 *
 * It opens the *same* menu as right-click / long-press by calling the parent's
 * onContextMenu(e, message), so there is only ever one menu implementation.
 */
const MenuTrigger = ({ isOwn, onOpen, overMedia }) => (
  <button
    type="button"
    onClick={onOpen}
    // Suppress the browser menu here; the click handler already opened ours.
    onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    aria-label="Message options"
    aria-haspopup="menu"
    data-testid="message-menu-trigger"
    className={`absolute top-0.5 right-0.5 z-[2] w-6 h-6 flex items-center justify-center rounded-full
      opacity-0 transition-opacity duration-100
      group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100
      [@media(pointer:coarse)]:opacity-100
      ${overMedia
        ? 'bg-black/40 text-white hover:bg-black/60'
        : isOwn
          ? 'text-white/80 hover:text-white hover:bg-black/15'
          : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10'}`}
  >
    <ChevronDown size={16} />
  </button>
);

const MessageBubbleInner = ({ message, isOwn, showSenderName, isGroup, currentUserId, onContextMenu, onReactionClick, onReplyClick, onEdit, onRetry, highlighted = false }) => {
  // Long-press is the touch equivalent of right-click. Android fires `contextmenu`
  // after a long press as well, so the timer sets a flag that swallows the
  // duplicate rather than opening the menu twice.
  const longPressTimer = useRef(null);
  const openedByLongPress = useRef(false);

  // Virtuoso unmounts rows as they scroll out; a pending timer would otherwise
  // open a menu for a bubble that is no longer on screen.
  useEffect(() => () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
  }, []);

  const openMenu = useCallback((e) => {
    if (onContextMenu) onContextMenu(e, message);
  }, [onContextMenu, message]);

  const handleTriggerClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    // Keyboard activation reports (0, 0); anchor to the button itself instead so
    // the menu doesn't fly to the top-left corner of the screen.
    if (e.clientX === 0 && e.clientY === 0) {
      const rect = e.currentTarget.getBoundingClientRect();
      openMenu({
        preventDefault: () => {},
        stopPropagation: () => {},
        clientX: rect.right,
        clientY: rect.bottom + 4,
        target: e.currentTarget,
        currentTarget: e.currentTarget,
      });
      return;
    }
    openMenu(e);
  }, [openMenu]);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchStart = useCallback((e) => {
    const touch = e.touches?.[0];
    if (!touch) return;
    const { clientX, clientY } = touch;
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      openedByLongPress.current = true;
      setTimeout(() => { openedByLongPress.current = false; }, 800);
      openMenu({
        preventDefault: () => {},
        stopPropagation: () => {},
        clientX,
        clientY,
        target: e.target,
        currentTarget: e.currentTarget,
      });
    }, LONG_PRESS_MS);
  }, [clearLongPress, openMenu]);

  // Deleted message
  if (message.is_deleted) {
    return (
      <div className="flex justify-center my-2 px-4">
        <span className="text-xs text-[#737373] italic flex items-center gap-1.5">
          <Ban size={12} />
          {isOwn ? 'You deleted this message' : 'This message was deleted'}
        </span>
      </div>
    );
  }

  if (message.type === 'system') {
    return (
      <div className="flex justify-center my-2">
        <span className="text-xs text-[#737373] italic">{message.content}</span>
      </div>
    );
  }

  const isImage = message.type === 'image';
  const isVideo = message.type === 'video';
  const isAudio = message.type === 'audio';
  const isFile = message.type === 'file';
  const richBubble = isImage || isVideo || isAudio || isFile;

  // Whether the media this message CLAIMS to carry is actually there. A
  // half-written row from the backend used to render as an empty card, a dead
  // download link or a player pointed at the empty string; each type now says
  // what happened instead. Mirrors iOS renderableAttachments / unavailableMedia.
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const hasMediaUrl = Boolean(
    message.media_url ||
    (Array.isArray(message.media_urls) && message.media_urls.length > 0) ||
    attachments.some((a) => a.media_url || a.url)
  );
  const mediaMissing = richBubble && !hasMediaUrl;

  const reactions = aggregateReactions(message.reactions);
  const replyMsg = message.reply_to_message;

  const videoCaption = message.caption ||
    (isVideo && message.content && !message.content.startsWith('/api/') && !message.content.startsWith('/uploads') ? message.content : '');
  const audioName = message.filename ||
    (isAudio && message.content && !message.content.startsWith('/api/') ? message.content : '') ||
    'Voice message';

  const imageCaption = message.caption ||
    (isImage && message.content && !message.content.startsWith('/api/') ? message.content : '');
  const hasCaption = Boolean(isVideo ? videoCaption : imageCaption);

  // Built once and handed to whichever slot this message type uses. `overlaid`
  // only when it will actually sit on a picture — with a caption the footer
  // drops below the text, where a scrim would be wrong.
  const footer = (
    <MessageFooter
      message={message}
      isOwn={isOwn}
      onRetry={onRetry}
      variant={(isImage || isVideo) && !hasCaption && !mediaMissing ? 'overlaid' : 'inline'}
    />
  );

  const canEdit = isOwn && message.type === 'text' && !message.is_deleted;

  const handleContextMenu = (e) => {
    e.preventDefault();
    // The long-press timer already opened it on this gesture.
    if (openedByLongPress.current) return;
    openMenu(e);
  };

  const handleDoubleClick = () => {
    if (canEdit && onEdit) onEdit(message);
  };

  return (
    /* `highlighted` flashes the row after a jump (pinned banner, reply preview,
       search hit) so the user can see which message they landed on. A ring plus
       a tint rather than a background swap, so it reads on both the green own
       bubble and the dark received one. */
    /* Vertical rhythm carries the run grouping, matching iOS's 8pt-vs-1pt top
       padding. showSenderName IS the run boundary — it is already computed in
       ChatPanel and already drives the avatar and the name — it just never
       reached the spacing. Applied for DMs too, where the avatar and name are
       suppressed entirely and spacing is the only grouping signal there is. */
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} ${
      showSenderName ? 'mt-2' : 'mt-px'
    } mb-px px-3 sm:px-8 md:px-16 transition-colors duration-500 ${
      highlighted ? 'bg-[#10B981]/15 rounded-[6px]' : ''
    }`}
      data-highlighted={highlighted || undefined}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={clearLongPress}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}>
      {/* Avatar for group received messages */}
      {!isOwn && isGroup && showSenderName && (
        <div className="w-7 h-7 rounded-full bg-[#10B981]/10 flex items-center justify-center text-xs font-medium mr-2 mt-auto mb-1 flex-shrink-0"
          style={{ color: getSenderColor(message.sender_id) }}>
          {message.sender_name?.charAt(0)?.toUpperCase() || '?'}
        </div>
      )}
      {!isOwn && isGroup && !showSenderName && (
        <div className="w-7 mr-2 flex-shrink-0" />
      )}

      <div className="max-w-[80%] sm:max-w-[65%] lg:max-w-[550px]">
        <div
          onDoubleClick={handleDoubleClick}
          className={`relative group ${
            isImage || isVideo
              ? `px-1 py-1 ${isOwn ? 'bg-[#10B981] rounded-[8px_8px_0px_8px]' : 'bg-[#1F1F1F] rounded-[8px_8px_8px_0px]'}`
              : isFile || isAudio
                ? `p-1 ${isOwn ? 'bg-[#10B981] rounded-[8px_8px_0px_8px]' : 'bg-[#1F1F1F] rounded-[8px_8px_8px_0px]'}`
                // pr-8 permanently reserves the chevron's corner, so revealing it on
                // hover never reflows the bubble or lets it sit on top of the text.
                : `pl-3 pr-8 py-2 ${isOwn ? 'bg-[#10B981] rounded-[8px_8px_0px_8px]' : 'bg-[#1F1F1F] rounded-[8px_8px_8px_0px]'}`
          }`}
        >
          {/* Hover / focus / touch menu trigger */}
          <MenuTrigger isOwn={isOwn} onOpen={handleTriggerClick} overMedia={richBubble} />

          {/* Forwarded label */}
          {message.is_forwarded && (
            <p className={`text-[11px] italic mb-0.5 ${isOwn ? 'text-white/60' : 'text-[#A3A3A3]'}`}>
              ↗ Forwarded
            </p>
          )}

          {/* Sender name for groups */}
          {!isOwn && showSenderName && isGroup && (
            <p className={`text-xs font-medium mb-0.5 ${richBubble ? 'px-2 pt-1' : ''}`}
              style={{ color: getSenderColor(message.sender_id) }}>
              {message.sender_name}
            </p>
          )}

          {/* Reply block */}
          {replyMsg && (
            <div
              onClick={() => onReplyClick && onReplyClick(replyMsg._id)}
              className={`mb-1.5 p-2 rounded-[4px] border-l-2 cursor-pointer ${
                isOwn ? 'bg-[#059669] border-white/40' : 'bg-[#2D2D2D] border-[#10B981]'
              }`}
            >
              <p className={`text-[12px] font-semibold ${isOwn ? 'text-white/90' : 'text-[#10B981]'}`}>
                {replyMsg.sender_name}
              </p>
              <p className={`text-[12px] line-clamp-2 ${isOwn ? 'text-white/70' : 'text-[#A3A3A3]'}`}>
                {replyPreview(replyMsg)}
              </p>
            </div>
          )}

          {/* Content by type.

              FOOTER PLACEMENT is decided per type, which is the whole of items
              17-20 in the parity brief. Previously one shared block sat below
              every kind of content, which cost a full row of empty bubble under
              a photo, under a fixed-width audio card and under a document card,
              and made every one-word text message two rows tall. */}
          {mediaMissing ? (
            /* A message typed as media whose media is not there. Previously:
               ImageBubble returned null leaving a bubble with only a timestamp,
               audio got <AudioPlayer src="">, video got <video src="">, and the
               document card rendered a dead download link named "Document". */
            <div className="flex items-center gap-2 px-2 py-1.5" data-testid="media-unavailable">
              <AlertTriangle size={14} className={isOwn ? 'text-white/70' : 'text-[#A3A3A3]'} />
              <span className={`text-sm ${isOwn ? 'text-white/80' : 'text-[#A3A3A3]'}`}>
                {isImage ? 'Photo unavailable'
                  : isVideo ? 'Video unavailable'
                  : isAudio ? 'Voice message unavailable'
                  : 'File unavailable'}
              </span>
            </div>
          ) : isImage ? (
            <ImageBubble message={message} isOwn={isOwn} footer={footer} />
          ) : isVideo ? (
            <VideoBubble message={message} isOwn={isOwn} footer={footer} caption={videoCaption} />
          ) : isAudio ? (
            /* Was a bare `<audio controls>` at 32px inside a 260px bubble: no
               scrub, no length before the file loaded, and completely different
               native chrome in Safari vs Chrome. AudioPlayer is the same component
               the pre-send preview uses, so what the sender heard is what the
               recipient sees, and only one clip can sound at a time. */
            <div data-testid="audio-bubble" className="w-[260px] flex items-center gap-2.5 p-1.5">
              <div className="flex-1 min-w-0">
                {/* pr-6 keeps the filename clear of the chevron's corner */}
                <p className={`text-xs truncate pr-6 ${isOwn ? 'text-white/90' : 'text-[#F5F5F5]'}`}>{audioName}</p>
                <AudioPlayer
                  src={resolveUrl(message.media_url)}
                  /* Server-sent, because a MediaRecorder container has no duration
                     in its header and the element would report Infinity/NaN. */
                  fallbackDuration={message.duration ?? message.attachments?.[0]?.duration ?? null}
                  tone={isOwn ? 'own' : 'dark'}
                  className="mt-1"
                  /* The leading slot: the sender's initial with a mic badge until
                     the note has been played, then the speed control. Offering
                     "2x" on a note nobody has heard is a control for a decision
                     the listener has not had the chance to make. */
                  senderInitial={message.sender_name?.charAt(0)?.toUpperCase() || null}
                  senderColor={getSenderColor(message.sender_id)}
                  /* The bubble footer, rendered on the player's own duration row
                     rather than on a full-width strip beneath a 260px card. */
                  trailingMeta={footer}
                />
              </div>
            </div>
          ) : isFile ? (
            <DocumentBubble message={message} isOwn={isOwn} trailingMeta={footer} />
          ) : (
            /* Beside, not below: a short message is "hi  10:24 AM ✓" on one line.
               items-end bottom-aligns the footer with the last line of wrapped
               text. The footer is deliberately not flex-1 — trailing alignment
               already comes from the row's justify-end, and stretching it is
               what pushed every bubble to the full column width on iOS. */
            <div className="flex items-end gap-2">
              <p className={`text-sm whitespace-pre-wrap break-words min-w-0 ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>
                {message.content}
              </p>
              {footer}
            </div>
          )}

          {/* Back to its own row only where there is nothing to sit beside or
              on top of: a captioned photo/video, and the unavailable case. */}
          {(mediaMissing || ((isImage || isVideo) && hasCaption)) && (
            <div className={`flex ${richBubble ? 'px-2 pb-1' : ''} justify-end`}>{footer}</div>
          )}
        </div>

        {/* Reaction badges */}
        {reactions.length > 0 && (
          <div className={`flex flex-wrap gap-1 mt-1 ${isOwn ? 'justify-end' : 'justify-start'}`}>
            {reactions.map(r => {
              const hasMyReaction = r.userIds.includes(currentUserId);
              return (
                <button
                  key={r.emoji}
                  onClick={() => onReactionClick && onReactionClick(message._id, r.emoji)}
                  title={r.users.join(', ')}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors ${
                    hasMyReaction
                      ? 'bg-[#10B981]/20 border border-[#10B981] text-[#F5F5F5]'
                      : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3] hover:bg-[#2D2D2D]'
                  }`}
                  data-testid="reaction-badge"
                >
                  <span className="text-[14px]">{r.emoji}</span>
                  <span>{r.count}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * The store never mutates a message in place — every reducer either returns the
 * same object or a fresh one — so reference equality *is* "nothing changed", and
 * it is both cheaper and stricter than field-by-field comparison.
 *
 * The previous comparator ran JSON.stringify(reactions) per visible row per
 * render, and compared only message fields: it ignored `isGroup`,
 * `showSenderName`, `isOwn` and `currentUserId`, so a bubble rendered before its
 * conversation had loaded kept its non-group layout forever, sender-name
 * grouping went stale after older pages were prepended, and reaction highlights
 * missed the current user. It also missed `reply_to_message` entirely.
 *
 * The handler props are omitted deliberately: ChatPanel gives them stable
 * identities (useCallback + refs), so comparing them would only ever produce
 * false misses.
 */
export const MessageBubble = memo(MessageBubbleInner, (prev, next) => (
  prev.message === next.message &&
  prev.isOwn === next.isOwn &&
  prev.showSenderName === next.showSenderName &&
  prev.isGroup === next.isGroup &&
  prev.currentUserId === next.currentUserId
));
