import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PhoneOff, ChevronDown, UserPlus, Lock } from 'lucide-react';
import useCallStore from '../../stores/callStore';
import callSounds from '../../services/callSounds';
import wsClient from '../../services/websocket';
import livekitClient from '../../services/livekitClient';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

export const OutgoingCallScreen = () => {
  const { callState, callId, callType, showCallUI, incomingCaller, isGroupCall, isMinimized } = useCallStore();

  // isMinimized is part of the condition now. Without it the ChevronDown at the
  // top of this screen was DEAD: it flipped the flag, but this view kept
  // rendering over everything, so nothing appeared to happen. The minimised
  // window handles 'outgoing_ringing' so there is always something on screen.
  const isVisible = callState === 'outgoing_ringing' && showCallUI && !isMinimized;

  // Play ringback tone while ringing
  useEffect(() => {
    if (isVisible) {
      callSounds.playRingback();
    }
    return () => callSounds.stopAll();
  }, [isVisible]);

  if (!isVisible) return null;

  const dialingName = incomingCaller?.display_name
    || incomingCaller?.group_name
    || incomingCaller?.conversation_name
    || (isGroupCall ? 'Group call' : 'Calling');
  const name = dialingName;
  const initial = name.charAt(0).toUpperCase();
  const avatarUrl = incomingCaller?.avatar_url;
  const typeLabel = callType === 'video' ? 'Video calling' : 'Calling';

  const handleEnd = () => {
    callSounds.stopAll();
    wsClient.send({ type: 'call:cancel', call_id: callId });
    livekitClient.leave();
    useCallStore.getState().resetCall();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex flex-col"
        style={{ background: 'linear-gradient(180deg, #1a3a2a 0%, #0A0A0A 40%, #0A0A0A 100%)' }}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 pt-12 pb-2 flex-shrink-0">
          <button onClick={() => useCallStore.getState().toggleMinimize()}
            className="p-2 text-white/70 hover:text-white">
            <ChevronDown size={24} />
          </button>
          <div className="w-10" />
          <button className="p-2 text-white/70">
            <UserPlus size={22} />
          </button>
        </div>

        {/* Center - Avatar + Name + Status */}
        <div className="flex-1 flex flex-col items-center justify-center px-6">
          <motion.div
            animate={{ scale: [1, 1.04, 1] }}
            transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
            className="relative mb-6"
          >
            <div className="w-32 h-32 rounded-full overflow-hidden border-[3px] border-white/10 shadow-[0_0_60px_rgba(16,185,129,0.15)]">
              {avatarUrl ? (
                <img src={avatarUrl.startsWith('http') ? avatarUrl : `${backendUrl}${avatarUrl}`}
                  alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-[#10B981]/30 to-[#10B981]/10 flex items-center justify-center text-[#10B981] text-5xl font-semibold">
                  {initial}
                </div>
              )}
            </div>
          </motion.div>

          <h2 className="text-[22px] font-semibold text-white mb-1.5 text-center">{name}</h2>
          <span className="text-[15px] text-white/50 flex items-center gap-1">
            {typeLabel}
            <span className="inline-flex gap-0.5 ml-0.5">
              <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '200ms' }} />
              <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '400ms' }} />
            </span>
          </span>
        </div>

        {/* End call */}
        <div className="flex justify-center pb-8 safe-bottom">
          <button onClick={handleEnd}
            className="w-[72px] h-[72px] rounded-full bg-[#EF4444] flex items-center justify-center shadow-lg shadow-red-500/20 active:scale-90 transition-transform">
            <PhoneOff size={32} className="text-white" />
          </button>
        </div>

        {/* E2E badge */}
        <div className="flex items-center justify-center gap-1.5 pb-6 safe-bottom">
          <Lock size={11} className="text-white/20" />
          <span className="text-[11px] text-white/20">End-to-end encrypted</span>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
