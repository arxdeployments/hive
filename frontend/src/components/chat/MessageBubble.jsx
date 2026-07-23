import React, { memo } from 'react';
import { Check, CheckCheck, Clock, Ban } from 'lucide-react';
import { ImageBubble } from './ImageBubble';
import { DocumentBubble } from './DocumentBubble';

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

const MessageBubbleInner = ({ message, isOwn, showSenderName, isGroup, currentUserId, onContextMenu, onReactionClick, onReplyClick }) => {
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
  const isFile = message.type === 'file';
  const reactions = aggregateReactions(message.reactions);
  const replyMsg = message.reply_to_message;

  const handleContextMenu = (e) => {
    e.preventDefault();
    if (onContextMenu) onContextMenu(e, message);
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
          className={`relative group ${
            isImage
              ? `px-1 py-1 ${isOwn ? 'bg-[#10B981] rounded-[8px_8px_0px_8px]' : 'bg-[#1F1F1F] rounded-[8px_8px_8px_0px]'}`
              : isFile
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
            <p className={`text-xs font-medium mb-0.5 ${isImage || isFile ? 'px-2 pt-1' : ''}`}
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
                {replyMsg.is_deleted ? 'This message was deleted' :
                  replyMsg.type === 'image' ? '\ud83d\udcf7 Photo' : (replyMsg.content || '').substring(0, 100)}
              </p>
            </div>
          )}

          {/* Content by type */}
          {isImage ? (
            <ImageBubble message={message} isOwn={isOwn} />
          ) : isFile ? (
            <DocumentBubble message={message} isOwn={isOwn} />
          ) : (
            <p className={`text-sm whitespace-pre-wrap break-words ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>
              {message.content}
            </p>
          )}

          {/* Time + status */}
          <div className={`flex items-center gap-1 mt-1 ${isImage || isFile ? 'px-2 pb-1' : ''} justify-end`}>
            <span className={`text-[11px] ${isOwn ? 'text-white/70' : 'text-[#A3A3A3]'}`}>
              {formatTime(message.created_at)}
            </span>
            {isOwn && <StatusIcon status={message.status || 'sent'} />}
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
    JSON.stringify(prev.message.reactions) === JSON.stringify(next.message.reactions);
});
