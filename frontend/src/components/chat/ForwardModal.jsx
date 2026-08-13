import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, Forward } from 'lucide-react';
import { toast } from 'sonner';
import client from '../../api/client';
import useChatStore from '../../stores/chatStore';
import { useModalDialog } from '../../hooks/useModalDialog';
import { apiError } from '../../utils/helpers';

/**
 * `message` forwards one message (the message context menu's path). `messages`
 * forwards a batch — the info panels' media/links/docs Select mode hands one in.
 * Either shape accepts `_id` or `message_id`, since the media list is keyed on
 * `message_id` rather than the full message doc.
 */
export const ForwardModal = ({ message, messages, isOpen, onClose }) => {
  const { conversations } = useChatStore();
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);
  const [sending, setSending] = useState(false);
  const { titleId, dialogProps } = useModalDialog({ isOpen, onClose });

  // Every render below must read off `items`, never `message` directly: the
  // media/links/docs Select flow passes only `messages`, so `message` is
  // undefined there and a bare `message.type` throws into ChatErrorBoundary,
  // blanking the whole chat pane.
  const items = useMemo(
    () => (Array.isArray(messages) && messages.length ? messages : message ? [message] : []),
    [message, messages]
  );

  const targetIds = useMemo(
    () => Array.from(new Set(items.map((m) => m?._id || m?.message_id).filter(Boolean))),
    [items]
  );

  useEffect(() => {
    if (!isOpen) { setSelected([]); setSearch(''); return; }
    client.get('/api/users/contacts').then(r => setContacts(r.data)).catch(() => {});
  }, [isOpen]);

  const toggle = (type, id) => {
    const key = `${type}:${id}`;
    setSelected(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]);
  };

  const handleForward = async () => {
    if (selected.length === 0 || targetIds.length === 0) return;
    setSending(true);
    const convIds = selected.filter(k => k.startsWith('conv:')).map(k => k.split(':')[1]);
    const contactIds = selected.filter(k => k.startsWith('contact:')).map(k => k.split(':')[1]);
    // The API forwards one message per call, so a batch is a sequential fan-out.
    // Failures are aggregated: one unforwardable item must not silently drop the rest.
    let sent = 0;
    let lastError = null;
    for (const messageId of targetIds) {
      try {
        await client.post('/api/conversations/messages/forward', {
          message_id: messageId,
          conversation_ids: convIds,
          contact_ids: contactIds
        });
        sent += 1;
      } catch (err) {
        lastError = err;
      }
    }
    setSending(false);
    if (sent > 0) {
      toast.success(`Forwarded ${sent} ${sent === 1 ? 'message' : 'messages'} to ${selected.length} recipient(s)`);
      if (sent < targetIds.length) toast.error('Some messages could not be forwarded');
      onClose();
      return;
    }
    toast.error(apiError(lastError, 'Forward failed'));
  };

  if (!isOpen || targetIds.length === 0) return null;

  // Media/links/docs items arrive as bare `{ _id }`, so type/content may be absent.
  const preview = items[0];
  const previewLabel = targetIds.length > 1
    ? `${targetIds.length} messages`
    : preview?.type === 'image' ? '📷 Photo'
    : preview?.type === 'file' ? `📄 ${preview?.content || 'File'}`
    : preview?.content || '1 message';

  const filteredConvs = conversations.filter(c =>
    !search || (c.name || '').toLowerCase().includes(search.toLowerCase()) ||
    c.participants?.some(p => p.display_name?.toLowerCase().includes(search.toLowerCase()))
  ).slice(0, 10);

  const filteredContacts = contacts.filter(c =>
    !search || c.display_name?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
          onClick={(e) => e.stopPropagation()}
          {...dialogProps}
          className="relative bg-[#141414] border border-[#1F1F1F] rounded-[12px] w-full max-w-[420px] max-h-[70vh] flex flex-col overflow-hidden outline-none">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#1F1F1F]">
            <h3 id={titleId} className="text-lg font-semibold text-[#F5F5F5]">Forward Message</h3>
            <button onClick={onClose} className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] transition-colors"><X size={18} /></button>
          </div>

          {/* Message preview */}
          <div className="px-5 py-3 border-b border-[#1F1F1F] bg-[#0F0F0F]">
            <p className="text-xs text-[#A3A3A3] mb-1">Forwarding:</p>
            <p className="text-sm text-[#F5F5F5] truncate">{previewLabel}</p>
          </div>

          {/* Search */}
          <div className="px-4 py-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
              <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)}
                className="w-full h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none transition-all" />
            </div>
          </div>

          {/* Lists */}
          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {filteredConvs.length > 0 && (
              <div className="mb-3">
                <p className="px-3 py-1 text-xs text-[#A3A3A3] uppercase">Conversations</p>
                {filteredConvs.map(c => {
                  const isSelected = selected.includes(`conv:${c._id}`);
                  const name = c.type === 'direct'
                    ? c.participants?.find(p => p.user_id !== preview?.sender_id)?.display_name || 'Chat'
                    : c.name || 'Group';
                  return (
                    <button key={c._id} onClick={() => toggle('conv', c._id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-[6px] text-left transition-colors ${isSelected ? 'bg-[#10B981]/10' : 'hover:bg-[#1A1A1A]'}`}>
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${isSelected ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'}`}>
                        {isSelected && <span className="text-white text-xs">✓</span>}
                      </div>
                      <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-xs font-medium">
                        {name.charAt(0).toUpperCase()}
                      </div>
                      <span className="text-sm text-[#F5F5F5] truncate">{name}</span>
                    </button>
                  );
                })}
              </div>
            )}
            {filteredContacts.length > 0 && (
              <div>
                <p className="px-3 py-1 text-xs text-[#A3A3A3] uppercase">Contacts</p>
                {filteredContacts.map(c => {
                  const isSelected = selected.includes(`contact:${c.id}`);
                  return (
                    <button key={c.id} onClick={() => toggle('contact', c.id)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-[6px] text-left transition-colors ${isSelected ? 'bg-[#10B981]/10' : 'hover:bg-[#1A1A1A]'}`}>
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${isSelected ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'}`}>
                        {isSelected && <span className="text-white text-xs">✓</span>}
                      </div>
                      <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-xs font-medium">
                        {c.display_name?.charAt(0)?.toUpperCase()}
                      </div>
                      <span className="text-sm text-[#F5F5F5] truncate">{c.display_name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-[#1F1F1F]">
            <button onClick={onClose} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Cancel</button>
            <button onClick={handleForward} disabled={selected.length === 0 || sending}
              className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 transition-all flex items-center gap-2">
              <Forward size={14} /> Forward ({selected.length})
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
