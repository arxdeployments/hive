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

/**
 * Everything in this store belongs to one signed-in person: their threads, the
 * message bodies inside them, their colleagues, who is typing. It is the only
 * place the app holds that, and until `reset` existed there was no way to put
 * it down — see the docblock on `reset` for why that mattered.
 *
 * EVERY piece of state belongs in here, not inline further down beside the
 * action that writes it. `reset` is a shallow merge, so a field declared
 * anywhere else is a field `reset` cannot clear — which is exactly how
 * pinnedVersion, added later and next to its own action, survived the first
 * version of this. chatStore.test.js walks the store's data keys and fails if
 * one of them is not restored, so a field added outside this object is caught
 * rather than discovered.
 */
const emptyState = () => ({
  conversations: [],
  activeConversationId: null,
  messages: {},
  contacts: [],
  typingUsers: {},
  wsConnected: false,
  wsConnecting: false,
  // Per-conversation counter that makes the pinned-message banner self-healing;
  // see bumpPinnedVersion below for what it is for. Keyed by conversation id, so
  // left unreset it is a map of the previous user's threads.
  pinnedVersion: {},
});

const useChatStore = create((set) => ({
  ...emptyState(),

  /**
   * Drop every trace of the signed-in user's chat data.
   *
   * Signing out had two shapes and only one of them cleared this. An expired
   * session is torn down by api/client.js with `window.location.href`, a full
   * document navigation that destroys the heap along with everything in it. The
   * sign-out BUTTON is a React Router transition: `logout()` clears the cached
   * user and the route guard renders <Navigate to="/login">, and the JS heap —
   * this store included — is carried straight into the next session in that tab.
   *
   * Which is the wrong way round, because the button is the deliberate one. On a
   * shared clinical workstation it is the end of a shift, and the next person to
   * sign in inherited the tab: activeConversationId still pointed at the last
   * thread the previous user had open, and ChatPanel renders
   * `messages[conversationId]` straight from here, so their messages painted
   * before the refetch that would have replaced them had returned.
   *
   * websocket.js already had to reason about this — its `disconnect` docblock
   * describes a 'failed' row written "into a store nothing clears on logout —
   * which the next login's first fetch would then carry over into someone else's
   * thread". That workaround stays correct; this removes what it was working
   * around.
   */
  reset: () => set(() => emptyState()),

  setConversations: (conversations) => set((state) => (
    sameConversationList(state.conversations, conversations) ? state : { conversations }
  )),

  setActiveConversation: (id) => set((state) => (
    state.activeConversationId === id ? state : { activeConversationId: id }
  )),

  addMessage: (convId, message) => set((state) => {
    const existing = state.messages[convId];
    // Only accumulate into a thread this tab has actually loaded.
    //
    // Every inbound broadcast landed here, for every conversation the user is a
    // member of, whether or not its window had ever been opened — and nothing
    // ever evicted any of it. A long-lived tab in a busy org therefore grew a
    // full message array for threads nobody had looked at, for the life of the
    // session. There is nothing to append to: with no window loaded, ChatPanel
    // fetches the thread from the API when it is opened, so a partial array
    // built from whatever happened to arrive while the tab was open is not a
    // head start, it is a second source of truth.
    //
    // The ACTIVE conversation is exempt and that exemption is load-bearing: its
    // window can legitimately be empty — a thread with no history, or one whose
    // fetch failed and is showing the error strip — and live arrivals still have
    // to paint into it.
    if (!existing?.length && convId !== state.activeConversationId) return state;
    const base = existing || EMPTY_MESSAGES;
    // Avoid duplicates
    if (base.find(m => m._id === message._id)) return state;
    return {
      messages: {
        ...state.messages,
        [convId]: [...base, message]
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

  /**
   * Fold one directory record into the cache.
   *
   * The contact panel reads this map before it fetches, and it used to be filled
   * as a side effect of that panel pulling the ENTIRE org roster. Now that it
   * asks for one record by id, this is what keeps the cache warm — without it
   * the lookup at the top of that panel would miss every single time, which is
   * a dead cache rather than an absent one.
   */
  upsertContact: (contact) => set((state) => {
    if (!contact?.id) return state;
    const existing = state.contacts || [];
    const at = existing.findIndex((c) => c.id === contact.id);
    if (at < 0) return { contacts: [...existing, contact] };
    // Identity is the store's render contract: leave the array alone when the
    // record has not actually changed.
    if (existing[at] === contact) return state;
    const next = existing.slice();
    next[at] = { ...existing[at], ...contact };
    return { contacts: next };
  }),

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
  bumpPinnedVersion: (convId) => set((state) => ({
    pinnedVersion: { ...state.pinnedVersion, [convId]: (state.pinnedVersion[convId] || 0) + 1 },
  })),

  /**
   * Apply a pin change (from my own toggle, or from a conversation_pin_update
   * frame sent by another of my tabs) and re-sort.
   *
   * updateConversation deliberately does NOT re-sort, so using it here would flip
   * the pin badge while leaving the row where it was until the next inbound
   * message or refetch.
   */
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
