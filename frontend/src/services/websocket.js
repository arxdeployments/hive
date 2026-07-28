import { toast } from 'sonner';
import useChatStore from '../stores/chatStore';
import useCallStore from '../stores/callStore';
import livekitClient from './livekitClient';
import { refreshSession } from '../api/client';
import { withDerivedStatus, applyReadReceipt } from '../utils/messageStatus';
import { handleCallJoinError, notifyCameraUnavailable } from '../utils/callErrors';

/**
 * Join the SFU and surface what happened. Every join site shares this so a
 * stopped LiveKit server, a blocked microphone, and a dead call each produce
 * their own message instead of one indistinguishable "could not connect".
 */
function joinLiveKit(callId, context, onFatal) {
  return livekitClient
    .joinCall(callId)
    .then((result) => {
      if (result?.cameraUnavailable) notifyCameraUnavailable(result.reason);
    })
    .catch((err) => {
      handleCallJoinError(err, context);
      onFatal(err);
    });
}

// Auth rides in httpOnly cookies — the WS handshake carries them automatically
// (same-origin in production behind Caddy, and via the Vite proxy in dev).
class RxHiveWebSocket {
  constructor() {
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnectDelay = 30000;
    this.messageQueue = [];
    this.heartbeatInterval = null;
    this.pongTimeout = null;
    this._intentionalClose = false;
    this._active = false;
  }

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this._intentionalClose = false;
    this._active = true;

