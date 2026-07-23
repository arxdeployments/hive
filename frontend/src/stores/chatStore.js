import { create } from 'zustand';

const useChatStore = create((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},
  contacts: [],
  typingUsers: {},
  wsConnected: false,
  wsConnecting: false,

  setConversations: (conversations) => set({ conversations }),

  setActiveConversation: (id) => {
    set({ activeConversationId: id });
  },

  addMessage: (convId, message) => set((state) => {
    const existing = state.messages[convId] || [];
    // Avoid duplicates
    if (existing.find(m => m._id === message._id)) return state;
    return {
      messages: {
        ...state.messages,
        [convId]: [...existing, message]
      }
    };
  }),

  addOptimisticMessage: (convId, message) => set((state) => {
    const existing = state.messages[convId] || [];
    return {
      messages: {
        ...state.messages,
        [convId]: [...existing, message]
      }
    };
  }),

  replaceOptimisticMessage: (convId, tempId, realMessage) => set((state) => {
    const existing = state.messages[convId] || [];
    return {
      messages: {
        ...state.messages,
        [convId]: existing.map(m => m.temp_id === tempId ? { ...m, ...realMessage, status: realMessage.status || 'sent' } : m)
      }
    };
  }),

  setMessages: (convId, messages) => set((state) => ({
    messages: {
      ...state.messages,
      [convId]: messages
    }
  })),

  prependMessages: (convId, olderMessages) => set((state) => {
    const existing = state.messages[convId] || [];
    return {
      messages: {
        ...state.messages,
        [convId]: [...olderMessages, ...existing]
      }
    };
  }),

  updateConversation: (convId, updates) => set((state) => ({
    conversations: state.conversations.map(c =>
      c._id === convId ? { ...c, ...updates } : c
    )
  })),

  setContacts: (contacts) => set({ contacts }),

  updateMessageStatus: (convId, messageId, status) => set((state) => {
    const existing = state.messages[convId] || [];
    return {
      messages: {
        ...state.messages,
        [convId]: existing.map(m => m._id === messageId ? { ...m, status } : m)
      }
    };
  }),

  setTyping: (convId, userId, userName, isTyping) => set((state) => {
    const convTyping = { ...(state.typingUsers[convId] || {}) };
    if (isTyping) {
      convTyping[userId] = userName;
    } else {
      delete convTyping[userId];
    }
    return {
      typingUsers: { ...state.typingUsers, [convId]: convTyping }
    };
  }),

  setWsConnected: (connected) => set({ wsConnected: connected, wsConnecting: false }),
  setWsConnecting: (connecting) => set({ wsConnecting: connecting }),

  // Move conversation to top of list when new message arrives
  bumpConversation: (convId, lastMessage) => set((state) => {
    const convs = state.conversations.map(c =>
      c._id === convId
        ? { ...c, last_message: lastMessage, last_message_at: lastMessage.created_at }
        : c
    );
    // Sort: pinned first, then by last_message_at desc
    const pinned = convs.filter(c => c.is_pinned);
    const unpinned = convs.filter(c => !c.is_pinned);
    unpinned.sort((a, b) => {
      const at = a.last_message?.created_at || a.created_at || '';
      const bt = b.last_message?.created_at || b.created_at || '';
      return bt.localeCompare(at);
    });
    return { conversations: [...pinned, ...unpinned] };
  }),

  incrementUnread: (convId) => set((state) => ({
    conversations: state.conversations.map(c =>
      c._id === convId ? { ...c, unread_count: (c.unread_count || 0) + 1 } : c
    )
  })),

  clearUnread: (convId) => set((state) => ({
    conversations: state.conversations.map(c =>
      c._id === convId ? { ...c, unread_count: 0 } : c
    )
  })),
}));

export default useChatStore;
