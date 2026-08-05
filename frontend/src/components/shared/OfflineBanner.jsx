import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Wifi, WifiOff } from 'lucide-react';

export const OfflineBanner = () => {
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const [showBackOnline, setShowBackOnline] = useState(false);

  useEffect(() => {
    const handleOffline = () => setIsOffline(true);
    const handleOnline = () => {
      setIsOffline(false);
      setShowBackOnline(true);
      setTimeout(() => setShowBackOnline(false), 2000);
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  return (
    <AnimatePresence>
      {(isOffline || showBackOnline) && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 32, opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          className={`flex items-center justify-center gap-2 text-xs font-medium ${
            isOffline
              ? 'bg-[#EF4444]/15 text-[#EF4444]'
              : 'bg-[#10B981]/15 text-[#10B981]'
          }`}
        >
          {/* The offline copy deliberately does NOT promise "will be sent when
              you reconnect": nothing queues an offline send any more. A message
              typed with the network down fails and stays on screen as a
              retryable bubble. */}
          {isOffline ? (
            <><WifiOff size={14} /> You are offline. Sending will fail until you reconnect.</>
          ) : (
            <><Wifi size={14} /> Back online</>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};
