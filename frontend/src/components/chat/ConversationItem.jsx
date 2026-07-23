import React, { memo } from 'react';
import { Pin, Globe } from 'lucide-react';

const formatTimestamp = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (msgDate.getTime() === today.getTime()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';

  const dayDiff = Math.floor((today - msgDate) / (1000 * 60 * 60 * 24));
  if (dayDiff < 7) {
    return d.toLocaleDateString('en-US', { weekday: 'short' });
  }
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
};

const ConversationItemInner = ({ conversation, currentUserId, isActive, onClick, typingUsers }) => {
  // For direct chats, show the other participant's info
  const otherParticipant = conversation.participants?.find(
    p => p.user_id !== currentUserId
  );

  const displayName = conversation.type === 'direct'
    ? otherParticipant?.display_name || 'Unknown'
    : conversation.name || 'Group';

  const isOnline = otherParticipant?.status === 'online';
  const initial = displayName.charAt(0).toUpperCase();

  // Last message preview
  const lastMsg = conversation.last_message;
  let preview = '';
  if (lastMsg) {
    let msgText = lastMsg.content;
    if (lastMsg.type === 'image') msgText = '\ud83d\udcf7 Photo';
    else if (lastMsg.type === 'file') msgText = `\ud83d\udcc4 ${lastMsg.content || 'Document'}`;

    if (lastMsg.type === 'system') {
      preview = lastMsg.content;
    } else if (lastMsg.sender_id === currentUserId) {
      preview = `You: ${msgText}`;
    } else if (conversation.type === 'group') {
      preview = `${lastMsg.sender_name}: ${msgText}`;
    } else {
      preview = msgText;
    }
  }

  // Typing indicator
  const convTyping = typingUsers?.[conversation._id] || {};
  const typingNames = Object.values(convTyping).filter(n => n);
  const isTyping = typingNames.length > 0;

  return (
    <button
      onClick={onClick}
      data-testid="conversation-item"
      className={`w-full flex items-center gap-3 px-4 py-3 transition-colors duration-150 text-left ${
        isActive
          ? 'bg-[#1A1A1A] border-l-[3px] border-l-[#10B981]'
          : 'hover:bg-[#141414] border-l-[3px] border-l-transparent'
      }`}
    >
      {/* Avatar */}
      <div className="relative flex-shrink-0">
        <div className="w-11 h-11 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium">
          {initial}
        </div>
        {conversation.type === 'direct' && isOnline && (
          <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#10B981] rounded-full border-2 border-[#0F0F0F]" />
        )}
        {conversation.cross_org && (
          <span className="absolute bottom-0 right-0 w-4 h-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-full flex items-center justify-center">
            <Globe size={10} className="text-[#10B981]" />
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <span className="text-[15px] font-medium text-[#F5F5F5] truncate">{displayName}</span>
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            {conversation.is_pinned && <Pin size={10} className="text-[#A3A3A3]" />}
            <span className="text-xs text-[#A3A3A3]">
              {formatTimestamp(lastMsg?.created_at || conversation.created_at)}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between mt-0.5">
          {isTyping ? (
            <span className="text-sm text-[#10B981] truncate flex items-center gap-1">
              typing
              <span className="inline-flex gap-0.5">
                <span className="w-1 h-1 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </span>
            </span>
          ) : (
            <span className="text-sm text-[#A3A3A3] truncate">{preview || 'No messages yet'}</span>
          )}
          {conversation.unread_count > 0 && (
            <span className="flex-shrink-0 ml-2 min-w-[20px] h-5 px-1.5 bg-[#10B981] text-white text-xs font-medium rounded-full flex items-center justify-center">
              {conversation.unread_count}
            </span>
          )}
        </div>
      </div>
    </button>
  );
};

export const ConversationItem = memo(ConversationItemInner);