    const backendUrl = import.meta.env.VITE_BACKEND_URL || window.location.origin;
    const wsProtocol = backendUrl.startsWith('https') ? 'wss' : 'ws';
    const host = backendUrl.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProtocol}://${host}/api/ws`;

    useChatStore.getState().setWsConnecting(true);

    try {
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => this._onOpen();
      this.ws.onmessage = (event) => this._onMessage(event);
      this.ws.onclose = (event) => this._onClose(event);
      this.ws.onerror = (error) => {
        console.error('[WS] Error:', error);
      };
    } catch (err) {
      console.error('[WS] Failed to create WebSocket:', err);
      this._scheduleReconnect();
    }
  }

  _onOpen() {
    const wasReconnect = this.reconnectAttempts > 0;
    this.reconnectAttempts = 0;
    useChatStore.getState().setWsConnected(true);

    if (wasReconnect) {
      this._syncAfterReconnect();
    }

    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift();
      this._rawSend(msg);
    }

    this._startHeartbeat();
  }

  async _syncAfterReconnect() {
    try {
      const client = (await import('../api/client')).default;
      const { data } = await client.get('/api/conversations');
      if (data?.data) {
        useChatStore.getState().setConversations(data.data);
      }
    } catch (err) {
      console.error('[WS] Reconnect sync failed:', err);
    }
  }

  _onMessage(event) {
    try {
      const data = JSON.parse(event.data);
      this._routeMessage(data);
    } catch (err) {
      console.error('[WS] Failed to parse message:', err);
    }
  }

  async _onClose(event) {
    this._stopHeartbeat();
    useChatStore.getState().setWsConnected(false);

    if (event.code === 4001) {
      // Access cookie expired — refresh the session, then reconnect.
      try {
        await refreshSession();
        this._scheduleReconnect(true);
      } catch (err) {
        localStorage.removeItem('user');
        window.location.href = '/login';
      }
      return;
    }

    if (!this._intentionalClose) {
      this._scheduleReconnect();
    }
  }

  async _routeMessage(data) {
    const store = useChatStore.getState();
    const callStore = useCallStore;

    switch (data.type) {
      case 'connected':
        break;

      case 'pong':
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
          this.pongTimeout = null;
        }
        break;

      case 'message_ack': {
        const { temp_id, message_id, created_at, status } = data;
        Object.keys(store.messages).forEach(convId => {
          const msgs = store.messages[convId] || [];
          if (msgs.find(m => m.temp_id === temp_id)) {
            store.replaceOptimisticMessage(convId, temp_id, {
              _id: message_id,
              temp_id,
              created_at,
              status: status || 'sent'
            });
          }
        });
        break;
      }

      case 'new_message': {
        const incoming = data.message;
        if (!incoming) break;
        // Same rule as the load path: ticks come from the receipt arrays, not
        // from whatever `status` the broadcast happened to carry.
        const msg = withDerivedStatus(incoming, this._currentUserId());
        const convId = msg.conversation_id;

        store.addMessage(convId, msg);
        store.bumpConversation(convId, {
          content: msg.content,
          sender_id: msg.sender_id,
          sender_name: msg.sender_name,
          created_at: msg.created_at,
          type: msg.type
        });

        // One rule for unread / sound / notification / read-receipt, instead of
        // four decisions derived from a single "is this conversation open" test.
        const looking = store.activeConversationId === convId
          && document.visibilityState === 'visible';

        if (looking) {
          // Only receipt when the user can actually SEE it. This used to fire for
          // an open-but-hidden tab, so a locked phone or a background window
          // marked messages read and suppressed the notification entirely.
          this.sendReadReceipt(convId, msg._id);
          break;
        }

        store.incrementUnread(convId);

        if (this._shouldNotify(msg, convId, store)) {
          this._playNotificationSound();
          this._showBrowserNotification(msg, convId, store);
        }
        break;
      }

      case 'message_status': {
        const { message_id, status } = data;
        Object.keys(store.messages).forEach(convId => {
          store.updateMessageStatus(convId, message_id, status);
        });
        break;
      }

      case 'messages_read': {
        const { conversation_id, reader_id, last_read_message_id, read_at } = data;
        if (!conversation_id || !reader_id) break;
        const currentMsgs = store.messages[conversation_id] || [];
        if (currentMsgs.length === 0) break;
        // last_read_message_id may be null (mark-all-read): treat as "everything".
        // An id we cannot find is an anchor in an older, not-yet-loaded page —
        // do NOT widen that to "everything" or newer unread messages go blue.
        const lastReadIdx = last_read_message_id
          ? currentMsgs.findIndex(m => m._id === last_read_message_id)
          : currentMsgs.length - 1;
        if (lastReadIdx < 0) break;
        const myId = this._currentUserId();
        // applyReadReceipt merges the reader into read_by/delivered_to as well,
        // so the ticks survive any later re-derive of the same objects.
        store.setMessages(conversation_id, currentMsgs.map((m, idx) =>
          idx <= lastReadIdx ? applyReadReceipt(m, reader_id, myId, read_at) : m
        ));
        break;
      }

      case 'typing': {
        const { conversation_id, user_id, user_name, is_typing } = data;
        store.setTyping(conversation_id, user_id, user_name, is_typing);
        if (is_typing) {
          setTimeout(() => {
            store.setTyping(conversation_id, user_id, user_name, false);
          }, 4000);
        }
        break;
      }

      // Presence and profile churn constantly. Both used to walk every
      // conversation and issue one store write each — N notifications and N
      // full-list rebuilds per broadcast, which re-rendered the entire sidebar
      // even for conversations the user isn't a participant of. One write now.
      case 'presence': {
        const { user_id, status, last_seen } = data;
        store.updateParticipantEverywhere(user_id, { status, last_seen });
        break;
      }

      case 'profile_updated': {
        const { user_id, display_name, avatar_url } = data;
        store.updateParticipantEverywhere(user_id, { display_name, avatar_url });
        break;
      }

      case 'conversation_created': {
        const newConv = data.conversation;
        if (newConv) {
          const existing = store.conversations.find(c => c._id === newConv._id);
          if (!existing) {
            store.setConversations([newConv, ...store.conversations]);
          }
        }
        break;
      }

      case 'conversation_updated': {
        const { conversation_id, updates } = data;
        if (conversation_id && updates) {
          store.updateConversation(conversation_id, updates);
        }
        break;
      }

      // Group permissions travel on their own event (PUT /permissions), not on
      // conversation_updated. `send_messages` is the wire inverse of the stored
      // admin_only_messages, which is what gates the composer — without this a
      // member keeps typing into a group they can no longer post to until they
      // reload, and only finds out when the send 403s.
      case 'permissions_updated': {
        const { conversation_id: permConvId, permissions } = data;
        if (permConvId && typeof permissions?.send_messages === 'boolean') {
          store.updateConversation(permConvId, {
            admin_only_messages: !permissions.send_messages
          });
        }
        break;
      }

      case 'member_added': {
        const { conversation_id, conversation: updatedConv } = data;
        if (updatedConv) {
          store.updateConversation(conversation_id, {
            participants: updatedConv.participants
          });
        }
        break;
      }

      case 'member_removed': {
        const { conversation_id: rmConvId, user_id: removedId } = data;
        const rmConv = store.conversations.find(c => c._id === rmConvId);
        if (rmConv) {
          store.updateConversation(rmConvId, {
            participants: rmConv.participants.filter(p => p.user_id !== removedId)
          });
        }
        break;
      }

      case 'removed_from_conversation': {
        const { conversation_id: removedConvId } = data;
        store.setConversations(store.conversations.filter(c => c._id !== removedConvId));
        if (store.activeConversationId === removedConvId) {
          store.setActiveConversation(null);
        }
        break;
      }

      case 'role_changed': {
        const { conversation_id: rcConvId, user_id: rcUserId, new_role } = data;
        const rcConv = store.conversations.find(c => c._id === rcConvId);
        if (rcConv) {
          store.updateConversation(rcConvId, {
            participants: rcConv.participants.map(p =>
              p.user_id === rcUserId ? { ...p, role: new_role } : p
            )
          });
        }
        break;
      }

      case 'member_left': {
        const { conversation_id: mlConvId, user_id: leftUserId } = data;
        const mlConv = store.conversations.find(c => c._id === mlConvId);
        if (mlConv) {
          store.updateConversation(mlConvId, {
            participants: mlConv.participants.filter(p => p.user_id !== leftUserId)
          });
        }
        break;
      }

      case 'reaction_update': {
        const { message_id: rMsgId, conversation_id: rConvId, reactions } = data;
        if (rConvId && rMsgId) {
          const msgs = store.messages[rConvId] || [];
          store.setMessages(rConvId, msgs.map(m =>
            m._id === rMsgId ? { ...m, reactions } : m
          ));
        }
        break;
      }

      // A pin is conversation-wide, and both the pinned banner and the bubble's
      // pin icon read `is_pinned` off the message — so without this everyone
      // except the actor keeps the stale state until the thread is re-fetched.
      case 'message_pin_update': {
        const { message_id: pMsgId, conversation_id: pConvId, is_pinned: pinned } = data;
        if (pConvId && pMsgId) {
          const msgs = store.messages[pConvId] || [];
          store.setMessages(pConvId, msgs.map(m =>
            m._id === pMsgId ? { ...m, is_pinned: pinned } : m
          ));
        }
        // Also nudge the open thread to re-fetch /pinned. The patch above only
        // reaches messages already loaded, so without this a pin (or unpin) of a
        // message outside the loaded window never reached the pinned banner.
        if (pConvId) store.bumpPinnedVersion(pConvId);
        break;
      }

      // A CONVERSATION pin (the sidebar kind), not a message pin. Sent only to
      // the acting user's own sockets, since a pin is per-user — this is what
      // keeps a second tab or device in the same order instead of showing the old
      // one until it refetches.
      case 'conversation_pin_update': {
        const { conversation_id: cpConvId, is_pinned: cpPinned, pin_order: cpOrder } = data;
        if (cpConvId) {
          store.setConversationPinned(cpConvId, cpPinned, cpOrder ?? null);
        }
        break;
      }

      // Retained deliberately even though message deletion has been removed as a
      // feature and no server code can emit this frame any more.
      //
      // Two reasons. Deploys are not atomic — the frontend and the API are
      // separate containers, so during a rollout an older API could still be
      // serving a delete while this bundle is live. And a message tombstoned
      // before the removal must keep rendering as "This message was deleted"
      // rather than reverting to its original content. Dropping this handler buys
      // nothing and risks a rendering desync, so it stays as a read-side no-op.
      case 'message_deleted': {
        const { message_id: dMsgId, conversation_id: dConvId } = data;
        if (dConvId && dMsgId) {
          const msgs = store.messages[dConvId] || [];
          store.setMessages(dConvId, msgs.map(m =>
            m._id === dMsgId ? { ...m, is_deleted: true, content: '', media_url: null } : m
          ));
        }
        break;
      }

      case 'message_edited': {
        const { message_id: eMsgId, conversation_id: eConvId, content, edited_at } = data;
        if (eConvId && eMsgId) {
          const msgs = store.messages[eConvId] || [];
          store.setMessages(eConvId, msgs.map(m =>
            m._id === eMsgId ? { ...m, content, edited_at } : m
          ));
        }
        break;
      }

      // ===== CALL SIGNALS (media itself flows through LiveKit, not here) =====
      case 'call:incoming': {
        callStore.getState().receiveIncomingCall(
          data.call_id, data.caller, data.call_type,
          data.is_group, data.conversation_id
        );
        break;
      }
      case 'call:ringing_started': {
        const cs = callStore.getState();
        if (cs.callState === 'outgoing_ringing' && data.call_id && !cs.callId) {
          callStore.setState({ callId: data.call_id });
        }
        break;
      }
      case 'call:group_started': {
        callStore.getState().setCallState('connected');
        callStore.getState().callConnected();
        joinLiveKit(data.call_id, 'group_started', () => callStore.getState().resetCall());
        break;
      }
      case 'call:group_participants': {
        for (const participant of (data.participants || [])) {
          callStore.getState().addRemoteParticipant({
            id: participant.id,
            display_name: participant.display_name,
            avatar_url: participant.avatar_url
          });
        }
        // This event is addressed to the joiner, and it is the server's
        // confirmation that the join was accepted — so it's where a group
        // participant connects media. (call:group_started only reaches the
        // initiator, so relying on that alone left joiners silent.)
        callStore.getState().setCallState('connected');
        callStore.getState().callConnected();
        joinLiveKit(data.call_id, 'group_join', () => callStore.getState().resetCall());
        break;
      }
      case 'call:full': {
        toast.error(data.message || 'Call is full');
        callStore.getState().resetCall();
        break;
      }
      case 'call:group_already_active': {
        callStore.getState().setActiveGroupCall(data.conversation_id, { call_id: data.call_id });
        break;
      }
      case 'call:accepted': {
        const cs = callStore.getState();
        cs.acceptCall();
        // Both sides connect to the SFU room here: the caller because the
        // callee just answered, the callee because this is the server's
        // confirmation that the call really moved to connected.
        const joinId = cs.callId || data.call_id;
        joinLiveKit(joinId, 'accepted', () => {
          callStore.getState().endCall();
          this.send({ type: 'call:end', call_id: joinId });
        });
        break;
      }
      case 'call:declined': {
        livekitClient.leave();
        callStore.getState().endCall();
        break;
      }
      case 'call:ended': {
        livekitClient.leave();
        callStore.getState().endCall();
        break;
      }
      case 'call:cancelled': {
        livekitClient.leave();
        callStore.getState().resetCall();
        break;
      }
      case 'call:busy': {
        toast.info('User is on another call');
        callStore.getState().endCall();
        break;
      }
      case 'call:unavailable': {
        toast.info('User is unavailable');
        callStore.getState().endCall();
        break;
      }
      case 'call:missed': {
        const cs = callStore.getState();
        // Only the callee's badge increments (the caller gets the same event).
        if (data.caller) {
          cs.setMissedCallCount(cs.missedCallCount + 1);
        }
        livekitClient.leave();
        cs.resetCall();
        break;
      }
      case 'call:participant_joined': {
        callStore.getState().addRemoteParticipant(data.participant);
        break;
      }
      case 'call:participant_left': {
        callStore.getState().removeRemoteParticipant(data.participant_id);
        break;
      }
      case 'call:media_toggle': {
        callStore.getState().updateRemoteParticipant(data.user_id, {
          [data.media_type === 'audio' ? 'isMuted' : 'isCameraOff']: !data.enabled
        });
        break;
      }
      case 'call:group_active': {
        callStore.getState().setActiveGroupCall(data.conversation_id, {
          call_id: data.call_id, participants: data.participants, call_type: data.call_type
        });
        break;
      }
      case 'call:group_ended': {
        if (data.conversation_id) {
          callStore.getState().removeActiveGroupCall(data.conversation_id);
        }
        break;
      }
      case 'call:error': {
        toast.error(data.message || 'Call failed');
        callStore.getState().resetCall();
        break;
      }

      case 'error':
        console.error('[WS] Server error:', data.detail);
        if (data.temp_id) {
          Object.keys(store.messages).forEach(convId => {
            const msgs = store.messages[convId] || [];
            if (msgs.find(m => m.temp_id === data.temp_id)) {
              store.setMessages(convId, msgs.map(m =>
                m.temp_id === data.temp_id ? { ...m, status: 'failed' } : m
              ));
            }
          });
        }
        break;

      default:
        break;
    }
  }

  // The socket lives outside React, so the session id comes from the
  // localStorage mirror AuthContext keeps in step with /api/auth/me.
  _currentUserId() {
    try {
      return JSON.parse(localStorage.getItem('user') || '{}')?.id || null;
    } catch {
      return null;
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._rawSend(data);
    } else {
      this.messageQueue.push(data);
    }
  }

  _rawSend(data) {
    try {
      this.ws.send(JSON.stringify(data));
    } catch (err) {
      console.error('[WS] Send failed:', err);
      this.messageQueue.push(data);
    }
  }

  // True only if a frame written right now would actually leave the browser.
  //
  // This is the live socket, deliberately NOT the React store's wsConnected
  // copy of it. The store lags the socket (it is set from the open/close
  // handlers, and is false for the whole CONNECTING window), and two components
  // reading two React values can disagree about a single send — which would
  // either duplicate the message or drop it entirely. Both send paths call this
  // instead, inside the same synchronous call stack, so they always agree.
  isOpen() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  // Chat messages are the ONE frame type that must never be queued.
  //
  // Every other frame below (typing, read receipts, presence) is harmless to
  // replay on reconnect. A message is not: the sender falls back to POSTing it
  // over HTTP whenever the socket is down, so a frame parked in messageQueue
  // and replayed by _onOpen creates the very same message a second time — the
  // API does not dedupe on temp_id. That was a real double-send on every text
  // message typed while offline.
  //
  // Callers gate on isOpen(); refusing to queue here makes the invariant
  // impossible to break by accident from a future call site. Returns whether
  // the frame was handed to the socket.
  sendMessage(conversationId, content, tempId, replyTo = null) {
    if (!this.isOpen()) {
      console.warn('[WS] sendMessage called while the socket is not open — dropped; the HTTP fallback owns this message');
      return false;
    }
    this._rawSend({
      type: 'message',
      conversation_id: conversationId,
      content,
      msg_type: 'text',
      temp_id: tempId,
      reply_to: replyTo
    });
    return true;
  }

  sendTypingStart(conversationId) {
    this.send({ type: 'typing_start', conversation_id: conversationId });
  }

  sendTypingStop(conversationId) {
    this.send({ type: 'typing_stop', conversation_id: conversationId });
  }

  sendReadReceipt(conversationId, lastReadMessageId) {
    this.send({
      type: 'read_receipt',
      conversation_id: conversationId,
      last_read_message_id: lastReadMessageId
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
        this.pongTimeout = setTimeout(() => {
          console.warn('[WS] No pong received, reconnecting...');
          if (this.ws) this.ws.close();
        }, 10000);
      }
    }, 30000);
  }

  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  _scheduleReconnect(immediate = false) {
    if (this._intentionalClose || !this._active) return;

    const delay = immediate
      ? 100
      : Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
    this.reconnectAttempts++;

    useChatStore.getState().setWsConnecting(true);

    setTimeout(() => {
      if (!this._intentionalClose && this._active) {
        this.connect();
      }
    }, delay);
  }

  /**
   * Whether an inbound message should make noise.
   *
   * The unread badge is deliberately NOT gated on this — a muted conversation
   * still counts as unread, it just does not interrupt you. Three guards that
   * were missing entirely:
   *
   *  - system messages: send_system_message fans new_message out to EVERY
   *    participant including the actor, so renaming a group used to beep on your
   *    own other tabs with a notification titled "System".
   *  - my own messages: the same fan-out echoes what I just sent to my other
   *    tabs, which then notified me about myself.
   *  - muted conversations: is_muted has been served on every conversation all
   *    along (enrich.serialize_conversation) and nothing ever read it, so "Mute
   *    notifications" silenced nothing at all.
   */
  _shouldNotify(msg, convId, store) {
    if (!msg || msg.type === 'system') return false;
    const me = this._currentUserId();
    if (me && msg.sender_id === me) return false;
    const conv = store.conversations.find(c => c._id === convId);
    if (conv?.is_muted) return false;
    return true;
  }

  _playNotificationSound() {
    try {
      if (localStorage.getItem('rxhive_notif_sound') === 'off') return;
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      oscillator.frequency.value = 800;
      oscillator.type = 'sine';
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);
      oscillator.start(audioCtx.currentTime);
      oscillator.stop(audioCtx.currentTime + 0.3);
    } catch (e) {
      // autoplay policy may block audio
    }
  }

  /**
   * Raise a desktop notification.
   *
   * Service-worker-first: `new Notification(...)` is UNSUPPORTED on Android
   * Chrome, where the constructor throws — and the throw was swallowed by the
   * try/catch here, so mobile silently got nothing at all. showNotification() on
   * the registration works everywhere and is also what sw.js's existing
   * notificationclick handler is written against. The constructor stays as the
   * fallback for contexts with no service worker.
   */
  async _showBrowserNotification(msg, convId, store) {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (localStorage.getItem('rxhive_desktop_notif') === 'off') return;
      // hasFocus() alone is not enough: a focused window on another tab still
      // means the user cannot see this conversation.
      if (document.hasFocus() && document.visibilityState === 'visible'
        && store.activeConversationId === convId) return;

      const conv = store.conversations.find(c => c._id === convId);
      let title = msg.sender_name || 'New message';
      if (conv?.type === 'group' && conv?.name) {
        title = conv.name;
      }

      let body = msg.content || '';
      if (msg.type === 'image') body = '📷 Photo';
      else if (msg.type === 'video') body = '🎬 Video';
      else if (msg.type === 'audio') body = '🎤 Voice message';
      else if (msg.type === 'file') body = `📄 ${msg.filename || msg.content || 'Document'}`;
      if (body.length > 100) body = body.substring(0, 100) + '...';

      if (conv?.type === 'group') {
        body = `${msg.sender_name}: ${body}`;
      }

      const options = {
        body,
        tag: convId,
        renotify: true,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        // sw.js's notificationclick reads data.convId to focus the right chat.
        data: { convId, url: `/chat?c=${encodeURIComponent(convId)}` },
      };

      if ('serviceWorker' in navigator) {
        try {
          const reg = await navigator.serviceWorker.ready;
          if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification(title, options);
            return;
          }
        } catch {
          // fall through to the constructor
        }
      }

      const notif = new Notification(title, options);
      notif.onclick = () => {
        window.focus();
        store.setActiveConversation(convId);
        notif.close();
      };
    } catch (e) {
      // Notification may fail in some contexts
    }
  }

  disconnect() {
    this._intentionalClose = true;
    this._active = false;
    this._stopHeartbeat();
    if (this.ws) {
      this.ws.close(1000, 'User disconnected');
      this.ws = null;
    }
    useChatStore.getState().setWsConnected(false);
    useChatStore.getState().setWsConnecting(false);
  }
}

// Singleton
const wsClient = new RxHiveWebSocket();
export default wsClient;
