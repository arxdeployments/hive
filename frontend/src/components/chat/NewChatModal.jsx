import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Users } from 'lucide-react';
import client from '../../api/client';

export const NewChatModal = ({ isOpen, onClose, onSelectContact }) => {
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/api/users/contacts', { params: { search } });
      setContacts(data);
    } catch (err) {
      console.error('Failed to fetch contacts', err);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(fetchContacts, 300);
    return () => clearTimeout(timer);
  }, [isOpen, fetchContacts]);

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
          onClick={(e) => e.stopPropagation()}
          className="relative bg-[#141414] border border-[#1F1F1F] rounded-[12px] w-full max-w-[420px] max-h-[70vh] shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)] flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#1F1F1F]">
            <h3 className="text-lg font-semibold text-[#F5F5F5]">New Conversation</h3>
            <button
              onClick={onClose}
              className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          {/* Search */}
          <div className="px-4 py-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
              <input
                type="text"
                placeholder="Search by name or email..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                data-testid="new-chat-search"
                className="w-full h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all"
              />
            </div>
          </div>

          {/* Contact list */}
          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {loading ? (
              <div className="space-y-2 px-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="flex items-center gap-3 p-2">
                    <div className="w-9 h-9 rounded-full bg-[#1A1A1A] animate-pulse" />
                    <div className="flex-1">
                      <div className="h-4 w-24 bg-[#1A1A1A] rounded animate-pulse" />
                      <div className="h-3 w-16 bg-[#1A1A1A] rounded animate-pulse mt-1" />
                    </div>
                  </div>
                ))}
              </div>
            ) : contacts.length === 0 ? (
              <div className="text-center py-12">
                <Users size={32} className="text-[#A3A3A3]/30 mx-auto mb-3" />
                <p className="text-sm text-[#A3A3A3]">No contacts available in your organization</p>
              </div>
            ) : (
              <div className="space-y-0.5">
                {contacts.map((contact) => (
                  <button
                    key={contact.id}
                    onClick={() => onSelectContact(contact.id)}
                    data-testid="contact-item"
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[6px] hover:bg-[#1A1A1A] transition-colors text-left"
                  >
                    <div className="relative">
                      <div className="w-9 h-9 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium">
                        {contact.display_name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      {contact.status === 'online' && (
                        <span className="absolute bottom-0 right-0 w-2 h-2 bg-[#10B981] rounded-full border-[1.5px] border-[#141414]" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[#F5F5F5] truncate">{contact.display_name}</p>
                      <p className="text-xs text-[#A3A3A3] truncate">{contact.department_name}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
