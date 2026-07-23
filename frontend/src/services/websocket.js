import { toast } from 'sonner';
import useChatStore from '../stores/chatStore';
import useCallStore from '../stores/callStore';
import livekitClient from './livekitClient';
import { refreshSession } from '../api/client';

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
        const msg = data.message;
        if (!msg) break;
        const convId = msg.conversation_id;

        store.addMessage(convId, msg);
        store.bumpConversation(convId, {
          content: msg.content,
          sender_id: msg.sender_id,
          sender_name: msg.sender_name,
          created_at: msg.created_at,
          type: msg.type
        });

        if (store.activeConversationId !== convId) {
          store.incrementUnread(convId);
          this._playNotificationSound();
          this._showBrowserNotification(msg, convId, store);
        } else {
          this.sendReadReceipt(convId, msg._id);
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
        const { conversation_id, reader_id, last_read_message_id } = data;
        const currentMsgs = store.messages[conversation_id] || [];
        // last_read_message_id may be null (mark-all-read): treat as "everything".
        const lastReadIdx = last_read_message_id
          ? currentMsgs.findIndex(m => m._id === last_read_message_id)
          : currentMsgs.length - 1;
        if (lastReadIdx >= 0) {
          const updatedMsgs = currentMsgs.map((m, idx) => {
            if (idx <= lastReadIdx && m.sender_id !== reader_id && m.status !== 'read') {
              return { ...m, status: 'read' };
            }
            return m;
          });
          store.setMessages(conversation_id, updatedMsgs);
        }
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

      case 'presence': {
        const { user_id, status, last_seen } = data;
        const convs = store.conversations;
        convs.forEach(conv => {
          const updated = conv.participants?.map(p =>
            p.user_id === user_id ? { ...p, status, last_seen } : p
          );
          if (updated) {
            store.updateConversation(conv._id, { participants: updated });
          }
        });
        break;
      }

      case 'profile_updated': {
        const { user_id, display_name, avatar_url } = data;
        const convs = store.conversations;
        convs.forEach(conv => {
          const updated = conv.participants?.map(p =>
            p.user_id === user_id ? { ...p, display_name, avatar_url } : p
          );
          if (updated) {
            store.updateConversation(conv._id, { participants: updated });
          }
        });
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
        livekitClient.joinCall(data.call_id).catch((e) => {
          console.error('[LiveKit] join failed:', e);
          toast.error('Could not join the call');
          callStore.getState().resetCall();
        });
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
        // Caller connects to the SFU room once the callee accepts.
        livekitClient.joinCall(cs.callId || data.call_id).catch((e) => {
          console.error('[LiveKit] join failed:', e);
          toast.error('Could not connect the call');
          callStore.getState().endCall();
          this.send({ type: 'call:end', call_id: cs.callId || data.call_id });
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

  sendMessage(conversationId, content, tempId, replyTo = null) {
    this.send({
      type: 'message',
      conversation_id: conversationId,
      content,
      msg_type: 'text',
      temp_id: tempId,
      reply_to: replyTo
    });
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

  _showBrowserNotification(msg, convId, store) {
    try {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
      if (localStorage.getItem('rxhive_desktop_notif') === 'off') return;
      if (document.hasFocus()) return;

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

      const notif = new Notification(title, { body, tag: convId, renotify: true });
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
