import { create } from 'zustand';

const useCallStore = create((set, get) => ({
  callState: 'idle',
  callId: null,
  callType: null,
  isGroupCall: false,
  conversationId: null,
  localUser: null,
  remoteParticipants: [],
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
  isScreenSharing: false,
  activeSpeakerIds: [],
  networkQuality: 'good',

  /**
   * `peer` labels the call for the minimised window. Without it incomingCaller
   * stayed null on every outgoing call, so the mini window fell through to the
   * literal string 'Active Call' for anything the local user placed.
   */
  initiateCall: (callId, callType, isGroup = false, conversationId = null, peer = null) => set({
    callState: 'outgoing_ringing', callId, callType, isGroupCall: isGroup,
    conversationId, showCallUI: true, isCameraOn: callType === 'video',
    incomingCaller: peer,
  }),

  receiveIncomingCall: (callId, caller, callType, isGroup = false, conversationId = null) => set({
    callState: 'incoming_ringing', callId, callType,
    incomingCaller: caller, isGroupCall: isGroup,
    conversationId, showCallUI: true,
  }),

  setCallState: (state) => set({ callState: state }),

  acceptCall: () => set({ callState: 'connecting' }),

  callConnected: () => {
    // Clear any existing interval to prevent memory leaks from duplicate calls
    const { durationInterval: existing } = get();
    if (existing) clearInterval(existing);
    const interval = setInterval(() => {
      set(state => ({ callDuration: state.callDuration + 1 }));
    }, 1000);
    set({ callState: 'connected', callStartTime: Date.now(), durationInterval: interval });
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
      incomingCaller: null, isMuted: false, isCameraOn: true,
      callStartTime: null, callDuration: 0, durationInterval: null,
      isMinimized: false, showCallUI: false,
      speakerOn: true,
      localStream: null, isScreenSharing: false, activeSpeakerIds: [], networkQuality: 'good',
      // miniPosition intentionally omitted: the window's corner is a user
      // preference, not call state, and should persist across calls.
    });
  },

  toggleMute: () => set(s => ({ isMuted: !s.isMuted })),
  toggleCamera: () => set(s => ({ isCameraOn: !s.isCameraOn })),
  toggleMinimize: () => set(s => ({ isMinimized: !s.isMinimized })),
  toggleSpeaker: () => set(s => ({ speakerOn: !s.speakerOn })),
  setMiniPosition: (pos) => set({ miniPosition: pos }),

  addRemoteParticipant: (p) => set(s => ({ remoteParticipants: [...s.remoteParticipants, p] })),
  removeRemoteParticipant: (uid) => set(s => ({ remoteParticipants: s.remoteParticipants.filter(p => p.id !== uid) })),
  updateRemoteParticipant: (uid, updates) => set(s => ({
    remoteParticipants: s.remoteParticipants.map(p => p.id === uid ? { ...p, ...updates } : p)
  })),

  setActiveGroupCall: (convId, data) => set(s => ({ activeGroupCalls: { ...s.activeGroupCalls, [convId]: data } })),
  removeActiveGroupCall: (convId) => set(s => { const { [convId]: _, ...rest } = s.activeGroupCalls; return { activeGroupCalls: rest }; }),

  setMissedCallCount: (count) => set({ missedCallCount: count }),
  setCallHistory: (h) => set({ callHistory: h }),
}));

export default useCallStore;
