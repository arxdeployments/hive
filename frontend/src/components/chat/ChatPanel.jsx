import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { motion } from 'framer-motion';
import {
  ArrowLeft, Search, ChevronDown, X, Check, Pin, Star, StarOff, Forward,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Virtuoso } from 'react-virtuoso';
import { MessageBubble } from './MessageBubble';
import { MessageComposer } from './MessageComposer';
import { DateSeparator } from './DateSeparator';
import { TypingIndicator } from './TypingIndicator';
import { EmptyChat } from './EmptyChat';
import { GroupInfoPanel } from './GroupInfoPanel';
import { MessageContextMenu } from './MessageContextMenu';
import { ChatHeaderMenu } from './ChatHeaderMenu';
import { CallButtonDropdown } from './CallButtonDropdown';
import { ReplyPreview } from './ReplyPreview';
import { ReactionPicker } from './ReactionPicker';
import { ForwardModal } from './ForwardModal';
import { MessageInfoModal } from './MessageInfoModal';
import { ConversationSearch } from './ConversationSearch';
import { ContactInfoPanel } from './ContactInfoPanel';
import { CreateGroupModal } from './CreateGroupModal';
import { ConfirmDialog } from './info/InfoPanelPrimitives';
import useChatStore, { EMPTY_MESSAGES, EMPTY_TYPING } from '../../stores/chatStore';
import useCallStore from '../../stores/callStore';
import { useAuth } from '../../contexts/AuthContext';
import client from '../../api/client';
import wsClient from '../../services/websocket';
import { withDerivedStatuses } from '../../utils/messageStatus';
import { toast } from 'sonner';

const EMPTY_PINNED = [];

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

/** One-line summary of a message, for the pinned banner and confirm dialogs. */
const messagePreview = (msg) => {
  if (!msg) return '';
  if (msg.is_deleted) return 'This message was deleted';
  switch (msg.type) {
    case 'image': return '📷 Photo';
    case 'video': return '🎥 Video';
    case 'audio': return '🎤 Audio';
    case 'file': return `📎 ${msg.filename || msg.content || 'File'}`;
    default: return (msg.content || '').slice(0, 140);
  }
};

/**
 * "Reply privately" quotes the original message as text rather than as a real
 * reply: the API only links `reply_to` within the same conversation (see
 * messaging.send_message), so a cross-chat reply id is silently dropped and the
 * quote would vanish the moment the message came back from the server.
 */
const privateQuoteFor = (msg) => {
  const who = msg?.sender_name || 'Them';
  const body = msg?.type === 'text' ? (msg.content || '') : messagePreview(msg);
  const snippet = body.length > 180 ? `${body.slice(0, 180)}…` : body;
  return `> ${who}: ${snippet}\n\n`;
};

