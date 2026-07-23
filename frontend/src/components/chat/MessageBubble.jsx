import React, { memo } from 'react';
import { Check, CheckCheck, Clock, Ban, Mic } from 'lucide-react';
import { ImageBubble } from './ImageBubble';
import { DocumentBubble } from './DocumentBubble';

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

const StatusIcon = ({ status }) => {
  switch (status) {
    case 'sending': return <Clock size={12} className="text-white/50" />;
    case 'sent': return <Check size={12} className="text-white/70" />;
    case 'delivered': return <CheckCheck size={12} className="text-white/70" />;
    case 'read': return <CheckCheck size={12} className="text-[#53BDEB]" />;
    default: return <Check size={12} className="text-white/70" />;
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

const MessageBubbleInner = ({ message, isOwn, showSenderName, isGroup, currentUserId, onContextMenu, onReactionClick, onReplyClick, onEdit, onRetry }) => {
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
    if (onContextMenu) onContextMenu(e, message);
  };

  const handleDoubleClick = () => {
    if (canEdit && onEdit) onEdit(message);
  };

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-1 px-3 sm:px-8 md:px-16`}
      onContextMenu={handleContextMenu}>
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
                : `px-3 py-2 ${isOwn ? 'bg-[#10B981] rounded-[8px_8px_0px_8px]' : 'bg-[#1F1F1F] rounded-[8px_8px_8px_0px]'}`
          }`}
        >
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
                <p className={`text-xs truncate ${isOwn ? 'text-white/90' : 'text-[#F5F5F5]'}`}>{audioName}</p>
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

          {/* Time + status */}
          <div className={`flex items-center gap-1 mt-1 ${richBubble ? 'px-2 pb-1' : ''} justify-end`}>
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

export const MessageBubble = memo(MessageBubbleInner, (prev, next) => {
  return prev.message._id === next.message._id &&
    prev.message.status === next.message.status &&
    prev.message.temp_id === next.message.temp_id &&
    prev.message.is_deleted === next.message.is_deleted &&
    prev.message.edited_at === next.message.edited_at &&
    prev.message.content === next.message.content &&
    prev.message.media_url === next.message.media_url &&
    prev.message.thumbnail_url === next.message.thumbnail_url &&
    JSON.stringify(prev.message.reactions) === JSON.stringify(next.message.reactions);
});
