import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Mail, Building2, FolderTree, Phone, Video } from 'lucide-react';
import client from '../../api/client';
import wsClient from '../../services/websocket';
import useCallStore from '../../stores/callStore';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

export const ContactInfoPanel = ({ conversation, currentUserId, isOpen, onClose }) => {
  const [media, setMedia] = useState([]);

  const otherParticipant = conversation?.participants?.find(p => p.user_id !== currentUserId);

  useEffect(() => {
    if (isOpen && conversation) {
      client.get(`/api/conversations/${conversation._id}/media`, { params: { type: 'image', limit: 9 } })
        .then(r => setMedia(r.data?.data || []))
        .catch(() => {});
    }
  }, [isOpen, conversation]);

  if (!isOpen || !conversation || conversation.type !== 'direct') return null;

  const formatStatus = (p) => {
    if (!p) return '';
    if (p.status === 'online') return 'online';
    if (p.last_seen) {
      const d = new Date(p.last_seen);
      return `last seen ${d.toLocaleDateString()} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
    }
    return 'offline';
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50" onClick={onClose}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-0 h-full w-full sm:w-[360px] bg-[#0F0F0F] border-l border-[#1F1F1F] shadow-2xl overflow-y-auto"
            data-testid="contact-info-panel"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F1F1F]">
              <h3 className="text-base font-semibold text-[#F5F5F5]">Contact Info</h3>
              <button onClick={onClose} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] transition-colors">
                <X size={18} />
              </button>
            </div>

            <div className="p-6 space-y-6">
              {/* Avatar + Name */}
              <div className="text-center">
                <div className="w-24 h-24 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-3xl font-bold mx-auto mb-3">
                  {otherParticipant?.avatar_url ? (
                    <img src={otherParticipant.avatar_url.startsWith('http') ? otherParticipant.avatar_url : `${backendUrl}${otherParticipant.avatar_url}`}
                      alt="" className="w-full h-full rounded-full object-cover" />
                  ) : (otherParticipant?.display_name?.charAt(0)?.toUpperCase() || '?')}
                </div>
                <h2 className="text-xl font-semibold text-[#F5F5F5]">{otherParticipant?.display_name || 'Unknown'}</h2>
                <p className={`text-sm mt-1 ${otherParticipant?.status === 'online' ? 'text-[#10B981]' : 'text-[#A3A3A3]'}`}>
                  {formatStatus(otherParticipant)}
                </p>
              </div>

              {/* Call buttons */}
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => {
                    if (otherParticipant?.user_id) {
                      wsClient.send({ type: 'call:initiate', callee_id: otherParticipant.user_id, call_type: 'voice' });
                      useCallStore.getState().initiateCall(null, 'voice');
                      onClose();
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-[#141414] border border-[#1F1F1F] rounded-[8px] text-sm text-[#F5F5F5] hover:border-[#10B981]/30 transition-colors"
                  aria-label={`Voice call ${otherParticipant?.display_name}`}
                >
                  <Phone size={16} className="text-[#10B981]" /> Voice Call
                </button>
                <button
                  onClick={() => {
                    if (otherParticipant?.user_id) {
                      wsClient.send({ type: 'call:initiate', callee_id: otherParticipant.user_id, call_type: 'video' });
                      useCallStore.getState().initiateCall(null, 'video');
                      onClose();
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-[#141414] border border-[#1F1F1F] rounded-[8px] text-sm text-[#F5F5F5] hover:border-[#10B981]/30 transition-colors"
                  aria-label={`Video call ${otherParticipant?.display_name}`}
                >
                  <Video size={16} className="text-[#10B981]" /> Video Call
                </button>
              </div>

              {/* Shared Media */}
              {media.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-[#A3A3A3] mb-3">Shared Media</h4>
                  <div className="grid grid-cols-3 gap-1 rounded-[8px] overflow-hidden">
                    {media.slice(0, 9).map((m, i) => (
                      <div key={i} className="aspect-square bg-[#1A1A1A]">
                        {m.media_url && (
                          <img src={m.media_url.startsWith('http') ? m.media_url : `${backendUrl}${m.media_url}`}
                            alt="" className="w-full h-full object-cover" />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
