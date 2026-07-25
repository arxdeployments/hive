import React, { memo, useCallback, useEffect, useRef } from 'react';
import { Check, CheckCheck, Clock, Ban, Mic, ChevronDown, Star, Pin } from 'lucide-react';
import { ImageBubble } from './ImageBubble';
import { DocumentBubble } from './DocumentBubble';

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

const formatTime = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
};

// WhatsApp tick semantics. These only ever render on your own (green) bubble,
// so "grey" is white/70 against that background; blue (#53BDEB) means read.
const StatusIcon = ({ status }) => {
  switch (status) {
    case 'sending':
      return <Clock size={12} className="text-white/50" data-testid="message-status" data-status="sending" aria-label="Sending" />;
    case 'delivered':
      return <CheckCheck size={12} className="text-white/70" data-testid="message-status" data-status="delivered" aria-label="Delivered" />;
    case 'read':
      return <CheckCheck size={12} className="text-[#53BDEB]" data-testid="message-status" data-status="read" aria-label="Read" />;
    case 'sent':
    default:
      return <Check size={12} className="text-white/70" data-testid="message-status" data-status="sent" aria-label="Sent" />;
  }
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

const MessageBubbleInner = ({ message, isOwn, showSenderName, isGroup, currentUserId, onContextMenu, onReactionClick, onReplyClick, onEdit, onRetry }) => {
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

  const reactions = aggregateReactions(message.reactions);
  const replyMsg = message.reply_to_message;

  const videoCaption = message.caption ||
    (isVideo && message.content && !message.content.startsWith('/api/') && !message.content.startsWith('/uploads') ? message.content : '');
  const audioName = message.filename ||
    (isAudio && message.content && !message.content.startsWith('/api/') ? message.content : '') ||
    'Voice message';

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
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-1 px-3 sm:px-8 md:px-16`}
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

          {/* Content by type */}
          {isImage ? (
            <ImageBubble message={message} isOwn={isOwn} />
          ) : isVideo ? (
            <div data-testid="video-bubble" className="max-w-[330px]">
              <video
                controls
                playsInline
                preload="metadata"
                src={resolveUrl(message.media_url)}
                poster={message.thumbnail_url ? resolveUrl(message.thumbnail_url) : undefined}
                className="w-full rounded-[6px] max-h-[320px] bg-black"
              />
              {videoCaption && (
                <p className={`text-sm mt-1 px-1 ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>{videoCaption}</p>
              )}
            </div>
          ) : isAudio ? (
            <div data-testid="audio-bubble" className="w-[260px] flex items-center gap-2.5 p-1.5">
              <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${isOwn ? 'bg-white/15' : 'bg-[#10B981]/15'}`}>
                <Mic size={18} className={isOwn ? 'text-white' : 'text-[#10B981]'} />
              </div>
              <div className="flex-1 min-w-0">
                {/* pr-6 keeps the filename clear of the chevron's corner */}
                <p className={`text-xs truncate pr-6 ${isOwn ? 'text-white/90' : 'text-[#F5F5F5]'}`}>{audioName}</p>
                <audio
                  controls
                  preload="metadata"
                  src={resolveUrl(message.media_url)}
                  className="w-full h-8 mt-1"
                />
              </div>
            </div>
          ) : isFile ? (
            <DocumentBubble message={message} isOwn={isOwn} />
          ) : (
            <p className={`text-sm whitespace-pre-wrap break-words ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>
              {message.content}
            </p>
          )}

          {/* Time + status. The negative right margin gives back the space the
              chevron reserved above, so the timestamp still sits flush right. */}
          <div className={`flex items-center gap-1 mt-1 ${richBubble ? 'px-2 pb-1' : '-mr-5'} justify-end`}>
            {message.is_pinned && (
              <Pin
                size={11}
                className={isOwn ? 'text-white/70' : 'text-[#A3A3A3]'}
                data-testid="message-pinned-indicator"
                aria-label="Pinned"
              />
            )}
            {message.is_starred && (
              <Star
                size={11}
                fill="currentColor"
                className={isOwn ? 'text-white/70' : 'text-[#A3A3A3]'}
                data-testid="message-starred-indicator"
                aria-label="Starred"
              />
            )}
            <span className={`text-[11px] ${isOwn ? 'text-white/70' : 'text-[#A3A3A3]'}`}>
              {formatTime(message.created_at)}
            </span>
            {message.edited_at && (
              <span
                className={`text-[11px] ${isOwn ? 'text-white/70' : 'text-[#A3A3A3]'}`}
                data-testid="edited-indicator"
              >
                · edited
              </span>
            )}
            {isOwn && (
              message.status === 'failed' ? (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRetry && onRetry(message); }}
                  title="Failed to send. Tap to retry."
                  data-testid="message-retry"
                  className="flex items-center justify-center w-4 h-4 rounded-full bg-[#EF4444] text-white text-[10px] font-bold leading-none hover:bg-[#DC2626] transition-colors"
                >
                  !
                </button>
              ) : (
                <StatusIcon status={message.status || 'sent'} />
              )
            )}
          </div>
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
