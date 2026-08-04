import { create } from 'zustand';

/**
 * Stable per browser profile, and the LiveKit identity's device suffix.
 *
 * A LiveKit identity must be unique per connection: while every device of a user
 * shared the bare user id, whichever client connected second was evicted by the
 * SFU as a duplicate identity — silently, which is why "the call connects and then
 * one side goes quiet" had no error anywhere. localStorage rather than a
 * per-page-load value so a reload during a call reclaims the SAME identity, which
 * is what lets the SFU replace the abandoned connection instead of leaving a ghost
 * participant in the room for the rest of the call.
 */
const DEVICE_ID_KEY = 'rxhive_device_id';

export const deviceId = (() => {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;
    const fresh = (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
    localStorage.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    // Private mode with storage disabled: a per-session id is still unique, it
    // just cannot be reclaimed after a reload.
    return (crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  }
})();

/** Link states, matching the server's `call:peer_state` vocabulary exactly. */
export const LINK_OK = 'connected';
export const LINK_RECONNECTING = 'reconnecting';

const useCallStore = create((set, get) => ({
  callState: 'idle',
  callId: null,
  callType: null,
  isGroupCall: false,
  conversationId: null,
  localUser: null,
  remoteParticipants: [],
  /**
   * People invited into this call who have not answered yet.
   *
   * The server has published `call:participants_invited` to everyone already in the
   * call since the invite endpoint existed, precisely so the grid can show that
   * somebody is on the way — and nothing read it, so an invitee materialised out of
   * nowhere when they answered and an invite that was never answered left no trace at
   * all. Cleared per-person as they join (see addRemoteParticipant) rather than on a
   * timer, because "still ringing" is exactly the state worth showing.
   */
  pendingInvitees: [],
  incomingCaller: null,
  isMuted: false,
  isCameraOn: true,
  callStartTime: null,
  callDuration: 0,
  durationInterval: null,
  isMinimized: false,
  showCallUI: false,
  // Speaker (remote audio audible). Moved off ActiveCallView's local useState,
  // which was destroyed on every minimise AND purely cosmetic — nothing acted on
  // it. CallAudioSink now mutes its elements from this flag, so the toggle does
  // something real and survives minimise/restore.
  speakerOn: true,
  // Where the minimised call window sits. Seeded from localStorage so the corner
  // the user dragged it to survives a reload; deliberately NOT cleared by
  // resetCall, so it also survives to the next call.
  miniPosition: null,
  callHistory: [],
  missedCallCount: 0,
  activeGroupCalls: {},
  // LiveKit-fed media state
  localStream: null,
  /** Our own screen share, kept apart from `localStream` (the camera) — see
   *  livekitClient._localScreenStream for why conflating them broke the self-view. */
  localScreenStream: null,
  isScreenSharing: false,
  activeSpeakerIds: [],
  networkQuality: 'good',

  // ---- Connectivity, ours and the peers' -----------------------------------
  //
  // Three separate things, because they fail separately and the user needs to be
  // told about all of them:
  //
  //   mediaLinkState  our own LiveKit room: 'reconnecting' while the SDK is
  //                   re-establishing after a network drop. The call is NOT over —
  //                   ending it here is what used to turn a two-second dead spot
  //                   into a dropped call.
  //   signalLinkState our own WebSocket. Without it we cannot hang up, accept, or
  //                   be told anything; media may still be flowing.
  //   peerStates      { [userId]: { state, quality } } — what the OTHER side told us
  //                   about its own link. The SFU never relays this, so a peer whose
  //                   network was failing looked completely normal from here: frozen
  //                   video and a running duration timer with no explanation.
  mediaLinkState: LINK_OK,
  signalLinkState: LINK_OK,
  peerStates: {},

  /**
   * `peer` labels the call for the minimised window. Without it incomingCaller
   * stayed null on every outgoing call, so the mini window fell through to the
   * literal string 'Active Call' for anything the local user placed.
   */
  initiateCall: (callId, callType, isGroup = false, conversationId = null, peer = null) => set({
    callState: 'outgoing_ringing', callId, callType, isGroupCall: isGroup,
    conversationId, showCallUI: true, isCameraOn: callType === 'video',
    incomingCaller: peer,
    mediaLinkState: LINK_OK, peerStates: {},
  }),

  receiveIncomingCall: (callId, caller, callType, isGroup = false, conversationId = null) => set({
    callState: 'incoming_ringing', callId, callType,
    incomingCaller: caller, isGroupCall: isGroup,
    conversationId, showCallUI: true,
    mediaLinkState: LINK_OK, peerStates: {},
  }),

  setCallState: (state) => set({ callState: state }),

  acceptCall: () => set({ callState: 'connecting' }),

  callConnected: () => {
    // Clear any existing interval to prevent memory leaks from duplicate calls
    const { durationInterval: existing, callStartTime } = get();
    if (existing) clearInterval(existing);
    const interval = setInterval(() => {
      set(state => ({ callDuration: state.callDuration + 1 }));
    }, 1000);
    set({
      callState: 'connected',
      // Preserved across a reconnect: this runs again after every successful
      // re-join, and restarting the clock made a call that had survived a blip
      // look like it had just begun.
      callStartTime: callStartTime || Date.now(),
      durationInterval: interval,
      mediaLinkState: LINK_OK,
    });
  },

  endCall: () => {
    const { durationInterval } = get();
    if (durationInterval) clearInterval(durationInterval);
    set({ callState: 'ended', showCallUI: true });
    setTimeout(() => get().resetCall(), 2000);
  },

  resetCall: () => {
    const { durationInterval } = get();
    if (durationInterval) clearInterval(durationInterval);
    set({
      callState: 'idle', callId: null, callType: null, isGroupCall: false,
      conversationId: null, localUser: null, remoteParticipants: [],
      pendingInvitees: [],
      incomingCaller: null, isMuted: false, isCameraOn: true,
      callStartTime: null, callDuration: 0, durationInterval: null,
      isMinimized: false, showCallUI: false,
      speakerOn: true,
      localStream: null, localScreenStream: null, isScreenSharing: false,
      activeSpeakerIds: [], networkQuality: 'good',
      mediaLinkState: LINK_OK, peerStates: {},
      // miniPosition intentionally omitted: the window's corner is a user
      // preference, not call state, and should persist across calls.
    });
  },

  toggleMute: () => set(s => ({ isMuted: !s.isMuted })),
  toggleCamera: () => set(s => ({ isCameraOn: !s.isCameraOn })),
  toggleMinimize: () => set(s => ({ isMinimized: !s.isMinimized })),
  toggleSpeaker: () => set(s => ({ speakerOn: !s.speakerOn })),
  setMiniPosition: (pos) => set({ miniPosition: pos }),

  setMediaLinkState: (state) => set({ mediaLinkState: state }),
  setSignalLinkState: (state) => set({ signalLinkState: state }),

  /** Merge what a peer said about its own link. */
  setPeerState: (userId, patch) => set(s => (
    userId
      ? { peerStates: { ...s.peerStates, [userId]: { ...(s.peerStates[userId] || {}), ...patch } } }
      : {}
  )),

  /**
   * Upsert, not append.
   *
   * A participant arrives twice by design — once from the server's
   * `call:participant_joined` (which carries the avatar) and once from the room's
   * own roster (which carries the media). Appending blindly rendered the same
   * person as two tiles, one of them permanently blank.
   *
   * `identity` is the full LiveKit `{userId}#{device}` string when the room is the
   * source; it is what removeRemoteParticipantByIdentity matches on.
   */
  addRemoteParticipant: (p) => set(s => {
    if (!p?.id) return {};
    // Arriving retires the "ringing" placeholder. Done here rather than in the
    // websocket handler so it holds for every route a participant can appear by —
    // the socket frame, the room roster, and a resume after a reconnect.
    const pending = s.pendingInvitees.some(x => x.id === p.id)
      ? { pendingInvitees: s.pendingInvitees.filter(x => x.id !== p.id) }
      : {};
    const idx = s.remoteParticipants.findIndex(x => x.id === p.id);
    if (idx === -1) return { ...pending, remoteParticipants: [...s.remoteParticipants, p] };
    const merged = [...s.remoteParticipants];
    merged[idx] = { ...merged[idx], ...p };
    return { ...pending, remoteParticipants: merged };
  }),

  /**
   * Record people who have just been invited, so the grid can show them ringing.
   *
   * Anyone already in the call is dropped: an invite of somebody present is reported
   * `already_invited` by the server and adds nobody, and a phantom "ringing" tile for
   * a participant who is visibly on the call is worse than no tile at all.
   */
  addPendingInvitees: (people) => set(s => {
    const known = new Set([
      ...s.remoteParticipants.map(p => p.id),
      ...s.pendingInvitees.map(p => p.id),
    ]);
    // `known` grows as we go, so a person repeated WITHIN one batch is caught too.
    // Filtering against a fixed set let the same id through twice as two tiles.
    const fresh = [];
    for (const p of (Array.isArray(people) ? people : [])) {
      if (!p?.id || known.has(p.id)) continue;
      known.add(p.id);
      fresh.push(p);
    }
    return fresh.length ? { pendingInvitees: [...s.pendingInvitees, ...fresh] } : {};
  }),

  removePendingInvitee: (uid) => set(s => (
    s.pendingInvitees.some(p => p.id === uid)
      ? { pendingInvitees: s.pendingInvitees.filter(p => p.id !== uid) }
      : {}
  )),

  removeRemoteParticipant: (uid) => set(s => ({
    remoteParticipants: s.remoteParticipants.filter(p => p.id !== uid),
    peerStates: Object.fromEntries(Object.entries(s.peerStates).filter(([k]) => k !== uid)),
  })),

  /**
   * Remove a room participant only if the tile still belongs to that connection.
   *
   * Tiles are keyed by user id so the socket and the SFU agree on who is who, but
   * LiveKit identities are per-device. When a client reloads mid-call the new
   * connection replaces the tile and the OLD identity's disconnect arrives
   * afterwards — removing the tile then would delete the live participant.
   */
  removeRemoteParticipantByIdentity: (identity, userId) => set(s => {
    const existing = s.remoteParticipants.find(p => p.id === userId);
    if (!existing) return {};
    if (existing.identity && identity && existing.identity !== identity) return {};
    return {
      remoteParticipants: s.remoteParticipants.filter(p => p.id !== userId),
      peerStates: Object.fromEntries(Object.entries(s.peerStates).filter(([k]) => k !== userId)),
    };
  }),

  updateRemoteParticipant: (uid, updates) => set(s => ({
    remoteParticipants: s.remoteParticipants.map(p => p.id === uid ? { ...p, ...updates } : p)
  })),

  setActiveGroupCall: (convId, data) => set(s => ({ activeGroupCalls: { ...s.activeGroupCalls, [convId]: data } })),
  removeActiveGroupCall: (convId) => set(s => { const { [convId]: _, ...rest } = s.activeGroupCalls; return { activeGroupCalls: rest }; }),

  setMissedCallCount: (count) => set({ missedCallCount: count }),
  setCallHistory: (h) => set({ callHistory: h }),
}));

/**
 * True while anything about the connection should stop the UI claiming the call
 * is healthy: our own media link re-establishing, our signalling gone, or a peer
 * telling us theirs is. Both ends therefore show "Connecting…" for one event.
 */
export const isCallStalled = (s) =>
  s.mediaLinkState === LINK_RECONNECTING
  || s.signalLinkState === LINK_RECONNECTING
  || Object.values(s.peerStates).some(p => p?.state === LINK_RECONNECTING);

/** Whether a call is live enough that dropping the connection matters. */
export const hasLiveCall = (s) =>
  s.callState !== 'idle' && s.callState !== 'ended';

export default useCallStore;
