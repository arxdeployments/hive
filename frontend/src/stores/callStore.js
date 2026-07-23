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
  callHistory: [],
  missedCallCount: 0,
  activeGroupCalls: {},
  // LiveKit-fed media state
  localStream: null,
  isScreenSharing: false,
  activeSpeakerIds: [],
  networkQuality: 'good',

  initiateCall: (callId, callType, isGroup = false, conversationId = null) => set({
    callState: 'outgoing_ringing', callId, callType, isGroupCall: isGroup,
    conversationId, showCallUI: true, isCameraOn: callType === 'video',
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
      localStream: null, isScreenSharing: false, activeSpeakerIds: [], networkQuality: 'good',
    });
  },

  toggleMute: () => set(s => ({ isMuted: !s.isMuted })),
  toggleCamera: () => set(s => ({ isCameraOn: !s.isCameraOn })),
  toggleMinimize: () => set(s => ({ isMinimized: !s.isMinimized })),

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
