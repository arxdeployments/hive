import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, Video, PhoneOff, Users } from 'lucide-react';
import useCallStore from '../../stores/callStore';
import wsClient from '../../services/websocket';
import livekitClient from '../../services/livekitClient';
import callSounds from '../../services/callSounds';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const isSoundOff = () => {
  const setting = localStorage.getItem('rxhive_notif_sound');
  return setting === 'off' || setting === 'false';
};

export const IncomingCallOverlay = () => {
  const { callState, callId, callType, incomingCaller, showCallUI, isGroupCall } = useCallStore();

  const isVisible = callState === 'incoming_ringing' && showCallUI;

  // Play ringtone on mount, stop on unmount. Honors the user's notification sound setting.
  useEffect(() => {
    if (isVisible && !isSoundOff()) callSounds.playRingtone();
    return () => callSounds.stopAll();
  }, [isVisible]);

  if (!isVisible) return null;

  const name = incomingCaller?.display_name || 'Unknown';
  const initial = name.charAt(0).toUpperCase();
  const avatarUrl = incomingCaller?.avatar_url;
  const groupName = incomingCaller?.group_name || incomingCaller?.conversation_name || null;
  const typeLabel = isGroupCall
    ? (callType === 'video' ? 'Incoming group video call' : 'Incoming group voice call')
    : (callType === 'video' ? 'Incoming video call' : 'Incoming voice call');

  // Accept: send signaling only. websocket.js performs the LiveKit join when the
  // server confirms (call:accepted for direct, call:group_started for group).
  const handleAccept = () => {
    callSounds.stopAll();
    wsClient.send({ type: isGroupCall ? 'call:join' : 'call:accept', call_id: callId });
    useCallStore.getState().acceptCall();
  };

  const handleDecline = () => {
    callSounds.stopAll();
    wsClient.send({ type: 'call:decline', call_id: callId });
    livekitClient.leave();
    useCallStore.getState().resetCall();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
        style={{ background: 'linear-gradient(180deg, #1a3a2a 0%, #0A0A0A 40%, #0A0A0A 100%)' }}
      >
        {/* Avatar with pulse */}
        <motion.div
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          className="w-32 h-32 rounded-full overflow-hidden border-[3px] border-white/10 shadow-[0_0_60px_rgba(16,185,129,0.2)] mb-6"
        >
          {isGroupCall && !avatarUrl ? (
            <div className="w-full h-full bg-gradient-to-br from-[#10B981]/30 to-[#10B981]/10 flex items-center justify-center text-[#10B981]">
              <Users size={48} />
            </div>
          ) : avatarUrl ? (
            <img src={avatarUrl.startsWith('http') ? avatarUrl : `${backendUrl}${avatarUrl}`}
              alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-[#10B981]/30 to-[#10B981]/10 flex items-center justify-center text-[#10B981] text-5xl font-semibold">
              {initial}
            </div>
          )}
        </motion.div>

        <h2 className="text-[22px] font-semibold text-white mb-1.5">
          {isGroupCall ? (groupName || 'Group call') : name}
        </h2>
        {isGroupCall && (
          <p className="text-[13px] text-white/40 mb-1 -mt-1">{name} is calling</p>
        )}
        <p className="text-[15px] text-white/50 mb-20 flex items-center gap-1">
          {typeLabel}
          <span className="inline-flex gap-0.5 ml-0.5">
            <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '200ms' }} />
            <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '400ms' }} />
          </span>
        </p>

        {/* Accept / Decline */}
        <div className="flex items-center gap-20">
          <div className="flex flex-col items-center gap-2">
            <button onClick={handleDecline} data-testid="call-decline-btn"
              aria-label={`Decline ${callType} call from ${name}`}
              className="w-[72px] h-[72px] rounded-full bg-[#EF4444] flex items-center justify-center shadow-lg shadow-red-500/20 active:scale-90 transition-transform">
              <PhoneOff size={32} className="text-white" />
            </button>
            <span className="text-xs text-white/50">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button onClick={handleAccept} data-testid="call-accept-btn"
              aria-label={`Accept ${callType} call from ${name}`}
              className="w-[72px] h-[72px] rounded-full bg-[#10B981] flex items-center justify-center shadow-lg shadow-emerald-500/20 active:scale-90 transition-transform">
              {callType === 'video' ? <Video size={32} className="text-white" /> : <Phone size={32} className="text-white" />}
            </button>
            <span className="text-xs text-white/50">Accept</span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
