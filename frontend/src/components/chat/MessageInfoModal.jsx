import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Check, CheckCheck, Clock } from 'lucide-react';

export const MessageInfoModal = ({ info, isOpen, onClose }) => {
  if (!isOpen || !info) return null;

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
          onClick={(e) => e.stopPropagation()}
          className="relative bg-[#141414] border border-[#1F1F1F] rounded-[12px] w-full max-w-[360px] p-6"
          data-testid="message-info-modal">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-base font-semibold text-[#F5F5F5]">Message Info</h3>
            <button onClick={onClose} className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] rounded transition-colors"><X size={16} /></button>
          </div>

          <div className="space-y-4">
            <div>
              <p className="text-xs text-[#A3A3A3] mb-1">Sent</p>
              <p className="text-sm text-[#F5F5F5]">{info.sent_at ? new Date(info.sent_at).toLocaleString() : '-'}</p>
            </div>

            {info.delivered_to?.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <CheckCheck size={14} className="text-[#A3A3A3]" />
                  <p className="text-xs text-[#A3A3A3]">Delivered to</p>
                </div>
                {info.delivered_to.map((d, i) => (
                  <div key={i} className="flex items-center justify-between py-1">
                    <span className="text-sm text-[#F5F5F5]">{d.user_name}</span>
                    <span className="text-xs text-[#A3A3A3]">{d.delivered_at ? new Date(d.delivered_at).toLocaleTimeString() : ''}</span>
                  </div>
                ))}
              </div>
            )}

            {info.read_by?.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  {/* White, matching the read tick on the bubble (see
                      MessageBubble StatusIcon) so "read" reads the same
                      everywhere. Delivered above keeps the dimmer grey, which
                      mirrors the bubble's dim/bright relationship. */}
                  <CheckCheck size={14} className="text-white" />
                  <p className="text-xs text-[#A3A3A3]">Read by</p>
                </div>
                {info.read_by.map((r, i) => (
                  <div key={i} className="flex items-center justify-between py-1">
                    <span className="text-sm text-[#F5F5F5]">{r.user_name}</span>
                    <span className="text-xs text-[#A3A3A3]">{r.read_at ? new Date(r.read_at).toLocaleTimeString() : ''}</span>
                  </div>
                ))}
              </div>
            )}

            {info.pending?.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Clock size={14} className="text-[#F59E0B]" />
                  <p className="text-xs text-[#A3A3A3]">Pending</p>
                </div>
                {info.pending.map((p, i) => (
                  <div key={i} className="py-1">
                    <span className="text-sm text-[#F5F5F5]">{p.user_name}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
