import React, { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Search, Video, Phone, MoreVertical, ChevronDown } from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { MessageBubble } from './MessageBubble';
import { MessageComposer } from './MessageComposer';
import { DateSeparator } from './DateSeparator';
import { TypingIndicator } from './TypingIndicator';
import { EmptyChat } from './EmptyChat';
import { GroupInfoPanel } from './GroupInfoPanel';
import { MessageContextMenu } from './MessageContextMenu';
import { ReplyPreview } from './ReplyPreview';
import { ReactionPicker } from './ReactionPicker';
import { ForwardModal } from './ForwardModal';
import { MessageInfoModal } from './MessageInfoModal';
import { ConversationSearch } from './ConversationSearch';
import { ContactInfoPanel } from './ContactInfoPanel';
import useChatStore from '../../stores/chatStore';
import useCallStore from '../../stores/callStore';
import { useAuth } from '../../contexts/AuthContext';
import client from '../../api/client';
import wsClient from '../../services/websocket';
import { toast } from 'sonner';

const formatStatus = (participant) => {
  if (!participant) return '';
  if (participant.status === 'online') return 'online';
  if (participant.last_seen) {
    const d = new Date(participant.last_seen);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (msgDate.getTime() === today.getTime()) {
      return `last seen today at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
    }
    return `last seen ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`;
  }
  return 'offline';
};

const isDifferentDay = (d1, d2) => {
  const a = new Date(d1);
  const b = new Date(d2);
  return a.getFullYear() !== b.getFullYear() ||
    a.getMonth() !== b.getMonth() ||
    a.getDate() !== b.getDate();
};

export const ChatPanel = ({ conversationId, onBack, isMobile }) => {
  const { user } = useAuth();
  const {
    conversations, messages, setMessages, prependMessages,
    addOptimisticMessage, typingUsers,
    clearUnread, bumpConversation, wsConnected
  } = useChatStore();

  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [reactionPicker, setReactionPicker] = useState(null);
  const [forwardMsg, setForwardMsg] = useState(null);
  const [msgInfo, setMsgInfo] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [showConvSearch, setShowConvSearch] = useState(false);
  const [showContactInfo, setShowContactInfo] = useState(false);
  const virtuosoRef = useRef(null);
  const [atBottom, setAtBottom] = useState(true);
  const prevMsgCountRef = useRef(0);

  const conversation = conversations.find(c => c._id === conversationId);
  const convMessages = messages[conversationId] || [];

  const otherParticipant = conversation?.participants?.find(
    p => p.user_id !== user?.id
  );
  const displayName = conversation?.type === 'direct'
    ? otherParticipant?.display_name || 'Unknown'
    : conversation?.name || 'Group';

  const statusText = conversation?.type === 'direct'
    ? formatStatus(otherParticipant)
    : `${conversation?.participants?.length || 0} members`;

  // Fetch messages (initial load only - WS handles real-time updates)
  const fetchMessages = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    try {
      const { data } = await client.get(`/api/conversations/${conversationId}/messages`, {
        params: { limit: 50 }
      });
      setMessages(conversationId, data.messages);
      setHasMore(data.has_more);
    } catch (err) {
      console.error('Failed to fetch messages', err);
    } finally {
      setLoading(false);
    }
  }, [conversationId, setMessages]);

  useEffect(() => {
    fetchMessages();
    // Mark as read + send read receipt via WS
    if (conversationId) {
      client.put(`/api/conversations/${conversationId}/read`).catch(() => {});
      clearUnread(conversationId);
    }
  }, [fetchMessages, conversationId, clearUnread]);

  // Send read receipt when new messages arrive in active conversation
  useEffect(() => {
    if (!conversationId || !convMessages.length) return;

    const lastMsg = convMessages[convMessages.length - 1];
    if (lastMsg && lastMsg.sender_id !== user?.id && lastMsg._id && !lastMsg.temp_id) {
      // Only send read receipt via WS if we have a real message ID
      if (wsConnected) {
        wsClient.sendReadReceipt(conversationId, lastMsg._id);
      }
      clearUnread(conversationId);
    }
  }, [convMessages.length, conversationId, user?.id, wsConnected, clearUnread]);

  // Auto-scroll when new messages arrive and we're at the bottom
  useEffect(() => {
    if (convMessages.length > prevMsgCountRef.current && atBottom) {
      setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' });
      }, 50);
    }
    prevMsgCountRef.current = convMessages.length;
  }, [convMessages.length, atBottom]);

  // Load older messages
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !conversationId) return;
    const msgs = messages[conversationId] || [];
    if (msgs.length === 0) return;

    setLoadingMore(true);
    try {
      const oldestMsg = msgs[0];
      const { data } = await client.get(`/api/conversations/${conversationId}/messages`, {
        params: { before: oldestMsg._id, limit: 50 }
      });
      if (data.messages.length > 0) {
        prependMessages(conversationId, data.messages);
      }
      setHasMore(data.has_more);
    } catch (err) {
      console.error('Failed to load more messages', err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, conversationId, messages, prependMessages]);

  // Send message - optimistic UI, WS delivery handled by MessageComposer
  const handleSend = async (content, tempId, msgType = 'text', mediaUrl = null, thumbnailUrl = null) => {
    if (!conversationId) return;
    if (msgType === 'text' && (!content || !content.trim())) return;

    const optimisticMsg = {
      _id: tempId,
      temp_id: tempId,
      conversation_id: conversationId,
      sender_id: user.id,
      sender_name: user.name,
      type: msgType,
      content: content,
      media_url: mediaUrl,
      thumbnail_url: thumbnailUrl,
      created_at: new Date().toISOString(),
      status: 'sending',
      read_by: [],
      delivered_to: [],
    };
    addOptimisticMessage(conversationId, optimisticMsg);

    setTimeout(() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' }), 50);

    // Update conversation list immediately
    bumpConversation(conversationId, {
      content: content,
      sender_id: user.id,
      sender_name: user.name,
      created_at: new Date().toISOString(),
      type: 'text'
    });

    // If WS not connected, fall back to HTTP
    if (!wsConnected) {
      try {
        const { data } = await client.post(`/api/conversations/${conversationId}/messages`, {
          content, type: 'text', temp_id: tempId
        });
        useChatStore.getState().replaceOptimisticMessage(conversationId, tempId, data);
      } catch (err) {
        console.error('Failed to send via HTTP:', err);
        useChatStore.getState().replaceOptimisticMessage(conversationId, tempId, {
          ...optimisticMsg, status: 'failed'
        });
      }
    }
    // If WS connected, MessageComposer already sends via wsClient.sendMessage()
    // The message_ack handler in websocket.js will update the optimistic message

    // Clear reply state after sending
    setReplyTo(null);
  };

  // Context menu handler
  const handleContextMenu = (e, msg) => {
    e.preventDefault();
    setContextMenu({ message: msg, position: { x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 300) } });
  };

  // Context menu actions
  const handleContextAction = async (action, msg) => {
    setContextMenu(null);
    switch (action) {
      case 'reply':
        setReplyTo(msg);
        break;
      case 'react':
        setReactionPicker({ message: msg, position: { x: 300, y: 300 } });
        break;
      case 'forward':
        setForwardMsg(msg);
        break;
      case 'info':
        try {
          const { data } = await client.get(`/api/conversations/messages/${msg._id}/info`);
          setMsgInfo(data);
        } catch (err) { toast.error('Failed to load message info'); }
        break;
      case 'delete_me':
        setDeleteConfirm({ message: msg, forEveryone: false });
        break;
      case 'delete_all':
        setDeleteConfirm({ message: msg, forEveryone: true });
        break;
      default: break;
    }
  };

  // Reaction click on badge
  const handleReactionClick = async (messageId, emoji) => {
    try {
      await client.post(`/api/conversations/messages/${messageId}/react`, { emoji });
    } catch (err) { toast.error('Failed to react'); }
  };

  // React from picker
  const handleReactFromPicker = async (emoji) => {
    if (!reactionPicker?.message) return;
    try {
      await client.post(`/api/conversations/messages/${reactionPicker.message._id}/react`, { emoji });
    } catch (err) { toast.error('Failed to react'); }
  };

  // Delete handler
  const handleDelete = async () => {
    if (!deleteConfirm) return;
    try {
      await client.delete(`/api/conversations/messages/${deleteConfirm.message._id}?for_everyone=${deleteConfirm.forEveryone}`);
      if (!deleteConfirm.forEveryone) {
        // Remove from local view
        const store = useChatStore.getState();
        store.setMessages(conversationId,
          (store.messages[conversationId] || []).filter(m => m._id !== deleteConfirm.message._id)
        );
      }
      toast.success(deleteConfirm.forEveryone ? 'Message deleted for everyone' : 'Message deleted');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
    setDeleteConfirm(null);
  };

  // Reply click -> scroll to original message
  const handleReplyBlockClick = (originalMsgId) => {
    const idx = items.findIndex(item => item.type === 'message' && item.message._id === originalMsgId);
    if (idx >= 0 && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: idx, behavior: 'smooth' });
    }
  };

  if (!conversationId) {
    return <EmptyChat />;
  }

  // Build message items with date separators
  const items = [];
  for (let i = 0; i < convMessages.length; i++) {
    const msg = convMessages[i];
    const prevMsg = i > 0 ? convMessages[i - 1] : null;

    if (!prevMsg || isDifferentDay(prevMsg.created_at, msg.created_at)) {
      items.push({ type: 'date', date: msg.created_at, key: `date-${msg.created_at}-${i}` });
    }
    items.push({
      type: 'message',
      message: msg,
      key: msg._id || msg.temp_id,
      isOwn: msg.sender_id === user?.id,
      showSenderName: !prevMsg || prevMsg.sender_id !== msg.sender_id || isDifferentDay(prevMsg.created_at, msg.created_at),
    });
  }

  const convTyping = typingUsers?.[conversationId] || {};

  return (
    <div className="flex-1 flex flex-col bg-[#0A0A0A] h-full min-h-0 overflow-hidden">
      {/* Chat Header */}
      <div className="h-16 bg-[#0F0F0F] border-b border-[#1F1F1F] flex items-center justify-between px-4 flex-shrink-0">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => {
          if (conversation?.type === 'group') setShowGroupInfo(true);
          else if (conversation?.type === 'direct') setShowContactInfo(true);
        }}>
          {isMobile && (
            <button
              onClick={onBack}
              data-testid="chat-back-button"
              className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors -ml-2"
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <div className="relative">
            <div className="w-10 h-10 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium">
              {displayName?.charAt(0)?.toUpperCase() || '?'}
            </div>
            {otherParticipant?.status === 'online' && (
              <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#10B981] rounded-full border-2 border-[#0F0F0F]" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-base font-medium text-[#F5F5F5]">{displayName}</h3>
              {conversation?.cross_org && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#10B981]/20 text-[#10B981]">Cross-Org</span>
              )}
            </div>
            <p className={`text-xs ${otherParticipant?.status === 'online' ? 'text-[#10B981]' : 'text-[#A3A3A3]'}`}>
              {Object.keys(convTyping).length > 0 ? (
                <span className="text-[#10B981] flex items-center gap-1">
                  typing
                  <span className="inline-flex gap-0.5">
                    <span className="w-1 h-1 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                    <span className="w-1 h-1 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                    <span className="w-1 h-1 bg-[#10B981] rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                  </span>
                </span>
              ) : conversation?.cross_org
                ? `${conversation?.participants?.length || 0} members from ${new Set(conversation?.participants?.map(p => p.org_name).filter(Boolean)).size || '?'} organizations`
                : statusText}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowConvSearch(!showConvSearch)} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors" data-testid="chat-search-btn">
            <Search size={18} />
          </button>
          <button
            onClick={() => {
              const wsC = wsClient;
              const callSt = useCallStore;
              if (callSt.getState().callState !== 'idle') return;
              if (conversation?.type === 'direct' && otherParticipant) {
                wsC.send({ type: 'call:initiate', callee_id: otherParticipant.user_id, call_type: 'voice', conversation_id: conversationId });
                callSt.getState().initiateCall(null, 'voice', false, conversationId);
              } else if (conversation?.type === 'group' || conversation?.type === 'cross_org') {
                wsC.send({ type: 'call:group_initiate', conversation_id: conversationId, call_type: 'voice' });
                callSt.getState().initiateCall(null, 'voice', true, conversationId);
              }
            }}
            data-testid="header-voice-call-btn"
            className={`p-2 rounded-[6px] transition-colors ${
              useCallStore.getState?.().callState !== 'idle' ? 'text-[#A3A3A3]/30 cursor-not-allowed' : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A]'
            }`}
            title="Voice call"
          >
            <Phone size={18} />
          </button>
          <button
            onClick={() => {
              const wsC = wsClient;
              const callSt = useCallStore;
              if (callSt.getState().callState !== 'idle') return;
              if (conversation?.type === 'direct' && otherParticipant) {
                wsC.send({ type: 'call:initiate', callee_id: otherParticipant.user_id, call_type: 'video', conversation_id: conversationId });
                callSt.getState().initiateCall(null, 'video', false, conversationId);
              } else if (conversation?.type === 'group' || conversation?.type === 'cross_org') {
                wsC.send({ type: 'call:group_initiate', conversation_id: conversationId, call_type: 'video' });
                callSt.getState().initiateCall(null, 'video', true, conversationId);
              }
            }}
            data-testid="header-video-call-btn"
            className={`p-2 rounded-[6px] transition-colors ${
              useCallStore.getState?.().callState !== 'idle' ? 'text-[#A3A3A3]/30 cursor-not-allowed' : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A]'
            }`}
            title="Video call"
          >
            <Video size={18} />
          </button>
          <button className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">
            <MoreVertical size={18} />
          </button>
        </div>
      </div>

      {/* In-conversation search */}
      <ConversationSearch
        conversationId={conversationId}
        isOpen={showConvSearch}
        onClose={() => setShowConvSearch(false)}
        onScrollToMessage={(msgId) => {
          const idx = items.findIndex(item => item.type === 'message' && item.message._id === msgId);
          if (idx >= 0 && virtuosoRef.current) {
            virtuosoRef.current.scrollToIndex({ index: idx, behavior: 'smooth' });
          }
        }}
      />

      {/* Message Area */}
      <div className="flex-1 relative overflow-hidden min-h-0 scrollable-area">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="w-8 h-8 border-2 border-[#10B981] border-t-transparent rounded-full animate-spin mx-auto mb-2" />
              <p className="text-xs text-[#A3A3A3]">Loading messages...</p>
            </div>
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={items}
            initialTopMostItemIndex={items.length - 1}
            followOutput="smooth"
            atBottomStateChange={(bottom) => {
              setAtBottom(bottom);
              setShowScrollDown(!bottom && items.length > 10);
            }}
            startReached={() => {
              if (hasMore) loadMore();
            }}
            itemContent={(index, item) => {
              if (item.type === 'date') {
                return <DateSeparator date={item.date} />;
              }
              return (
                <MessageBubble
                  message={item.message}
                  isOwn={item.isOwn}
                  showSenderName={item.showSenderName}
                  isGroup={conversation?.type === 'group'}
                  currentUserId={user?.id}
                  onContextMenu={handleContextMenu}
                  onReactionClick={handleReactionClick}
                  onReplyClick={handleReplyBlockClick}
                />
              );
            }}
          />
        )}

        {/* Typing indicator - positioned at bottom of message area */}
        {Object.keys(convTyping).length > 0 && (
          <div className="absolute bottom-0 left-0 right-0 bg-[#0A0A0A]/90 backdrop-blur-sm z-[5]">
            <TypingIndicator users={convTyping} />
          </div>
        )}

        {/* Scroll to bottom button */}
        {showScrollDown && (
          <motion.button
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.8 }}
            onClick={() => virtuosoRef.current?.scrollToIndex({ index: 'LAST', behavior: 'smooth' })}
            className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-[#10B981] text-white flex items-center justify-center shadow-lg hover:bg-[#059669] transition-colors z-10"
          >
            <ChevronDown size={20} />
          </motion.button>
        )}
      </div>

      {/* Reply Preview */}
      {replyTo && (
        <ReplyPreview message={replyTo} onClose={() => setReplyTo(null)} />
      )}

      {/* Composer or admin-only banner */}
      {conversation?.admin_only_messages && conversation?.type === 'group' &&
        !['creator', 'admin'].includes(conversation?.participants?.find(p => p.user_id === user?.id)?.role) ? (
        <div className="bg-[#0F0F0F] border-t border-[#1F1F1F] px-4 py-3 text-center">
          <p className="text-sm text-[#A3A3A3]">Only admins can send messages in this group</p>
        </div>
      ) : (
        <MessageComposer conversationId={conversationId} onSend={handleSend} replyTo={replyTo} />
      )}

      {/* Context Menu */}
      {contextMenu && (
        <MessageContextMenu
          message={contextMenu.message}
          isOwn={contextMenu.message.sender_id === user?.id}
          position={contextMenu.position}
          onAction={handleContextAction}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Reaction Picker */}
      {reactionPicker && (
        <ReactionPicker
          position={reactionPicker.position}
          onReact={handleReactFromPicker}
          onClose={() => setReactionPicker(null)}
        />
      )}

      {/* Forward Modal */}
      <ForwardModal
        message={forwardMsg}
        isOpen={!!forwardMsg}
        onClose={() => setForwardMsg(null)}
      />

      {/* Message Info Modal */}
      <MessageInfoModal
        info={msgInfo}
        isOpen={!!msgInfo}
        onClose={() => setMsgInfo(null)}
      />

      {/* Delete Confirmation */}
      {deleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDeleteConfirm(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
          <div className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-6 max-w-sm" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm text-[#F5F5F5] mb-4">
              {deleteConfirm.forEveryone
                ? "Delete this message for everyone? This can't be undone."
                : "Delete this message for you?"}
            </p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Cancel</button>
              <button onClick={handleDelete}
                className={`px-4 py-2 text-sm font-medium rounded-[6px] transition-all ${
                  deleteConfirm.forEveryone ? 'bg-[#EF4444] text-white hover:opacity-90' : 'bg-[#1A1A1A] text-[#F5F5F5] border border-[#2D2D2D] hover:bg-[#2D2D2D]'
                }`}>
                {deleteConfirm.forEveryone ? 'Delete for Everyone' : 'Delete for Me'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Group Info Panel */}
      <GroupInfoPanel
        conversation={conversation}
        currentUserId={user?.id}
        isOpen={showGroupInfo}
        onClose={() => setShowGroupInfo(false)}
      />

      {/* Contact Info Panel */}
      <ContactInfoPanel
        conversation={conversation}
        currentUserId={user?.id}
        isOpen={showContactInfo}
        onClose={() => setShowContactInfo(false)}
      />
    </div>
  );
};
