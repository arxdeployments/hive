import { create } from 'zustand';

// Shared empty values so selectors for a missing conversation return a stable
// reference — otherwise `s.messages[id] || []` mints a new array every render
// and every subscriber re-renders on every unrelated store write.
export const EMPTY_MESSAGES = [];
export const EMPTY_TYPING = {};

/**
 * Identity is the render contract in this store: components (and MessageBubble's
 * memo) compare message/conversation objects by reference, so every reducer must
 * return the *same* object when nothing about it changed. Blind `.map()` writes
 * hand out fresh identities for untouched rows and defeat every memo downstream.
 */
const sameConversationList = (prev, next) =>
  prev.length === next.length && prev.every((c, i) => c === next[i]);

/**
 * The sidebar's ordering, kept deliberately identical to the server's ORDER BY in
 * backend/app/api/conversations.py:
 *
 *   is_pinned DESC, pin_order ASC NULLS LAST, last_message_at DESC
 *
 * The list arrives pre-sorted from the API, so this only has to reproduce that
 * order when the client mutates it locally — an inbound message bumping a row, or
 * a pin toggle. Previously this logic lived inline in bumpConversation and knew
 * nothing about pin_order, so it kept pinned rows in whatever order they happened
 * to arrive in and a user's chosen order was lost on the first message.
 *
 * Keep the two in sync: if the ORDER BY changes, change this.
 */
const conversationTime = (c) =>
  c.last_message?.created_at || c.last_message_at || c.created_at || '';

export const sortConversations = (convs) => {
  const sorted = [...convs];
  sorted.sort((a, b) => {
    const ap = !!a.is_pinned;
    const bp = !!b.is_pinned;
    if (ap !== bp) return ap ? -1 : 1;
    if (ap && bp) {
      // NULLS LAST, matching Postgres.
      const an = a.pin_order === null || a.pin_order === undefined;
      const bn = b.pin_order === null || b.pin_order === undefined;
      if (an !== bn) return an ? 1 : -1;
      if (!an && a.pin_order !== b.pin_order) return a.pin_order - b.pin_order;
    }
    return conversationTime(b).localeCompare(conversationTime(a));
  });
  return sorted;
};

