import { toast } from 'sonner';
import useChatStore from '../stores/chatStore';
import useCallStore, { hasLiveCall, LINK_OK, LINK_RECONNECTING } from '../stores/callStore';
import livekitClient from './livekitLazy';
import callSounds from './callSounds';
import { refreshSession, sessionRejected, setSignOutReason } from '../api/client';
import { withDerivedStatus, applyReadReceipt } from '../utils/messageStatus';
import { handleCallJoinError, notifyCameraUnavailable } from '../utils/callErrors';
import { isDesktopNotifDisabled } from '../utils/notificationPrefs';

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

/**
 * How long an Accept may sit unanswered by the SERVER before we tell the user.
 *
 * Pressing Answer is the point of no return for the user's patience: if the
 * `call:accept` frame never reaches the server (socket closed under it) or the
 * `call:accepted` reply never comes back, the old code left "Connecting…" on
 * screen indefinitely with no timeout and no error — indistinguishable from every
 * other reason a call fails. Comfortably longer than a reconnect + retry, and far
 * shorter than the server's 45s ring window, so the user hears about it while the
 * call could still in principle be salvaged by redialling.
 *
 * **It covers the signalling gap only, and is disarmed the moment a join begins.**
 * Letting it also cover the media join was a real regression: the token round trip,
 * `getUserMedia` and `room.connect` are legitimately slow on a real network, and
 * when the deadline passed mid-join the handler sent `call:end` to the peer. The
 * join then completed anyway, so this side showed a healthy call while the other
 * side had been told it was over — one client "connected", the other never. The
 * join reports its own failures with specific reasons (utils/callErrors) and
 * `room.connect` has its own timeout; a second, blinder deadline over the top of
 * that can only destroy calls that were about to succeed.
 */
const ACCEPT_TIMEOUT_MS = 20000;

/** Reconnect ceiling while a call is live. A 30s backoff is fine for chat and
 *  useless for a call the user is sitting in. */
const IN_CALL_RECONNECT_MAX_MS = 2000;

/** How long a ping has to be answered before the socket is treated as a ghost. */
const PONG_TIMEOUT_MS = 10000;

/**
 * How long a text send has to be acked before its bubble is marked failed.
 *
 * Comfortably above any normal insert and below the 30s heartbeat. The deadline
 * is not the primary resolution — losing the socket flushes everything pending
 * immediately — it is the backstop for a socket that stays healthy while the
 * server never answers.
 */
const ACK_TIMEOUT_MS = 15000;

/**
 * How long a desktop notification waits for a service worker to activate before
 * giving up and using the `Notification` constructor instead.
 *
 * `navigator.serviceWorker.ready` resolves only when a registration reaches
 * "activated" and, per spec, NEVER rejects. So when registration failed there is
 * nothing to activate and the await parks for the life of the tab — and
 * lib/pwa.js swallows a failed `register()` with a console.warn, so a mis-served
 * /sw.js, a path rewrite in front of the app or an enterprise policy all land
 * here silently. The `catch` below was written as the fallback path and could
 * never run: a promise that never settles throws nothing. Every desktop
 * notification was simply lost, with no error anywhere to say so.
 */
const SW_READY_TIMEOUT_MS = 3000;

/**
 * How much longer a notification with nowhere else to go will wait for that same
 * activation to finish.
 *
 * Only Android Chrome gets here, and only because losing the race above is fatal
 * there: the `Notification` constructor is unsupported and throws, so a worker
 * that was merely slow to activate — a cold start, a slow device, a first
 * install — took the notification down with it. Nothing was listening when the
 * registration turned up a moment later.
 *
 * Bounded, for the two reasons the timeout above exists at all. `ready` never
 * settles when registration failed outright, so an open-ended continuation would
 * park for the life of the tab, once per dropped message. And a message alert
 * that surfaces long after the message is noise rather than a rescue — past this
 * point the unread badge is the better messenger.
 */