export const ChatPanel = ({ conversationId, onBack, isMobile }) => {
  const { user } = useAuth();

  // Narrow selectors, not `useChatStore()`. Subscribing to the whole store made
  // this panel (and the virtualized list under it) re-render on *every* store
  // write anywhere in the app — another conversation's message, a presence
  // broadcast, someone typing in a thread you don't have open.
  const conversation = useChatStore(s => s.conversations.find(c => c._id === conversationId));
  const convMessages = useChatStore(s => s.messages[conversationId] || EMPTY_MESSAGES);
  const convTyping = useChatStore(s => s.typingUsers?.[conversationId] || EMPTY_TYPING);
  const wsConnected = useChatStore(s => s.wsConnected);
  // Actions are created once with the store, so selecting them never re-renders.
  const setMessages = useChatStore(s => s.setMessages);
  const prependMessages = useChatStore(s => s.prependMessages);
  const addOptimisticMessage = useChatStore(s => s.addOptimisticMessage);
  const clearUnread = useChatStore(s => s.clearUnread);
  const bumpConversation = useChatStore(s => s.bumpConversation);
  const updateConversation = useChatStore(s => s.updateConversation);
  // Subscribed, not read through getState() at render time: the old header read
  // the store during render, so the call buttons never restyled when a call
  // started and could be clicked into a second, doomed call.
  const callState = useCallStore(s => s.callState);

  const [loading, setLoading] = useState(false);
  // Keyed by conversation: a single `hasMore` flag leaked the previous thread's
  // pagination state onto the next one now that re-opens serve from cache.
  const [hasMoreByConv, setHasMoreByConv] = useState({});
  const [loadingMore, setLoadingMore] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [draft, setDraft] = useState(null);
  const [editingMessage, setEditingMessage] = useState(null);
  const [editText, setEditText] = useState('');
  const [reactionPicker, setReactionPicker] = useState(null);
  const [forwardBatch, setForwardBatch] = useState(null);
  const [msgInfo, setMsgInfo] = useState(null);
  const [showConvSearch, setShowConvSearch] = useState(false);
  // Info drawers. `section` is re-armed on every open so "Group info" lands on
  // Info while "Select people" lands straight on Members.
  const [groupInfo, setGroupInfo] = useState({ open: false, section: 'info' });
  const [contactInfo, setContactInfo] = useState({ open: false, section: 'info' });
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const [showNewGroupCall, setShowNewGroupCall] = useState(false);
  // Multi-select
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Pinned banner
  const [pinnedFromApi, setPinnedFromApi] = useState(EMPTY_PINNED);
  const [pinCursor, setPinCursor] = useState(0);

  const virtuosoRef = useRef(null);

  const myUserId = user?.id;
  const myName = user?.name;
  const hasMore = hasMoreByConv[conversationId] ?? false;
  const callBusy = callState !== 'idle';

  const otherParticipant = conversation?.participants?.find(
    p => p.user_id !== user?.id
  );
  const isDirect = conversation?.type === 'direct';
  const isGroup = conversation?.type === 'group';
  const isGroupLike = conversation?.type === 'group' || conversation?.type === 'cross_org';
  const headerType = isDirect ? 'direct' : 'group';

  const displayName = isDirect
    ? otherParticipant?.display_name || 'Unknown'
    : conversation?.name || 'Group';

  const statusText = isDirect
    ? formatStatus(otherParticipant)
    : `${conversation?.participants?.length || 0} members`;

  /**
   * Conversations whose full first window this panel has actually fetched.
   *
   * "There are messages in the store" is NOT the same thing: the socket's
   * new_message handler appends to *every* conversation, so a thread you have
   * never opened can hold a single message. Serving that from cache would show
   * a one-message thread. Only a window we fetched ourselves may be reused.
   */
  const loadedWindowsRef = useRef(new Set());
  useEffect(() => {
    // A fresh socket session invalidates nothing that is already loaded, but a
    // disconnect does: force the next open of each thread to re-fetch.
    if (!wsConnected) loadedWindowsRef.current = new Set();
  }, [wsConnected]);

  /**
   * Load the message window for this conversation.
   *
   * Cache-first: while the socket is up it applies every new_message, edit,
   * delete and reaction to *every* cached thread, not just the open one — so a
   * window we already loaded is already current. Re-fetching it on each open
   * cost a round trip, a full-screen spinner, and a rebuild of every message
   * object (new identities => every bubble re-renders). Re-opening now paints
   * from the store on the same frame as the click.
   *
   * `force` is the escape hatch for the one case the cache can be stale: a
   * socket reconnect, where messages may have been missed while it was down.
   */
  const fetchMessages = useCallback(async ({ force = false } = {}) => {
    if (!conversationId) return;
    const cached = useChatStore.getState().messages[conversationId];
    const hasWindow = loadedWindowsRef.current.has(conversationId)
      && Array.isArray(cached) && cached.length > 0;
    if (hasWindow && !force) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await client.get(`/api/conversations/${conversationId}/messages`, {
        params: { limit: 50 }
      });
      // Loaded messages have no `status` — derive the ticks from the read_by /
      // delivered_to receipts the API sends, or every own message reads as unread.
      const fetched = withDerivedStatuses(data.messages, myUserId);

      // Carry over 'failed' bubbles, which the server has never seen.
      //
      // A text send can now fail on BOTH transports — socket not open AND the
      // HTTP fallback rejected, i.e. the whole network is down — and when it
      // does, the optimistic bubble is the only record of it: nothing queues the
      // frame for replay any more. This refetch is force-run the moment the
      // socket reconnects, and setMessages replaces the array wholesale, so
      // without this the user's message was deleted on reconnect with no bubble,
      // no error and no way to retry.
      //
      // These cannot be auto-reconciled: the GET carries no temp_id (the API
      // only echoes it on the send response), so they stay until the user
      // retries or reloads. Scoped to 'failed' only, deliberately NOT
      // 'sending' — there is no ack timeout anywhere, so a preserved 'sending'
      // bubble would hang for ever.
      const failedLocal = (useChatStore.getState().messages[conversationId] || EMPTY_MESSAGES)
        .filter(m => m.status === 'failed');
      setMessages(conversationId, failedLocal.length ? [...fetched, ...failedLocal] : fetched);
      setHasMoreByConv(prev => ({ ...prev, [conversationId]: data.has_more }));
      loadedWindowsRef.current.add(conversationId);
    } catch (err) {
      console.error('Failed to fetch messages', err);
    } finally {
      setLoading(false);
    }
  }, [conversationId, setMessages, myUserId]);

  useEffect(() => {
    fetchMessages();
    // Mark read server-side; the API broadcasts messages_read to the other side,
    // so no separate WS read-receipt frame is needed here.
    if (conversationId) {
      client.put(`/api/conversations/${conversationId}/read`).catch(() => {});
      clearUnread(conversationId);
    }
  }, [fetchMessages, conversationId, clearUnread]);

  // Re-sync the open thread after a socket reconnect — that is the only window
  // in which the cache can have missed messages.
  const wasConnectedRef = useRef(wsConnected);
  useEffect(() => {
    if (wsConnected && !wasConnectedRef.current) fetchMessages({ force: true });
    wasConnectedRef.current = wsConnected;
  }, [wsConnected, fetchMessages]);

  /**
   * Pinned messages for the banner. Fetched once per conversation because a pin
   * can live far outside the loaded window; live pins/unpins are folded in from
   * the store below, so the banner reacts instantly without a second round trip.
   */
  useEffect(() => {
    if (!conversationId) {
      setPinnedFromApi(EMPTY_PINNED);
      return undefined;
    }
    let cancelled = false;
    client.get(`/api/conversations/${conversationId}/pinned`)
      .then(({ data }) => {
        if (!cancelled) setPinnedFromApi(Array.isArray(data?.data) ? data.data : EMPTY_PINNED);
      })
      .catch(() => {
        if (!cancelled) setPinnedFromApi(EMPTY_PINNED);
      });
    return () => { cancelled = true; };
  }, [conversationId]);

  // `pendingDraftRef` survives the conversation switch that "Reply privately"
  // triggers — the reset effect below would otherwise wipe it on arrival.
  const pendingDraftRef = useRef(null);

  // Reset transient per-conversation state when switching conversations.
  useEffect(() => {
    setEditingMessage(null);
    setEditText('');
    setReplyTo(null);
    setContextMenu(null);
    setReactionPicker(null);
    setShowConvSearch(false);
    setSelectionMode(false);
    setSelectedIds(new Set());
    setPinCursor(0);
    setDraft(pendingDraftRef.current);
    pendingDraftRef.current = null;
  }, [conversationId]);

  // Read receipts for messages arriving in the open conversation are sent by the
  // socket's own new_message handler, and the open itself is acked by PUT /read
  // above. The effect that used to live here duplicated both — two receipt
  // frames per inbound message, each triggering its own messages_read fan-out.
  //
  // Auto-scroll is Virtuoso's `followOutput` (below). The manual scrollToIndex
  // that used to run here fought it with a second smooth animation.

  // Load older messages
  const loadMore = useCallback(async () => {
    if (!hasMore || loadingMore || !conversationId) return;
    // Read the window straight from the store: depending on the whole `messages`
    // map here rebuilt this callback on every message anywhere in the app.
    const msgs = useChatStore.getState().messages[conversationId] || EMPTY_MESSAGES;
    if (msgs.length === 0) return;

    setLoadingMore(true);
    try {
      const oldestMsg = msgs[0];
      const { data } = await client.get(`/api/conversations/${conversationId}/messages`, {
        params: { before: oldestMsg._id, limit: 50 }
      });
      if (data.messages.length > 0) {
        prependMessages(conversationId, withDerivedStatuses(data.messages, myUserId));
      }
      setHasMoreByConv(prev => ({ ...prev, [conversationId]: data.has_more }));
    } catch (err) {
      console.error('Failed to load more messages', err);
    } finally {
      setLoadingMore(false);
    }
  }, [hasMore, loadingMore, conversationId, prependMessages, myUserId]);

  // `replyTo` is read through a ref so handleSend keeps a stable identity across
  // reply-preview changes — it is passed to the memoised composer, which would
  // otherwise re-render (and re-render the list with it) on every keystroke.
  const replyToRef = useRef(replyTo);
  replyToRef.current = replyTo;

  // Send message - optimistic UI, WS delivery handled by MessageComposer.
  // replyOverride: pass explicitly (incl. null) to bypass the live replyTo state (used by retry).
  const handleSend = useCallback(async (content, tempId, msgType = 'text', mediaUrl = null, thumbnailUrl = null, replyOverride) => {
    if (!conversationId) return;
    if (msgType === 'text' && (!content || !content.trim())) return;

    // Capture the reply context up-front: replyTo state may be cleared before async work resolves.
    const activeReply = replyOverride !== undefined ? replyOverride : replyToRef.current;
    const replyToId = activeReply?._id || null;

    const optimisticMsg = {
      _id: tempId,
      temp_id: tempId,
      conversation_id: conversationId,
      sender_id: myUserId,
      sender_name: myName,
      type: msgType,
      content: content,
      media_url: mediaUrl,
      thumbnail_url: thumbnailUrl,
      reply_to: replyToId,
      reply_to_message: activeReply ? {
        _id: activeReply._id,
        sender_name: activeReply.sender_name,
        content: activeReply.content,
        type: activeReply.type,
      } : null,
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
      sender_id: myUserId,
      sender_name: myName,
      created_at: new Date().toISOString(),
      type: 'text'
    });

    // Text is delivered over the WebSocket by whoever called us; this fallback
    // POSTs it while the socket is down.
    //
    // The condition is wsClient.isOpen(), NOT the wsConnected store value, and
    // that matters. Every caller that might also send over the socket checks
    // the same isOpen() inside this same synchronous call stack — no await
    // separates them, so readyState cannot change in between and the two can
    // never disagree. Two independent React reads could: a stale-true pair
    // duplicates the message, a stale-false pair loses it. wsConnected is also
    // false for the whole CONNECTING window, where a queued frame would later
    // replay on top of this POST.
    //
    // Media is deliberately NOT delivered here, at any connection state. Every
    // media path POSTs the message itself, because it has to attach the
    // uploaded media_url: MessageComposer.sendMediaFile for a fresh send, and
    // handleRetry below for a retry. Falling back for media as well meant one
    // file became TWO server messages whenever the socket was down — the send
    // path does not dedupe on temp_id (services/messaging.py only echoes it
    // back), and _claim_upload does not reject an already-claimed upload, so
    // both POSTs persisted as separate messages sharing one storage key.
    if (msgType === 'text' && !wsClient.isOpen()) {
      try {
        const { data } = await client.post(`/api/conversations/${conversationId}/messages`, {
          content,
          type: msgType,
          media_url: mediaUrl,
          thumbnail_url: thumbnailUrl,
          temp_id: tempId,
          reply_to: replyToId,
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

    // Clear reply state after sending (only when driven by the composer, not a retry override)
    if (replyOverride === undefined) setReplyTo(null);
    // No wsConnected dependency: the transport decision now reads the live
    // socket via wsClient.isOpen(), so this keeps a stable identity across
    // connect/disconnect. It is handed to a memoised composer, which previously
    // re-rendered — and re-rendered the message list with it — on every socket
    // state change.
  }, [conversationId, myUserId, myName, addOptimisticMessage, bumpConversation]);

  // Retry a failed send: drop the failed bubble and re-send down the same path as handleSend.
  const handleRetry = useCallback((failedMsg) => {
    if (!failedMsg || !conversationId) return;

    const store = useChatStore.getState();
    const removeKey = failedMsg.temp_id || failedMsg._id;
    store.setMessages(conversationId,
      (store.messages[conversationId] || EMPTY_MESSAGES).filter(m => (m.temp_id || m._id) !== removeKey)
    );

    const newTempId = uuidv4();
    const msgType = failedMsg.type || 'text';
    const replyCtx = failedMsg.reply_to_message || null;
    const replyId = replyCtx?._id || failedMsg.reply_to || null;

    // Re-add the optimistic bubble (+ HTTP fallback when disconnected) via the shared path.
    handleSend(failedMsg.content, newTempId, msgType, failedMsg.media_url || null, failedMsg.thumbnail_url || null, replyCtx);

    // Deliver over whichever transport owns this message type, mirroring the
    // split in MessageComposer.
    if (msgType === 'text') {
      // Only when the socket is open: handleSend's HTTP fallback above covers
      // the closed case, and doing both would double-send. Same isOpen() call
      // handleSend just made, in the same synchronous stack, so the two
      // decisions cannot diverge.
      if (wsClient.isOpen()) {
        wsClient.sendMessage(conversationId, failedMsg.content, newTempId, replyId);
      }
    } else {
      // Media is always created over HTTP, connected or not, because handleSend
      // deliberately does not POST for media. Previously this sat inside the
      // `if (wsConnected)` branch and relied on that fallback while offline;
      // now that the fallback is text-only, retry owns media delivery outright.
      client.post(`/api/conversations/${conversationId}/messages`, {
        content: failedMsg.content,
        type: msgType,
        media_url: failedMsg.media_url || null,
        thumbnail_url: failedMsg.thumbnail_url || null,
        temp_id: newTempId,
        reply_to: replyId,
      }).then(({ data }) => {
        // Media has no WS message_ack to reconcile against, so this response is
        // the only thing that can hand the bubble its real _id and status —
        // exactly the reasoning in MessageComposer.sendMediaFile. Without it the
        // bubble sits on 'sending' forever holding a temp uuid, and every
        // id-keyed action (star, pin, delete, reply) then sends that dead id to
        // the API. Retrying media used to be reconciled by handleSend's HTTP
        // fallback; now that the fallback is text-only, this path owns it.
        useChatStore.getState().replaceOptimisticMessage(conversationId, newTempId, data);
      }).catch(() => {
        useChatStore.getState().replaceOptimisticMessage(conversationId, newTempId, { status: 'failed' });
      });
    }
  }, [conversationId, handleSend]);

  // ── Multi-select ──────────────────────────────────────────────────────────
  const enterSelection = useCallback((seedMessage) => {
    setContextMenu(null);
    setReactionPicker(null);
    setSelectionMode(true);
    setSelectedIds(seedMessage?._id ? new Set([seedMessage._id]) : new Set());
  }, []);

  const exitSelection = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((messageId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  // Escape leaves selection mode. Bound only while it is active so it never
  // competes with the menus' own Escape handling.
  useEffect(() => {
    if (!selectionMode) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        exitSelection();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectionMode, exitSelection]);

  const selectedMessages = useMemo(
    () => (selectedIds.size === 0 ? EMPTY_MESSAGES : convMessages.filter(m => selectedIds.has(m._id))),
    [convMessages, selectedIds]
  );

  /** Patch one message in place, preserving every other row's identity. */
  const patchMessage = useCallback((messageId, patch) => {
    const store = useChatStore.getState();
    const list = store.messages[conversationId];
    if (!list) return;
    let changed = false;
    const next = list.map((m) => {
      if (m._id !== messageId) return m;
      changed = true;
      return { ...m, ...patch };
    });
    if (changed) store.setMessages(conversationId, next);
  }, [conversationId]);

  const allSelectedStarred = selectedMessages.length > 0 && selectedMessages.every(m => m.is_starred);

  const handleBatchStar = useCallback(async () => {
    // The endpoint is a toggle, so only touch the messages whose state actually
    // needs to change — otherwise "Star" would unstar whatever was already starred.
    const targets = selectedMessages.filter(m => !!m.is_starred === allSelectedStarred);
    if (targets.length === 0) { exitSelection(); return; }
    const wanted = !allSelectedStarred;
    targets.forEach(m => patchMessage(m._id, { is_starred: wanted }));
    exitSelection();
    const results = await Promise.allSettled(
      targets.map(m => client.post(`/api/conversations/messages/${m._id}/star`))
    );
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      results.forEach((r, i) => {
        if (r.status === 'rejected') patchMessage(targets[i]._id, { is_starred: !wanted });
      });
      toast.error(`Failed to ${wanted ? 'star' : 'unstar'} ${failed} message(s)`);
      return;
    }
    toast.success(wanted
      ? `${targets.length} message${targets.length === 1 ? '' : 's'} starred`
      : `${targets.length} message${targets.length === 1 ? '' : 's'} unstarred`);
  }, [selectedMessages, allSelectedStarred, patchMessage, exitSelection]);

  // handleBatchDelete removed with the message-deletion feature. Selection mode
  // keeps its Star/Unstar and Forward bulk actions.

  // ── Message context menu ──────────────────────────────────────────────────
  const handleContextMenu = useCallback((e, msg) => {
    e.preventDefault();
    // Raw viewport coords: MessageContextMenu measures itself and flips rather
    // than clipping, so pre-clamping here only moved the anchor off the bubble.
    setContextMenu({ message: msg, position: { x: e.clientX, y: e.clientY } });
  }, []);

  /**
   * Open (or create) the DM with `userId`, optionally seeding the composer with
   * a quote of `quoteMsg` — the "Reply privately" / "Message <sender>" path.
   */
  const openDirectWith = useCallback(async (userId, quoteMsg) => {
    if (!userId || userId === myUserId) return;
    try {
      const { data } = await client.post('/api/conversations/direct', { participant_id: userId });
      const store = useChatStore.getState();
      // The socket also broadcasts conversation_created, but the panel must be
      // able to render the thread on this frame — not whenever that lands.
      if (!store.conversations.some(c => c._id === data._id)) {
        store.setConversations([data, ...store.conversations]);
      }
      const seed = quoteMsg
        ? { token: `${quoteMsg._id}-${Date.now()}`, text: privateQuoteFor(quoteMsg) }
        : null;
      if (data._id === conversationId) {
        // Already open: the conversation-switch effect that normally applies the
        // pending draft will never fire, so seed the composer directly.
        if (seed) setDraft(seed);
        return;
      }
      pendingDraftRef.current = seed;
      store.setActiveConversation(data._id);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to open chat');
    }
  }, [myUserId, conversationId]);

  /**
   * Every row of MessageContextMenu lands here. Star, pin, copy and report are
   * carried out inside the menu itself (see its header contract) — repeating
   * their requests here would undo them, since star/pin are toggles.
   */
  const handleMessageAction = useCallback(async (action, msg) => {
    const anchor = contextMenu?.position;
    setContextMenu(null);
    switch (action) {
      case 'reply':
        setEditingMessage(null);
        setReplyTo(msg);
        break;
      case 'edit':
        // Only own, non-deleted, text/media messages are editable
        if (msg.sender_id === myUserId && !msg.is_deleted && ['text', 'image', 'file'].includes(msg.type)) {
          setReplyTo(null);
          setEditingMessage(msg);
          setEditText(msg.content || '');
        }
        break;
      case 'react':
        setReactionPicker({
          message: msg,
          position: {
            x: Math.min(Math.max(8, anchor?.x ?? 300), Math.max(8, window.innerWidth - 300)),
            y: Math.min(Math.max(70, anchor?.y ?? 300), window.innerHeight - 20),
          },
        });
        break;
      case 'forward':
        setForwardBatch([msg]);
        break;
      case 'info':
        try {
          const { data } = await client.get(`/api/conversations/messages/${msg._id}/info`);
          setMsgInfo(data);
        } catch {
          toast.error('Failed to load message info');
        }
        break;
      case 'select':
        enterSelection(msg);
        break;
      case 'reply-privately':
        openDirectWith(msg.sender_id, msg);
        break;
      case 'message-user':
        openDirectWith(msg.sender_id, null);
        break;
      // star / pin / copy / report are executed inside MessageContextMenu.
      case 'star':
      case 'pin':
      case 'copy':
      case 'report':
      default:
        break;
    }
  }, [contextMenu, myUserId, enterSelection, openDirectWith]);

  // ── Calls ─────────────────────────────────────────────────────────────────
  const startCall = useCallback((callType) => {
    if (!conversationId) return;
    if (useCallStore.getState().callState !== 'idle') {
      toast.error('You are already in a call');
      return;
    }
    if (isDirect && otherParticipant) {
      wsClient.send({
        type: 'call:initiate',
        callee_id: otherParticipant.user_id,
        call_type: callType,
        conversation_id: conversationId,
      });
      useCallStore.getState().initiateCall(null, callType, false, conversationId);
    } else if (isGroupLike) {
      wsClient.send({ type: 'call:group_initiate', conversation_id: conversationId, call_type: callType });
      useCallStore.getState().initiateCall(null, callType, true, conversationId);
    }
  }, [conversationId, isDirect, isGroupLike, otherParticipant]);

  /** CallButtonDropdown: send-call-link and schedule-call are done inside it. */
  const handleCallAction = useCallback((action) => {
    switch (action) {
      case 'voice':
        startCall('voice');
        break;
      case 'video':
        startCall('video');
        break;
      case 'select-people':
        // "Select people" is the group's member list — the only place a call's
        // participants can be inspected today.
        setGroupInfo({ open: true, section: 'members' });
        break;
      default:
        break;
    }
  }, [startCall]);

  const closeChat = useCallback(() => {
    exitSelection();
    if (onBack) onBack();
    else useChatStore.getState().setActiveConversation(null);
  }, [onBack, exitSelection]);

  /** ChatHeaderMenu: mute, new-window, send-call-link and schedule-call are done inside it. */
  const handleHeaderAction = useCallback((action, payload) => {
    switch (action) {
      case 'info':
        if (isDirect) setContactInfo({ open: true, section: 'info' });
        else setGroupInfo({ open: true, section: 'info' });
        break;
      case 'search':
        setShowConvSearch(true);
        break;
      case 'select':
        enterSelection(null);
        break;
      case 'mute':
        // The request already happened inside the menu; mirror the confirmed
        // value into the store so the info drawers and the sidebar agree.
        if (typeof payload?.is_muted === 'boolean') {
          updateConversation(conversationId, { is_muted: payload.is_muted });
        }
        break;
      case 'exit':
        if (conversation?.cross_org) {
          toast.error('Cross-organization groups are managed by an administrator');
          return;
        }
        setLeaveConfirm(true);
        break;
      case 'new-group-call':
        // A group call needs a group. Build one seeded with this contact, then
        // ring it the moment it exists.
        setShowNewGroupCall(true);
        break;
      case 'close':
        closeChat();
        break;
      // new-window / send-call-link / schedule-call are executed inside the menu.
      default:
        break;
    }
  }, [isDirect, conversationId, conversation?.cross_org, enterSelection, updateConversation, closeChat]);

  const handleLeaveGroup = useCallback(async () => {
    if (!conversationId) return;
    setLeaveBusy(true);
    try {
      await client.post(`/api/conversations/${conversationId}/leave`);
      toast.success('Left group');
      setLeaveConfirm(false);
      closeChat();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to leave group');
    } finally {
      setLeaveBusy(false);
    }
  }, [conversationId, closeChat]);

  // Reaction click on badge
  const handleReactionClick = useCallback(async (messageId, emoji) => {
    try {
      await client.post(`/api/conversations/messages/${messageId}/react`, { emoji });
    } catch {
      toast.error('Failed to react');
    }
  }, []);

  // React from picker
  const handleReactFromPicker = useCallback(async (emoji) => {
    const target = reactionPicker?.message;
    if (!target) return;
    try {
      await client.post(`/api/conversations/messages/${target._id}/react`, { emoji });
    } catch {
      toast.error('Failed to react');
    }
  }, [reactionPicker]);

  // handleDelete removed with the message-deletion feature; there is no DELETE
  // endpoint left to call.

  // Cancel an in-progress edit
  const cancelEdit = () => {
    setEditingMessage(null);
    setEditText('');
  };

  // Save an edited message: optimistic store update + PUT (WS 'message_edited' reconciles)
  const handleSaveEdit = async () => {
    if (!editingMessage) return;
    const trimmed = editText.trim();
    const msgId = editingMessage._id;
    if (!trimmed || trimmed === (editingMessage.content || '')) {
      cancelEdit();
      return;
    }
    // Optimistic content update
    const editedAt = new Date().toISOString();
    patchMessage(msgId, { content: trimmed, edited_at: editedAt });
    try {
      await client.put(`/api/conversations/messages/${msgId}`, { content: trimmed });
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to edit message');
    }
    cancelEdit();
  };

  // Build message items with date separators.
  // Memoised: this array is Virtuoso's `data`, so rebuilding it on every render
  // re-rendered every visible row for renders that changed nothing.
  const items = useMemo(() => {
    const built = [];
    for (let i = 0; i < convMessages.length; i++) {
      const msg = convMessages[i];
      const prevMsg = i > 0 ? convMessages[i - 1] : null;

      if (!prevMsg || isDifferentDay(prevMsg.created_at, msg.created_at)) {
        built.push({ type: 'date', date: msg.created_at, key: `date-${msg.created_at}-${i}` });
      }
      built.push({
        type: 'message',
        message: msg,
        key: msg._id || msg.temp_id,
        isOwn: msg.sender_id === myUserId,
        showSenderName: !prevMsg || prevMsg.sender_id !== msg.sender_id || isDifferentDay(prevMsg.created_at, msg.created_at),
      });
    }
    return built;
  }, [convMessages, myUserId]);

  // Read through a ref so the scroll-to-reply handler stays stable for the
  // memoised bubbles instead of changing identity with every new message.
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // Reply / search / pinned-banner click -> scroll to the original message.
  const handleJumpToMessage = useCallback((originalMsgId) => {
    const idx = itemsRef.current.findIndex(item => item.type === 'message' && item.message._id === originalMsgId);
    if (idx >= 0 && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: idx, behavior: 'smooth' });
      return true;
    }
    // Silently doing nothing here read as "the app is broken"; say why instead.
    toast.message('That message is not loaded yet — scroll up to load older messages');
    return false;
  }, []);

  /**
   * Banner list: everything currently pinned. Live store state wins (an optimistic
   * pin/unpin from the message menu shows up immediately), and pins that sit
   * outside the loaded window are topped up from the one-shot /pinned fetch.
   */
  const pinnedMessages = useMemo(() => {
    const loaded = new Set(convMessages.map(m => m._id));
    const out = convMessages.filter(m => m.is_pinned && !m.is_deleted);
    for (const p of pinnedFromApi) {
      if (!loaded.has(p._id) && !p.is_deleted) out.push(p);
    }
    out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return out;
  }, [convMessages, pinnedFromApi]);

  const activePin = pinnedMessages.length > 0
    ? pinnedMessages[Math.min(pinCursor, pinnedMessages.length - 1)]
    : null;

  const handlePinnedBannerClick = useCallback(() => {
    const list = pinnedMessages;
    if (list.length === 0) return;
    const idx = Math.min(pinCursor, list.length - 1);
    handleJumpToMessage(list[idx]._id);
    // WhatsApp cycles through the pins on repeated taps.
    if (list.length > 1) setPinCursor((idx + 1) % list.length);
  }, [pinnedMessages, pinCursor, handleJumpToMessage]);

  const itemContent = useCallback((index, item) => {
    if (item.type === 'date') {
      return <DateSeparator date={item.date} />;
    }
    const bubble = (
      <MessageBubble
        message={item.message}
        isOwn={item.isOwn}
        showSenderName={item.showSenderName}
        isGroup={isGroup}
        currentUserId={myUserId}
        onContextMenu={handleContextMenu}
        onReactionClick={handleReactionClick}
        onReplyClick={handleJumpToMessage}
        onRetry={handleRetry}
      />
    );

    // Deleted and system rows are notices, not messages — nothing to act on.
    const selectable = !item.message.is_deleted && item.message.type !== 'system';
    if (!selectionMode || !selectable) return bubble;

    const checked = selectedIds.has(item.message._id);
    const toggle = () => toggleSelected(item.message._id);
    return (
      <div
        role="checkbox"
        aria-checked={checked}
        // The bubble is `inert` below, so it is out of the a11y tree — the row
        // has to carry the content itself or a screen reader hears only "checkbox".
        aria-label={`${item.message.sender_name || 'Unknown'}: ${messagePreview(item.message)}`}
        tabIndex={0}
        onClick={toggle}
        onContextMenu={(e) => { e.preventDefault(); toggle(); }}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
        }}
        data-testid="message-select-row"
        className={`flex items-center gap-2 pl-3 cursor-pointer transition-colors outline-none focus-visible:ring-1 focus-visible:ring-[#10B981] ${
          checked ? 'bg-[#10B981]/10' : 'hover:bg-[#141414]'
        }`}
      >
        <span
          aria-hidden="true"
          className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${
            checked ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'
          }`}
        >
          {checked && <Check size={12} className="text-[#0A0A0A]" strokeWidth={3} />}
        </span>
        {/* Truly inert while selecting, not merely pointer-events-none: the row
            owns the click, and a keyboard user tabbing onto a reaction badge
            inside a selected bubble could otherwise still fire it. `inert` also
            keeps the hover chevron from opening a menu over the checkbox. */}
        <div inert={true} className="flex-1 min-w-0 [&_[data-testid=message-menu-trigger]]:hidden">
          {bubble}
        </div>
      </div>
    );
  }, [isGroup, myUserId, handleContextMenu, handleReactionClick, handleJumpToMessage, handleRetry,
    selectionMode, selectedIds, toggleSelected]);

  if (!conversationId) {
    return <EmptyChat />;
  }

  const typingCount = Object.keys(convTyping).length;
  const selectedCount = selectedIds.size;
  const composerBlocked = conversation?.admin_only_messages && isGroup &&
    !['creator', 'admin'].includes(conversation?.participants?.find(p => p.user_id === myUserId)?.role);

  return (
    <div className="flex-1 flex flex-col bg-[#0A0A0A] h-full min-h-0 overflow-hidden">
      {/* Chat Header — same 64px box in both modes, so entering selection never
          shifts the message list. */}
      <div className="h-16 bg-[#0F0F0F] border-b border-[#1F1F1F] flex items-center justify-between px-4 flex-shrink-0 gap-2">
        {selectionMode ? (
          <>
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={exitSelection}
                aria-label="Cancel selection"
                title="Cancel selection"
                data-testid="selection-cancel-btn"
                className="p-2 -ml-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
              >
                <X size={20} />
              </button>
              <h3 className="text-base font-medium text-[#F5F5F5]" data-testid="selection-count">
                {selectedCount} selected
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              disabled={selectedCount === 0}
              data-testid="selection-clear-btn"
              className="px-3 py-1.5 text-xs text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              Clear
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 min-w-0">
              {isMobile && (
                <button
                  onClick={onBack}
                  aria-label="Back to chats"
                  data-testid="chat-back-button"
                  className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors -ml-2"
                >
                  <ArrowLeft size={20} />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (isDirect) setContactInfo({ open: true, section: 'info' });
                  else if (conversation) setGroupInfo({ open: true, section: 'info' });
                }}
                aria-label={isDirect ? 'Contact info' : 'Group info'}
                data-testid="chat-header-identity"
                className="flex items-center gap-3 min-w-0 text-left rounded-[6px] px-1 -mx-1 py-1 hover:bg-[#1A1A1A] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#10B981] transition-colors"
              >
                <span className="relative flex-shrink-0">
                  <span className="w-10 h-10 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium">
                    {displayName?.charAt(0)?.toUpperCase() || '?'}
                  </span>
                  {otherParticipant?.status === 'online' && (
                    <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#10B981] rounded-full border-2 border-[#0F0F0F]" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2">
                    <h3 className="text-base font-medium text-[#F5F5F5] truncate">{displayName}</h3>
                    {conversation?.cross_org && (
                      <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#10B981]/20 text-[#10B981] flex-shrink-0">Cross-Org</span>
                    )}
                  </span>
                  <span className={`block text-xs truncate ${otherParticipant?.status === 'online' ? 'text-[#10B981]' : 'text-[#A3A3A3]'}`}>
                    {typingCount > 0 ? (
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
                  </span>
                </span>
              </button>
            </div>

            <div className="flex items-center gap-1 flex-shrink-0">
              <button
                onClick={() => setShowConvSearch(s => !s)}
                aria-label="Search messages"
                title="Search"
                data-testid="chat-search-btn"
                className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
              >
                <Search size={18} />
              </button>
              <CallButtonDropdown
                type={headerType}
                conversation={conversation}
                disabled={callBusy}
                onAction={handleCallAction}
              />
              <ChatHeaderMenu
                type={headerType}
                conversation={conversation}
                onAction={handleHeaderAction}
              />
            </div>
          </>
        )}
      </div>

      {/* In-conversation search */}
      <ConversationSearch
        conversationId={conversationId}
        isOpen={showConvSearch && !selectionMode}
        onClose={() => setShowConvSearch(false)}
        // Same "scroll to this message id" behaviour as a reply-block click, and
        // stable — an inline arrow here re-armed ConversationSearch's debounce on
        // every ChatPanel render, so the search never fired while messages flowed.
        onScrollToMessage={handleJumpToMessage}
      />

      {/* Pinned messages banner */}
      {activePin && !selectionMode && (
        <button
          type="button"
          onClick={handlePinnedBannerClick}
          data-testid="pinned-messages-banner"
          className="flex items-center gap-3 px-4 py-2 bg-[#141414] border-b border-[#1F1F1F] text-left hover:bg-[#1A1A1A] focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#10B981] transition-colors flex-shrink-0"
        >
          <Pin size={14} className="text-[#10B981] flex-shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] text-[#10B981]">
              {pinnedMessages.length > 1
                ? `Pinned message ${Math.min(pinCursor, pinnedMessages.length - 1) + 1} of ${pinnedMessages.length}`
                : 'Pinned message'}
            </span>
            <span className="block text-[13px] text-[#A3A3A3] truncate">
              {activePin.sender_name ? `${activePin.sender_name}: ` : ''}{messagePreview(activePin)}
            </span>
          </span>
        </button>
      )}

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
            // Remount per conversation. `initialTopMostItemIndex` only applies at
            // mount, and switching threads used to remount the list implicitly
            // via the loading spinner. Now that a cached thread renders without
            // one, without this key the list keeps the previous thread's scroll
            // state and has to walk its way down to the newest message.
            key={conversationId}
            ref={virtuosoRef}
            style={{ height: '100%' }}
            data={items}
            initialTopMostItemIndex={items.length - 1}
            followOutput="smooth"
            atBottomStateChange={(bottom) => {
              setShowScrollDown(!bottom && items.length > 10);
            }}
            startReached={() => {
              if (hasMore) loadMore();
            }}
            itemContent={itemContent}
          />
        )}

        {/* Typing indicator - positioned at bottom of message area */}
        {typingCount > 0 && (
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
            aria-label="Scroll to latest message"
            className="absolute bottom-4 right-4 w-10 h-10 rounded-full bg-[#10B981] text-white flex items-center justify-center shadow-lg hover:bg-[#059669] transition-colors z-10"
          >
            <ChevronDown size={20} />
          </motion.button>
        )}
      </div>

      {/* Bottom bar: selection actions, edit bar, or composer */}
      {selectionMode ? (
        <div
          data-testid="selection-action-bar"
          className="bg-[#0F0F0F] border-t border-[#1F1F1F] px-4 py-3 safe-bottom flex items-center justify-between gap-3"
        >
          <span className="text-sm text-[#A3A3A3]">
            {selectedCount === 0 ? 'Select messages' : `${selectedCount} selected`}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setForwardBatch(selectedMessages)}
              disabled={selectedCount === 0}
              data-testid="selection-forward-btn"
              className="flex items-center gap-2 px-3 py-2 text-sm text-[#F5F5F5] rounded-[6px] hover:bg-[#1A1A1A] transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Forward size={16} /> Forward
            </button>
            <button
              type="button"
              onClick={handleBatchStar}
              disabled={selectedCount === 0}
              data-testid="selection-star-btn"
              className="flex items-center gap-2 px-3 py-2 text-sm text-[#F5F5F5] rounded-[6px] hover:bg-[#1A1A1A] transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
            >
              {allSelectedStarred ? <StarOff size={16} /> : <Star size={16} />}
              {allSelectedStarred ? 'Unstar' : 'Star'}
            </button>
            {/* The bulk Delete action was removed with the message-deletion
                feature. Star/Unstar and Forward remain. */}
          </div>
        </div>
      ) : editingMessage ? (
        <div className="bg-[#141414] border-t border-[#1F1F1F]" data-testid="edit-message-bar">
          {/* Edit banner (mirrors ReplyPreview) */}
          <div className="px-4 py-2 flex items-center gap-3">
            <div className="w-1 h-10 bg-[#10B981] rounded-full flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-medium text-[#10B981]">Editing message</p>
              <p className="text-[13px] text-[#A3A3A3] truncate">
                {editingMessage.type === 'image'
                  ? '📷 Photo'
                  : (editingMessage.content || '').substring(0, 100)}
              </p>
            </div>
            <button
              onClick={cancelEdit}
              data-testid="edit-cancel-btn"
              className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded transition-colors flex-shrink-0"
            >
              <X size={16} />
            </button>
          </div>

          {/* Inline edit input */}
          <div className="bg-[#0F0F0F] border-t border-[#1F1F1F] px-3 sm:px-4 py-3 safe-bottom">
            <div className="flex items-end gap-2">
              <input
                autoFocus
                type="text"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveEdit(); }
                  else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                }}
                placeholder="Edit message"
                data-testid="edit-message-input"
                className="flex-1 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[8px] px-4 py-2.5 text-sm text-[#F5F5F5] placeholder:text-[#525252] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all"
              />
              <button
                onClick={handleSaveEdit}
                data-testid="edit-save-btn"
                title="Save"
                className="p-2.5 rounded-full flex-shrink-0 mb-0.5 bg-[#10B981] text-white hover:bg-[#059669] active:scale-[0.95] transition-all duration-150"
              >
                <Check size={18} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Reply Preview */}
          {replyTo && (
            <ReplyPreview message={replyTo} onClose={() => setReplyTo(null)} />
          )}

          {/* Composer or admin-only banner */}
          {composerBlocked ? (
            <div className="bg-[#0F0F0F] border-t border-[#1F1F1F] px-4 py-3 text-center">
              <p className="text-sm text-[#A3A3A3]">Only admins can send messages in this group</p>
            </div>
          ) : (
            <MessageComposer
              conversationId={conversationId}
              onSend={handleSend}
              replyTo={replyTo}
              draft={draft}
            />
          )}
        </>
      )}

      {/* Context Menu */}
      {contextMenu && (
        <MessageContextMenu
          message={contextMenu.message}
          isOwn={contextMenu.message.sender_id === myUserId}
          isGroup={isGroupLike}
          position={contextMenu.position}
          onAction={handleMessageAction}
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

      {/* Forward Modal — one message from the menu, or a whole selection. */}
      <ForwardModal
        message={forwardBatch?.[0] || null}
        messages={forwardBatch || undefined}
        isOpen={!!forwardBatch?.length}
        onClose={() => {
          setForwardBatch(null);
          exitSelection();
        }}
      />

      {/* Message Info Modal */}
      <MessageInfoModal
        info={msgInfo}
        isOpen={!!msgInfo}
        onClose={() => setMsgInfo(null)}
      />

      {/* Both delete confirmations (single message and selection-mode batch) were
          removed with the message-deletion feature. */}

      {/* Exit group confirmation (header menu) */}
      <ConfirmDialog
        open={leaveConfirm}
        title={`Exit "${conversation?.name || 'this group'}"?`}
        body="You will stop receiving messages from this group. Only group admins can add you back."
        confirmLabel="Exit group"
        busy={leaveBusy}
        onConfirm={handleLeaveGroup}
        onCancel={() => setLeaveConfirm(false)}
        testId="chat-leave-group-confirm"
      />

      {/* Group Info Panel */}
      {!isDirect && conversation && (
        <GroupInfoPanel
          conversation={conversation}
          currentUserId={myUserId}
          isOpen={groupInfo.open}
          onClose={() => setGroupInfo(prev => ({ ...prev, open: false }))}
          initialSection={groupInfo.section}
          // Same "scroll to this message id" handler the reply blocks and the
          // in-conversation search already use.
          onJumpToMessage={handleJumpToMessage}
          onSearchMessages={() => setShowConvSearch(true)}
        />
      )}

      {/* Contact Info Panel */}
      {isDirect && (
        <ContactInfoPanel
          contact={otherParticipant}
          conversation={conversation}
          currentUserId={myUserId}
          isOpen={contactInfo.open}
          onClose={() => setContactInfo(prev => ({ ...prev, open: false }))}
          initialSection={contactInfo.section}
          onJumpToMessage={handleJumpToMessage}
          onSearchMessages={() => setShowConvSearch(true)}
        />
      )}

      {/* "New group call" from a DM: build the group, then ring it. */}
      <CreateGroupModal
        isOpen={showNewGroupCall}
        onClose={() => setShowNewGroupCall(false)}
        prefillMembers={otherParticipant ? [{
          id: otherParticipant.user_id,
          display_name: otherParticipant.display_name,
          avatar_url: otherParticipant.avatar_url,
          department_name: otherParticipant.department_name || '',
        }] : undefined}
        onGroupCreated={(group) => {
          setShowNewGroupCall(false);
          if (!group?._id) return;
          const store = useChatStore.getState();
          if (!store.conversations.some(c => c._id === group._id)) {
            store.setConversations([group, ...store.conversations]);
          }
          store.setActiveConversation(group._id);
          if (useCallStore.getState().callState !== 'idle') {
            toast.error('You are already in a call');
            return;
          }
          wsClient.send({ type: 'call:group_initiate', conversation_id: group._id, call_type: 'video' });
          useCallStore.getState().initiateCall(null, 'video', true, group._id);
        }}
      />
    </div>
  );
};