const useChatStore = create((set) => ({
  conversations: [],
  activeConversationId: null,
  messages: {},
  contacts: [],
  typingUsers: {},
  wsConnected: false,
  wsConnecting: false,

  setConversations: (conversations) => set((state) => (
    sameConversationList(state.conversations, conversations) ? state : { conversations }
  )),

  setActiveConversation: (id) => set((state) => (
    state.activeConversationId === id ? state : { activeConversationId: id }
  )),

  addMessage: (convId, message) => set((state) => {
    const existing = state.messages[convId] || EMPTY_MESSAGES;
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
    const existing = state.messages[convId] || EMPTY_MESSAGES;
    return {
      messages: {
        ...state.messages,
        [convId]: [...existing, message]
      }
    };
  }),

  replaceOptimisticMessage: (convId, tempId, realMessage) => set((state) => {
    const existing = state.messages[convId];
    if (!existing) return state;
    let changed = false;
    const next = existing.map(m => {
      if (m.temp_id !== tempId) return m;
      changed = true;
      return { ...m, ...realMessage, status: realMessage.status || 'sent' };
    });
    return changed ? { messages: { ...state.messages, [convId]: next } } : state;
  }),

  // Callers often hand back an array whose rows are all the previous objects
  // (e.g. a `.map()` that matched nothing). Keep the old array in that case so
  // the message list doesn't re-render for a write that changed nothing.
  setMessages: (convId, messages) => set((state) => {
    const prev = state.messages[convId];
    if (prev && prev.length === messages.length && prev.every((m, i) => m === messages[i])) {
      return state;
    }
    return {
      messages: {
        ...state.messages,
        [convId]: messages
      }
    };
  }),

  prependMessages: (convId, olderMessages) => set((state) => {
    const existing = state.messages[convId] || EMPTY_MESSAGES;
    // Dedupe against what is already loaded. The `before` cursor is exclusive so
    // pages should not overlap, but an `around` window followed by a backwards
    // page makes overlap possible, and a duplicate _id renders the row twice and
    // breaks Virtuoso's keying.
    const seen = new Set(existing.map(m => m._id));
    const fresh = olderMessages.filter(m => !seen.has(m._id));
    if (fresh.length === 0) return state;
    return {
      messages: {
        ...state.messages,
        [convId]: [...fresh, ...existing]
      }
    };
  }),

  updateConversation: (convId, updates) => set((state) => {
    let changed = false;
    const conversations = state.conversations.map(c => {
      if (c._id !== convId) return c;
      changed = true;
      return { ...c, ...updates };
    });
    return changed ? { conversations } : state;
  }),

  /**
   * Patch one user's participant record across every conversation in one write.
   * Presence and profile broadcasts arrive constantly; doing this per-conversation
   * cost one store notification and one full-list rebuild *each*, which re-rendered
   * the whole sidebar even for conversations the user isn't in.
   */
  updateParticipantEverywhere: (userId, patch) => set((state) => {
    let changed = false;
    const conversations = state.conversations.map(c => {
      if (!c.participants?.some(p => p.user_id === userId)) return c;
      changed = true;
      return {
        ...c,
        participants: c.participants.map(p => (p.user_id === userId ? { ...p, ...patch } : p)),
      };
    });
    return changed ? { conversations } : state;
  }),

  setContacts: (contacts) => set({ contacts }),

  updateMessageStatus: (convId, messageId, status) => set((state) => {
    const existing = state.messages[convId];
    if (!existing) return state;
    let changed = false;
    const next = existing.map(m => {
      if (m._id !== messageId || m.status === status) return m;
      changed = true;
      return { ...m, status };
    });
    return changed ? { messages: { ...state.messages, [convId]: next } } : state;
  }),

  setTyping: (convId, userId, userName, isTyping) => set((state) => {
    const current = state.typingUsers[convId] || EMPTY_TYPING;
    if (isTyping ? current[userId] === userName : !(userId in current)) return state;
    const convTyping = { ...current };
    if (isTyping) {
      convTyping[userId] = userName;
    } else {
      delete convTyping[userId];
    }
    return {
      typingUsers: { ...state.typingUsers, [convId]: convTyping }
    };
  }),

  setWsConnected: (connected) => set((state) => (
    state.wsConnected === connected && !state.wsConnecting
      ? state
      : { wsConnected: connected, wsConnecting: false }
  )),
  setWsConnecting: (connecting) => set((state) => (
    state.wsConnecting === connecting ? state : { wsConnecting: connecting }
  )),

  // Move conversation to top of list when new message arrives
  bumpConversation: (convId, lastMessage) => set((state) => {
    const convs = state.conversations.map(c =>
      c._id === convId
        ? { ...c, last_message: lastMessage, last_message_at: lastMessage.created_at }
        : c
    );
    const conversations = sortConversations(convs);
    return sameConversationList(state.conversations, conversations) ? state : { conversations };
  }),

  /**
   * Apply a pin change (from my own toggle, or from a conversation_pin_update
   * frame sent by another of my tabs) and re-sort.
   *
   * updateConversation deliberately does NOT re-sort, so using it here would flip
   * the pin badge while leaving the row where it was until the next inbound
   * message or refetch.
   */
  /**
   * Bumped whenever a message_pin_update arrives for a conversation, so
   * ChatPanel's /pinned fetch can re-run.
   *
   * The WS handler can only patch is_pinned on messages already in the store,
   * which left two live bugs: a remote pin of a message OUTSIDE my loaded window
   * never appeared in the banner until I reopened the chat, and a remote UNPIN of
   * a message in my /pinned list but not loaded left a PHANTOM pin in the banner
   * for ever — tapping it just toasted "not loaded yet". A version counter is
   * enough to make the fetch self-healing without teaching the socket layer about
   * the banner's data shape.
   */
  pinnedVersion: {},
  bumpPinnedVersion: (convId) => set((state) => ({
    pinnedVersion: { ...state.pinnedVersion, [convId]: (state.pinnedVersion[convId] || 0) + 1 },
  })),

  setConversationPinned: (convId, isPinned, pinOrder) => set((state) => {
    const convs = state.conversations.map(c => (
      c._id === convId
        ? { ...c, is_pinned: !!isPinned, pin_order: pinOrder ?? null }
        : c
    ));
    const conversations = sortConversations(convs);
    return sameConversationList(state.conversations, conversations) ? state : { conversations };
  }),

  incrementUnread: (convId) => set((state) => {
    let changed = false;
    const conversations = state.conversations.map(c => {
      if (c._id !== convId) return c;
      changed = true;
      return { ...c, unread_count: (c.unread_count || 0) + 1 };
    });
    return changed ? { conversations } : state;
  }),

  clearUnread: (convId) => set((state) => {
    let changed = false;
    const conversations = state.conversations.map(c => {
      if (c._id !== convId || !c.unread_count) return c;
      changed = true;
      return { ...c, unread_count: 0 };
    });
    return changed ? { conversations } : state;
  }),
}));

export default useChatStore;