const SW_LATE_READY_TIMEOUT_MS = 30000;

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
    /// Text sends that have left the socket with no message_ack yet:
    /// temp_id -> { convId, timer }.
    this._pendingAcks = new Map();
    this._intentionalClose = false;
    this._active = false;
    /// The call this client answered, so only the answering device joins the SFU.
    this._acceptedCallId = null;
    this._acceptTimer = null;
    /// Guards against two overlapping resume fetches on a flapping connection.
    this._resuming = false;

    // An SFU drop ends the call here — but only once livekitClient has exhausted
    // its re-join attempts, so a network blip no longer reaches this point at all.
    // Without this the room could vanish underneath a "connected" UI and nothing
    // in the app would notice.
    livekitClient.onUnexpectedDisconnect = (callId, reason) => {
      const cs = useCallStore.getState();
      if (!hasLiveCall(cs)) return;
      console.warn('[call] ending call after an unrecoverable SFU disconnect', { callId, reason });
      toast.error('Call disconnected');
      cs.endCall();
      if (callId) this.send({ type: 'call:end', call_id: callId });
    };

    // Relay our own link health to the other side. The SFU tells only us that our
    // uplink is failing, so without this a peer whose network was dying looked
    // perfectly healthy from across the call: a frozen picture and a running
    // duration timer, with nothing to explain either.
    livekitClient.onLocalLinkState = (callId, patch) => {
      if (!callId) return;
      this.send({ type: 'call:link_state', call_id: callId, ...patch });
    };

    this._installConnectivityListeners();
  }

  /**
   * Reconnect the moment the browser says it can, rather than waiting out a
   * backoff timer.
   *
   * Without these a laptop that woke from sleep, or a phone that regained signal,
   * sat disconnected until the next scheduled attempt — up to 30 seconds, during
   * which an incoming call could not be delivered at all. `visibilitychange`
   * matters just as much: background tabs have their timers throttled to roughly
   * one per minute, so the heartbeat that is supposed to notice a dead socket can
   * itself be asleep.
   */
  _installConnectivityListeners() {
    if (typeof window === 'undefined' || this._connectivityBound) return;
    this._connectivityBound = true;

    const wake = (why) => {
      if (!this._active || this._intentionalClose) return;
      if (this.isOpen()) {
        // Open according to us — but a socket that died with the network can stay
        // "open" for minutes. Ping now; the pong timeout closes it if it is a ghost.
        this._ping();
        return;
      }
      console.info('[WS] reconnecting early:', why);
      this.reconnectAttempts = 0;
      this.connect();
    };

    window.addEventListener('online', () => wake('network online'));

    // `offline` is the fastest and most definitive signal there is: the browser is
    // telling us nothing can be sent. Without it the earliest this client could
    // notice was the heartbeat — up to 30s for the next ping plus 10s for the pong
    // to time out — during which a live call showed a happily ticking duration.
    // The requirement is that the user is told their connection has gone; a
    // forty-second wait to say so does not meet it.
    window.addEventListener('offline', () => {
      if (!this._active || this._intentionalClose) return;
      console.warn('[WS] browser reports offline');
      if (hasLiveCall(useCallStore.getState())) {
        useCallStore.getState().setSignalLinkState(LINK_RECONNECTING);
      }
      useChatStore.getState().setWsConnected(false);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') wake('tab visible');
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) wake('restored from page cache');
    });

    // A tapped call notification. Handled here rather than in a page component
    // because it must work whatever route the user is on — the ring is not a chat
    // feature, and Chat.jsx is not always mounted.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type !== 'rxhive:incoming-call') return;
        console.info('[call] woken by a call notification', event.data.callId || '');
        wake('call notification');
        this._resumeCallState();
      });
    }
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
    useCallStore.getState().setSignalLinkState(LINK_OK);

    if (wasReconnect) {
      this._syncAfterReconnect();
    }

    // Always, not only on a reconnect: a socket opened on a fresh page load has to
    // discover a call that is already ringing or connected too. This is the client
    // half of the fix for every `call:*` frame lost while the socket was down —
    // they are fire-and-forget publishes, so a ring delivered during a two-second
    // handover was previously gone for good and the phone never rang.
    this._resumeCallState();

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

  /**
   * Ask the server what call this client should be in, and reconcile.
   *
   * The server also pushes `call:incoming` / `call:resume` on connect, so this is
   * belt-and-braces — but it is the half that cannot be lost, and it is the only
   * path that works on a cold page load. Deliberately additive: it never ends a
   * call, only adopts one we are missing or rejoins a room we should be in.
   */
  async _resumeCallState() {
    if (this._resuming) return;
    this._resuming = true;
    try {
      const client = (await import('../api/client')).default;
      const { data } = await client.get('/api/calls/active');
      this._applyResumedCall(data?.call || null);
    } catch (err) {
      // A failed resume costs a stale UI until the next connect, never a wrong
      // decision — so it is logged and dropped rather than acted on.
      console.warn('[call] could not resume call state:', err?.message || err);
    } finally {
      this._resuming = false;
    }
  }

  /**
   * Adopt the server's view of the live call.
   *
   * Four cases, and the distinctions matter:
   *  - nothing live, but this client thinks otherwise → the call ended while we
   *    were away; clear up rather than leaving a dead call on screen forever.
   *  - ringing, we are the callee → show the ringer (this is the recovered ring).
   *  - connected and we had joined → rejoin the room if we are not in it.
   *  - connected group call we never joined → offer "Join call", don't hijack the
   *    screen with a ringer for a call already in progress.
   */
  _applyResumedCall(call) {
    const cs = useCallStore.getState();

    if (!call) {
      if (hasLiveCall(cs) && cs.callState !== 'outgoing_ringing') {
        console.info('[call] server reports no live call; clearing local state');
        livekitClient.leave();
        cs.resetCall();
      }
      return;
    }

    for (const [userId, state] of Object.entries(call.peer_links || {})) {
      if (userId !== this._currentUserId()) {
        cs.setPeerState(userId, { state: state === 'down' ? LINK_RECONNECTING : LINK_OK });
      }
    }

    const isRinging = call.status === 'ringing';

    if (isRinging && !call.is_initiator) {
      if (cs.callId !== call.call_id) {
        console.info('[call] recovered a ring missed while offline', call.call_id);
        cs.receiveIncomingCall(
          call.call_id, call.caller, call.call_type, call.is_group, call.conversation_id
        );
      }
      return;
    }

    if (isRinging && call.is_initiator) {
      // Our own outgoing ring, recovered — a reload or a dropped socket during the
      // 45 seconds the server keeps ringing. Without this the caller's screen went
      // blank while the callee's phone was still ringing, and the only way out was
      // to wait for the timeout.
      if (cs.callId !== call.call_id) {
        console.info('[call] recovered our own outgoing ring', call.call_id);
        const peer = (call.participants || [])
          .find((p) => p.id !== this._currentUserId()) || null;
        cs.initiateCall(
          call.call_id, call.call_type, call.is_group, call.conversation_id, peer
        );
      }
      return;
    }

    if (call.status === 'connected' && call.is_group && !call.self_joined) {
      if (call.conversation_id) {
        cs.setActiveGroupCall(call.conversation_id, {
          call_id: call.call_id,
          participants: call.participants,
          call_type: call.call_type,
        });
      }
      return;
    }

    if (call.status !== 'connected' || !call.self_joined) return;

    // We belong in this room. Re-establish the UI first so the user sees the call
    // rather than a blank app, then get the media back.
    if (cs.callId !== call.call_id) {
      console.info('[call] recovered a connected call missed while offline', call.call_id);
      useCallStore.setState({
        callId: call.call_id,
        callType: call.call_type,
        isGroupCall: call.is_group,
        conversationId: call.conversation_id,
        incomingCaller: call.caller,
        showCallUI: true,
      });
      for (const p of call.participants || []) {
        if (p.id !== this._currentUserId()) cs.addRemoteParticipant(p);
      }
      cs.setCallState('connecting');
      cs.callConnected();
      this._acceptedCallId = call.call_id;
    }

    if (!livekitClient.isEngaged(call.call_id)) {
      console.info('[call] rejoining the room after a signalling reconnect', call.call_id);
      joinLiveKit(call.call_id, 'resume', () => {
        useCallStore.getState().endCall();
        this.send({ type: 'call:end', call_id: call.call_id });
      });
    }
  }

  /**
   * Arm/clear the "Answer went nowhere" timeout. See ACCEPT_TIMEOUT_MS.
   */
  _armAcceptTimeout(callId) {
    this._clearAcceptTimeout();
    this._acceptTimer = setTimeout(() => {
      this._acceptTimer = null;
      const cs = useCallStore.getState();
      if (cs.callId !== callId) return;
      if (cs.callState === 'connected') return;
      console.warn('[call] accept timed out with no connection', callId);
      toast.error('Could not connect the call. Check your connection and try again.');
      livekitClient.leave();
      this.send({ type: 'call:end', call_id: callId });
      cs.resetCall();
    }, ACCEPT_TIMEOUT_MS);
  }

  _clearAcceptTimeout() {
    if (this._acceptTimer) {
      clearTimeout(this._acceptTimer);
      this._acceptTimer = null;
    }
  }

  _clearPendingAck(tempId) {
    const pending = this._pendingAcks.get(tempId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this._pendingAcks.delete(tempId);
  }

  /**
   * Give up on a text send the server never acknowledged.
   *
   * Guarded on the row still being 'sending' rather than fired blind: an ack or
   * an error frame may have landed between the deadline being armed and this
   * running, and neither may be overwritten. `replaceOptimisticMessage` also
   * no-ops when the row has gone, so this can never resurrect a bubble the
   * reconnect refetch already replaced with the real message.
   */
  _failPendingAck(tempId) {
    const pending = this._pendingAcks.get(tempId);
    if (!pending) return;
    this._clearPendingAck(tempId);
    const msgs = useChatStore.getState().messages[pending.convId] || [];
    if (!msgs.some(m => m.temp_id === tempId && m.status === 'sending')) return;
    useChatStore.getState().replaceOptimisticMessage(pending.convId, tempId, { status: 'failed' });
  }

  /**
   * Resolve every unacked send at once, because the socket that owed us those
   * acks is gone.
   *
   * This runs before anything can reconnect, and that ordering is the whole
   * point. ChatPanel force-refetches when `wsConnected` goes false -> true;
   * `wsConnected` only goes true in `_onOpen`; and `connect()` early-returns
   * while the socket is CONNECTING or OPEN — so no `_onOpen` can happen without
   * passing through `_onClose` or `_abandonSocket` first. The bubble is
   * therefore already 'failed' by the time the refetch's carry-over filter looks
   * at it, however fast the reconnect is. The 15s deadline on its own would lose
   * that race against a wake() that abandons a ghost after one pong timeout.
   */
  _failAllPendingAcks() {
    for (const tempId of [...this._pendingAcks.keys()]) this._failPendingAck(tempId);
  }

  _onMessage(event) {
    // Bytes arrived on this socket, so our signalling is not gone. Recorded before
    // the frame is even parsed — the proof is the delivery, not the contents.
    this._noteSignalAlive();
    try {
      const data = JSON.parse(event.data);
      this._routeMessage(data);
    } catch (err) {
      console.error('[WS] Failed to parse message:', err);
    }
  }

  /**
   * The socket is demonstrably alive: stop claiming our signalling is down.
   *
   * `_onOpen` used to be the ONLY path back to `LINK_OK`, and that is not enough,
   * because a socket does not have to DIE for us to have marked it down. The
   * `offline` listener marks signalling down the instant the browser says nothing
   * can be sent — which is right, and is the whole point of that listener — but a
   * brief outage can begin and end with the SAME socket still `OPEN`: a Wi-Fi /
   * cellular handover, an interface flap, a VPN reconnecting, or CDP's network
   * emulation in the E2E suite. No close event, so no reopen, so nothing ever
   * cleared the flag. One leg of `isCallStalled` stayed latched and "Connecting…"
   * sat over a call whose audio had been flowing for minutes — and, because
   * `resetCall` deliberately does not touch socket state, it sat over the NEXT
   * call too. Measured on a video call recovering from a ~6s outage: one socket,
   * opened once, never closed, `readyState` 1 for the whole thing.
   *
   * An inbound frame is the proof, and the `pong` answering `_ping()` is the
   * specific one that lands within milliseconds of the network returning. A socket
   * that can deliver TO us but not send is not distinguishable from here and does
   * not need to be: its unanswered ping abandons it and marks signalling down
   * again.
   *
   * Unconditional, not gated on `hasLiveCall`: a flag left latched by a call that
   * has since ended is exactly the state that must not survive into the next one.
   */
  _noteSignalAlive() {
    if (useCallStore.getState().signalLinkState !== LINK_RECONNECTING) return;
    useCallStore.getState().setSignalLinkState(LINK_OK);
  }

  async _onClose(event) {
    this._stopHeartbeat();
    // Before the await on the 4001 branch below, and before anything can
    // reconnect: an unacked send has to be resolved while the refetch that will
    // otherwise delete it is still in the future.
    this._failAllPendingAcks();
    useChatStore.getState().setWsConnected(false);

    // Losing signalling mid-call is a "Connecting…", not a hang-up. The server
    // holds the call open for its reconnect grace window and the SFU very often
    // keeps carrying audio throughout, so tearing anything down here would end
    // calls that were about to recover — including on the routine 4001 every
    // client takes when its 15-minute access cookie lapses.
    if (hasLiveCall(useCallStore.getState())) {
      useCallStore.getState().setSignalLinkState(LINK_RECONNECTING);
    }

    if (event.code === 4001) {
      // Access cookie expired — refresh the session, then reconnect.
      try {
        await refreshSession();
        this._scheduleReconnect(true);
      } catch (err) {
        // Only the server refusing the refresh cookie proves the session is over.
        // The server closes 4001 every time the 15-minute access cookie lapses, so
        // this path runs constantly and samples network health each time; treating
        // an undelivered refresh as expiry meant one dropped connection — or a 502
        // during a deploy — signed the user out of a session good for 30 more days.
        // Anything else backs off and retries like a normal disconnect.
        if (sessionRejected(err)) {
          localStorage.removeItem('user');
          setSignOutReason('expired');
          // Guarded, matching client.js: already being on /login is not a reason
          // to navigate again, and a reload there would clear the form.
          if (window.location.pathname !== '/login') window.location.href = '/login';
          return;
        }
        this._scheduleReconnect();
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
        this._clearPendingAck(temp_id);
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

      // A super admin changed a rule or a send policy that affects this user.
      //
      // The payload carries no detail on purpose: what changed may be a
      // department rule touching hundreds of pairs, and sending the resolved
      // consequence to every affected client is both large and racy. A bare
      // "something changed, re-read it" keeps the server authoritative.
      //
      // Soft by design — nothing is torn down. The roster and the send policy
      // are re-fetched and the composer re-renders; a conversation that is no
      // longer permitted goes read-only on its next send rather than
      // disappearing mid-sentence. Losing this event costs a stale UI until the
      // next fetch, never a lifted restriction: the server re-checks every send.

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
          const msgs = store.messages[rConvId];
          // No window loaded for this thread, so there is nothing to patch — and
          // `|| []` is not harmless here: setMessages would write the empty array
          // into the store, which is exactly the array addMessage now tests for
          // before it will extend a thread. One reaction in a conversation this tab
          // has never opened would re-arm the accumulation that guard exists to stop.
          if (msgs?.length) {
            store.setMessages(rConvId, msgs.map(m =>
              m._id === rMsgId ? { ...m, reactions } : m
            ));
          }
        }
        break;
      }

      // A pin is conversation-wide, and both the pinned banner and the bubble's
      // pin icon read `is_pinned` off the message — so without this everyone
      // except the actor keeps the stale state until the thread is re-fetched.
      case 'message_pin_update': {
        const { message_id: pMsgId, conversation_id: pConvId, is_pinned: pinned } = data;
        if (pConvId && pMsgId) {
          const msgs = store.messages[pConvId];
          // No window loaded for this thread, so there is nothing to patch — and
          // `|| []` is not harmless here: setMessages would write the empty array
          // into the store, which is exactly the array addMessage now tests for
          // before it will extend a thread. One reaction in a conversation this tab
          // has never opened would re-arm the accumulation that guard exists to stop.
          if (msgs?.length) {
            store.setMessages(pConvId, msgs.map(m =>
              m._id === pMsgId ? { ...m, is_pinned: pinned } : m
            ));
          }
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
          const msgs = store.messages[dConvId];
          // No window loaded for this thread, so there is nothing to patch — and
          // `|| []` is not harmless here: setMessages would write the empty array
          // into the store, which is exactly the array addMessage now tests for
          // before it will extend a thread. One reaction in a conversation this tab
          // has never opened would re-arm the accumulation that guard exists to stop.
          if (msgs?.length) {
            store.setMessages(dConvId, msgs.map(m =>
              m._id === dMsgId ? { ...m, is_deleted: true, content: '', media_url: null } : m
            ));
          }
        }
        break;
      }

      case 'message_edited': {
        const { message_id: eMsgId, conversation_id: eConvId, content, edited_at } = data;
        if (eConvId && eMsgId) {
          const msgs = store.messages[eConvId];
          // No window loaded for this thread, so there is nothing to patch — and
          // `|| []` is not harmless here: setMessages would write the empty array
          // into the store, which is exactly the array addMessage now tests for
          // before it will extend a thread. One reaction in a conversation this tab
          // has never opened would re-arm the accumulation that guard exists to stop.
          if (msgs?.length) {
            store.setMessages(eConvId, msgs.map(m =>
              m._id === eMsgId ? { ...m, content, edited_at } : m
            ));
          }
        }
        break;
      }

      // ===== CALL SIGNALS (media itself flows through LiveKit, not here) =====
      case 'call:incoming': {
        const cs = callStore.getState();
        // `replayed` marks a ring re-delivered because our socket was down when the
        // original was published (services/calls.replay_pending_ring). Idempotent by
        // call id: the same ring arriving twice must not restart the ringer or clear
        // a call we have already answered.
        if (cs.callId === data.call_id && hasLiveCall(cs)) break;
        cs.receiveIncomingCall(
          data.call_id, data.caller, data.call_type,
          data.is_group, data.conversation_id
        );
        break;
      }
      case 'call:resume': {
        // The server's full picture of a call we may have missed frames for.
        // Reconciled through the same path as the REST resume so there is one
        // decision table for "what should be on screen", not two.
        this._applyResumedCall(data.call || null);
        break;
      }
      case 'call:ringing_started': {
        const cs = callStore.getState();
        if (cs.callState === 'outgoing_ringing' && data.call_id && !cs.callId) {
          callStore.setState({ callId: data.call_id });
        }
        // Not a refusal — the server rings for its full window regardless, and the
        // callee's socket may well reappear before it closes. Said once, quietly,
        // so the caller understands why it may take a moment.
        if (data.callee_online === false) {
          toast.info('They may be offline — still ringing', { duration: 4000 });
        }
        break;
      }
      // A peer told us about ITS OWN link. This is the only way this client can
      // learn that the other side is struggling: the SFU relays connection quality
      // to nobody but the affected participant.
      case 'call:peer_state': {
        if (!data.user_id) break;
        callStore.getState().setPeerState(data.user_id, {
          ...(data.state ? { state: data.state } : {}),
          ...(data.quality ? { quality: data.quality } : {}),
        });
        break;
      }
      case 'call:group_started': {
        // The id, first of all.
        //
        // A group call is opened with `call:group_initiate`, which carries a
        // conversation id — the CALL id is minted by the server and comes back here.
        // Nothing recorded it, so the initiator of every group call held
        // `callId: null` (initiateCall is called with an explicit null) for the entire
        // call. Media still worked, because the join is handed `data.call_id`
        // directly, which is exactly why this survived: everything keyed on the id
        // silently did nothing instead. `call:end` from the initiator's own Hang up
        // went out as `call_id: null` and the server dropped it — the call only really
        // ended via the LiveKit webhook or the reconnect grace expiring — and any REST
        // action on the call (adding people) built a `/api/calls/null/...` URL.
        if (data.call_id) callStore.setState({ callId: data.call_id });
        callStore.getState().setCallState('connected');
        callStore.getState().callConnected();
        joinLiveKit(data.call_id, 'group_started', () => callStore.getState().resetCall());
        break;
      }
      case 'call:group_participants': {
        // Same reason as `call:group_started`: this is the server's authoritative id for
        // the call this client was just admitted to, and a joiner who arrived through
        // the conversation's Join affordance rather than a ring may not have it yet.
        if (data.call_id) callStore.setState({ callId: data.call_id });
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
        if (livekitClient.isEngaged(data.call_id)) {
          this._clearAcceptTimeout();
          break;
        }
        // Disarmed here, before the join, not after it — see the note on
        // ACCEPT_TIMEOUT_MS. The server has answered, so the gap this watchdog covers
        // is closed; letting it also cover the media join means a slow-but-successful
        // join gets `call:end` sent out from under it.
        this._clearAcceptTimeout();
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
        // The server's authoritative id, not our local one. `cs.callId ||` preferred
        // stale state and could join the wrong room after a previous call.
        const joinId = data.call_id || cs.callId;

        // Only ONE device per user may enter the room.
        //
        // This frame reaches every socket both users hold, because the bus is keyed
        // per user. Every device of a user also shares a single LiveKit identity
        // (backend mint_token), so if two of them connect, livekit-server evicts the
        // first as a duplicate identity. That was the whole bug: the callee's phone
        // was still ringing, it joined on this frame too, and because the browser
        // connects to the room BEFORE asking for the microphone while iOS asks first,
        // the browser always arrived earlier and was always the one evicted — with no
        // error, because RoomEvent.Disconnected did not touch call state.
        //
        // So: the device that actually pressed Accept joins. The accepter's OTHER
        // devices just stop ringing. The caller joins.
        const iAmTheAccepter = data.accepter_id && data.accepter_id === this._currentUserId();
        if (iAmTheAccepter && !this._acceptedCallId) {
          console.info('[call] accepted on another device, dismissing ringer', joinId);
          callStore.getState().resetCall();
          break;
        }
        // A frame for a call this tab has nothing to do with — a stale or duplicate
        // tab. Joining would evict whichever device is really on the call.
        if (!iAmTheAccepter && cs.callId !== joinId) {
          console.info('[call] ignoring call:accepted for a call this client is not in', joinId);
          break;
        }

        // Already in this room — a duplicate or replayed `call:accepted` (both
        // sides get one, the server replays it for a retried Accept, and a
        // reconnect can re-deliver it). Re-joining would tear down working media.
        if (livekitClient.isEngaged(joinId)) {
          this._clearAcceptTimeout();
          break;
        }

        console.info('[call] joining SFU after accept', { callId: joinId, accepter: data.accepter_id });
        // Disarmed before the join, not after — see the note on ACCEPT_TIMEOUT_MS.
        this._clearAcceptTimeout();
        cs.acceptCall();
        joinLiveKit(joinId, 'accepted', () => {
          callStore.getState().endCall();
          this.send({ type: 'call:end', call_id: joinId });
        });
        break;
      }
      case 'call:declined': {
        this._clearAcceptTimeout();
        livekitClient.leave();
        callStore.getState().endCall();
        break;
      }
      case 'call:ended': {
        this._clearAcceptTimeout();
        livekitClient.leave();
        callStore.getState().endCall();
        break;
      }
      case 'call:cancelled': {
        this._clearAcceptTimeout();
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
      // Someone in the call added people. Recorded so the grid shows them ringing
      // instead of having them appear from nowhere when they answer — and so an invite
      // nobody answers leaves visible evidence rather than none.
      case 'call:participants_invited': {
        if (data.call_id && data.call_id !== callStore.getState().callId) break;
        callStore.getState().addPendingInvitees(data.participants || []);
        break;
      }
      // An invitee said no. Only group calls send this — a declined 1:1 is
      // `call:declined`, which ends the call.
      case 'call:participant_declined': {
        if (data.call_id && data.call_id !== callStore.getState().callId) break;
        const who = data.participant?.display_name;
        callStore.getState().removePendingInvitee(data.participant_id);
        toast.info(who ? `${who} declined the call` : 'Someone declined the call');
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
        // `reason` is the accept/join/decline refusal path on the server: the call
        // had already rung out, been cancelled or ended. These used to return
        // silently, which left the UI sitting on "Connecting" with nothing to act on.
        console.warn('[call] server refused a call action', data);
        // An error for a call this client is not in — a stale tab, a second device —
        // must not tear down the call we ARE in.
        const errored = data.call_id;
        const current = callStore.getState().callId;
        if (errored && current && errored !== current) break;
        this._clearAcceptTimeout();
        if (data.reason === 'no_longer_ringing') {
          toast.info(data.status === 'missed' ? 'Call already ended' : 'Call is no longer available');
        } else if (data.reason === 'not_joinable') {
          toast.info('That call has already finished');
        } else if (data.reason) {
          toast.error('That call is no longer available');
        } else {
          toast.error(data.message || 'Call failed');
        }
        livekitClient.leave();
        callStore.getState().resetCall();
        break;
      }

      case 'error':
        console.error('[WS] Server error:', data.detail);
        if (data.temp_id) {
          this._clearPendingAck(data.temp_id);
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
    // Remember that THIS client is the one answering.
    //
    // `call:accepted` comes back to every device the accepting user has, and only
    // the device that actually answered may join the SFU — a second device sharing
    // the same LiveKit identity evicts the first. Recorded here rather than in the
    // overlay so no future caller of `send` can forget it. Cleared on any terminal
    // frame so a later call cannot inherit a stale claim.
    if (data?.type === 'call:accept' || data?.type === 'call:join') {
      this._acceptedCallId = data.call_id || null;
    } else if (data?.type === 'call:end' || data?.type === 'call:decline' || data?.type === 'call:cancel') {
      this._acceptedCallId = null;
      this._clearAcceptTimeout();
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this._rawSend(data);
      // Answering is the one action whose silence is unbearable: from here the user
      // is staring at "Connecting…" with no way to tell a slow network from a call
      // that will never connect. Armed only once the frame is actually on the wire.
      if (data?.type === 'call:accept' || data?.type === 'call:join') {
        this._armAcceptTimeout(data.call_id);
      }
      return true;
    }

    // Frames sent while the socket is down are DROPPED, not queued.
    //
    // A queue survives an entire offline period and then flushes at once on
    // reconnect, which replays intent that has expired: a `typing_start` from a
    // keystroke minutes ago shows the peer a phantom "typing…", a read_receipt
    // fires for a conversation the user has since left, and a queued
    // `call:initiate` RINGS the callee for a call abandoned before the
    // connection dropped. Typing and receipts are self-correcting (the receiver
    // clears typing after 4s, receipts are idempotent) and chat already refuses
    // to queue because the HTTP fallback owns it.
    //
    // But a DROPPED CALL FRAME IS NOT SELF-CORRECTING, and silence is the worst
    // possible answer for one. `call:accept` is a user pressing Answer: if it
    // never reaches the server the call stays `ringing`, the caller keeps
    // hearing ringback, and the answerer sits on "Connecting…" until the ring
    // timeout — which is indistinguishable from every other reason a call fails
    // to establish. Same for `call:end`, where the peer is left in a call alone.
    //
    // So call frames report failure instead of vanishing. The return value is
    // the contract: callers that care check it. Logged at warn level always, not
    // only in DEV, because this is exactly the line someone reads when a user
    // says "it says connecting and nothing happens".
    const isCallFrame = typeof data?.type === 'string' && data.type.startsWith('call:');
    if (isCallFrame) {
      console.warn('[call] SIGNAL NOT SENT — socket is not open', {
        frame: data.type,
        callId: data.call_id || null,
        readyState: this.ws ? this.ws.readyState : 'no socket',
      });
      // Tell the USER, not just the console, for the frames where silence is a
      // dead end they cannot diagnose. `call:link_state` is pure telemetry and
      // `call:toggle_media` is cosmetic, so those stay quiet; the rest are the
      // user pressing a button and deserve an answer. Reconnecting immediately
      // rather than waiting out the backoff gives the retry a chance to land.
      const loud = ['call:accept', 'call:join', 'call:initiate', 'call:group_initiate',
        'call:decline', 'call:cancel', 'call:end'];
      if (loud.includes(data.type)) {
        toast.error('No connection — the call could not be signalled. Reconnecting…');
        this.reconnectAttempts = 0;
        this.connect();
      }
      return false;
    }
    if (import.meta.env.DEV) {
      console.debug('[WS] dropped while disconnected:', data?.type);
    }
    return false;
  }

  _rawSend(data) {
    try {
      this.ws.send(JSON.stringify(data));
      if (typeof data?.type === 'string' && data.type.startsWith('call:')) {
        // Every outbound signal, logged with its call id. Pairs with the inbound
        // log in _handleMessage so a whole call can be reconstructed from one
        // console: who sent what, in what order, and what came back.
        console.info('[call] -> sent', data.type, data.call_id || '');
      }
    } catch (err) {
      console.error('[WS] Send failed:', err);
      // NOT queued. This throws when the socket has closed under us, so the
      // frame is as stale as anything in the drop path above, and a queued
      // call frame replayed minutes later is worse than one that failed loudly.
      if (typeof data?.type === 'string' && data.type.startsWith('call:')) {
        console.warn('[call] SIGNAL FAILED mid-send', data.type, data.call_id || '');
      }
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
    // `ws.send()` on a socket whose network has died neither throws nor drops —
    // it buffers into a connection nobody is reading. The frame leaving the
    // browser is therefore no evidence that it arrived, and `message_ack` is the
    // only thing that is: the server sends the ack, and the matching error
    // frame, to the sender alone, and never a `new_message` for your own
    // message. Without a deadline the bubble sat on 'sending' for ever, and the
    // reconnect refetch — which keeps only 'failed' rows — then deleted the
    // user's message with no toast and no way to retry.
    //
    // Armed here rather than at the callers so it covers both of them, and any
    // future one, for the same reason this method refuses to queue.
    this._clearPendingAck(tempId);
    this._pendingAcks.set(tempId, {
      convId: conversationId,
      timer: setTimeout(() => this._failPendingAck(tempId), ACK_TIMEOUT_MS),
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

  /**
   * Abandon a socket we can no longer trust, and get a new one.
   *
   * `close()` is NOT enough on its own, and assuming it was is what made a lost
   * network unrecoverable. A WebSocket closed while the network is gone cannot
   * complete its closing handshake, so it parks in `CLOSING` **and never fires
   * `onclose`** — measured, not theorised: readyState 2 for the whole of a
   * 70-second outage. Everything hanging off `_onClose` therefore never ran. No
   * "Connecting…", no reconnect scheduled, and the call left on screen with a
   * duration timer counting up over dead audio, indefinitely.
   *
   * So the socket is dropped by reference rather than by handshake: handlers
   * detached, `this.ws` nulled, state and reconnect driven from here. Whatever the
   * zombie does afterwards reaches nothing.
   */
  _abandonSocket(reason) {
    const zombie = this.ws;
    this.ws = null;
    this._stopHeartbeat();
    this._failAllPendingAcks();
    console.warn('[WS] abandoning the socket:', reason);

    if (zombie) {
      // Detached first: a late `onclose` from this socket must not be mistaken for
      // the CURRENT socket closing and schedule a second, competing reconnect.
      zombie.onopen = null;
      zombie.onmessage = null;
      zombie.onclose = null;
      zombie.onerror = null;
      try {
        zombie.close();
      } catch {
        /* already gone */
      }
    }

    useChatStore.getState().setWsConnected(false);
    if (hasLiveCall(useCallStore.getState())) {
      useCallStore.getState().setSignalLinkState(LINK_RECONNECTING);
    }
    this._scheduleReconnect();
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      // A socket that is not OPEN is the thing a heartbeat exists to catch.
      //
      // This used to be `if (readyState === OPEN) { ping }` with no else — so the
      // moment the socket stopped being OPEN the heartbeat went quiet and the client
      // sat there forever. Skipping the check is the one behaviour a liveness probe
      // must never have.
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._abandonSocket(`readyState=${this.ws ? this.ws.readyState : 'no socket'}`);
        return;
      }
      this._ping();
    }, 30000);
  }

  /**
   * Probe the socket, and hold it to an answer.
   *
   * The deadline is the point. A socket whose network died can sit in `OPEN`
   * indefinitely, so an unanswered ping is the only thing that proves it is a
   * ghost. `wake()` used to ping without one, which meant a network that came back
   * on a different interface — the socket still `OPEN`, still dead — waited for the
   * next heartbeat tick before anyone noticed: up to 30s, plus 10s for its pong,
   * with the call showing "Connecting…" throughout.
   *
   * The deadline is only armed if the frame actually left, so a ping dropped by
   * `send` for a closed socket cannot condemn the socket that replaces it.
   */
  _ping() {
    if (this.pongTimeout) clearTimeout(this.pongTimeout);
    this.pongTimeout = null;
    if (!this.send({ type: 'ping' })) return;
    this.pongTimeout = setTimeout(() => {
      this.pongTimeout = null;
      this._abandonSocket(`no pong within ${PONG_TIMEOUT_MS / 1000}s`);
    }, PONG_TIMEOUT_MS);
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

    // Jittered, not bare exponential. Every tab that was connected when the API
    // restarted wakes on the SAME schedule otherwise — 1s, 2s, 4s in lockstep —
    // and the herd hits a server that is still coming up. The web is the client
    // with the most concurrent sessions per user, since each tab holds its own
    // socket, so it needs this more than iOS does.
    //
    // The attempt counter needs no clamp: Math.pow overflows to Infinity and
    // Math.min caps it at maxReconnectDelay, so the ceiling already holds.
    //
    // While a call is live the ceiling drops to two seconds. A 30-second backoff is
    // right for chat, where the cost of waiting is a late message, and wrong for a
    // call: the server holds the call open for its reconnect grace window, so every
    // second spent backing off is a second of that window spent doing nothing, and
    // running past it loses a call that would otherwise have resumed.
    const ceiling = hasLiveCall(useCallStore.getState())
      ? IN_CALL_RECONNECT_MAX_MS
      : this.maxReconnectDelay;
    const delay = immediate
      ? 100
      : Math.min(1000 * Math.pow(2, this.reconnectAttempts), ceiling)
        + Math.random() * 1000;
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
    // Delegated to the shared sound manager, which owns one long-lived
    // AudioContext. This built a new one per message and never closed it, and
    // read the mute preference as 'off' — a value Settings never writes — so the
    // toggle did nothing and the tone died off after the sixth message anyway.
    callSounds.playMessage();
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
      // Was `=== 'off'`, which Settings never writes — it assigns a boolean, so
      // the stored value is "true"/"false". Turning desktop notifications off
      // therefore had no effect whatsoever.
      if (isDesktopNotifDisabled()) return;
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
          // Raced, not awaited outright — see SW_READY_TIMEOUT_MS. The loser is
          // `undefined` rather than a rejection, so a timeout falls through to
          // the constructor below by the same route a real failure would.
          const reg = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((resolve) => { setTimeout(resolve, SW_READY_TIMEOUT_MS); }),
          ]);
          if (reg && typeof reg.showNotification === 'function') {
            await reg.showNotification(title, options);
            return;
          }
        } catch {
          // fall through to the constructor
        }
      }

      try {
        const notif = new Notification(title, options);
        notif.onclick = () => {
          window.focus();
          store.setActiveConversation(convId);
          notif.close();
        };
      } catch (err) {
        // Where Android Chrome landed whenever activation overran the race
        // above: `reg` came back undefined, the constructor threw as it always
        // does there, and the outer catch dropped the notification for good.
        //
        // Losing that race is not the same as having no service worker, so the
        // registration still activating gets a second chance to deliver. No
        // guard is needed against showing this twice — the only way here is the
        // constructor throwing, and a constructor that throws has shown nothing.
        // A successful one returns without ever attaching this wait.
        if (!('serviceWorker' in navigator)) throw err;
        const reg = await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((resolve) => { setTimeout(resolve, SW_LATE_READY_TIMEOUT_MS); }),
        ]);
        if (reg && typeof reg.showNotification === 'function') {
          await reg.showNotification(title, options);
        }
      }
    } catch {
      // Notification may fail in some contexts
    }
  }

  disconnect() {
    this._intentionalClose = true;
    this._active = false;
    this._stopHeartbeat();
    this._clearAcceptTimeout();
    // Not left to `_onClose`. `_abandonSocket`'s docblock records the measured
    // behaviour this relies on: `close()` on a dead network can park in CLOSING
    // and never fire `onclose` at all. Relying on it would leave ack deadlines
    // armed past the end of the session, writing a 'failed' row into a store
    // nothing clears on logout — which the next login's first fetch would then
    // carry over into someone else's thread.
    this._failAllPendingAcks();
    if (this.ws) {
      // Detached before closing, for the same reason `_abandonSocket` detaches:
      // a late `onclose` from THIS socket must not run against its successor.
      // Everything `_onClose` would have done here is either already done above
      // or done below, and `_scheduleReconnect` is suppressed on an intentional
      // close anyway — so the only thing detaching removes is the chance of
      // flushing the next socket's in-flight sends.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onclose = null;
      this.ws.onerror = null;
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
