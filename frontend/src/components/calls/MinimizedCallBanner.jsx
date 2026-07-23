import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import useCallStore from '../../stores/callStore';

const formatDuration = (s) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

export const MinimizedCallBanner = () => {
  const { callState, callDuration, isMinimized, incomingCaller } = useCallStore();

  if (callState !== 'connected' || !isMinimized) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ y: -44, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -44, opacity: 0 }}
        onClick={() => useCallStore.getState().toggleMinimize()}
        className="fixed top-0 left-0 right-0 h-11 bg-[#10B981] flex items-center justify-between px-4 cursor-pointer z-[9998]"
        data-testid="minimized-call-banner"
      >
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-white animate-pulse" />
          <span className="text-sm font-medium text-white">
            {incomingCaller?.display_name || 'Active Call'}
          </span>
        </div>
        <span className="text-sm font-mono text-white/90">{formatDuration(callDuration)}</span>
      </motion.div>
    </AnimatePresence>
  );
};
