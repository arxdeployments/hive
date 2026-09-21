import { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FileText } from 'lucide-react';
import client from '../../api/client';
import { createRequestTicket } from '../../utils/latestRequest';

export const GlobalSearchResults = ({ query, isOpen, onSelectConversation, onSelectContact, onSelectMessage, onClose }) => {
  const [results, setResults] = useState({ conversations: [], contacts: [], messages: [] });
  const [loading, setLoading] = useState(false);

  // One counter for every search this panel makes. The debounce below only cancels
  // a load that has not STARTED; once a request is open, clearing the timer does
  // nothing and the response still writes. A short prefix matches more rows and
  // answers slower, so it can land after the longer query typed after it and
  // leave results for text the search box no longer contains.
  const ticketRef = useRef(null);
  ticketRef.current ??= createRequestTicket();

  const search = useCallback(async () => {
    if (!query || query.trim().length < 1) { setResults({ conversations: [], contacts: [], messages: [] }); return; }
    const ticket = ticketRef.current.take();
    setLoading(true);
    try {
      const { data } = await client.get('/api/search', { params: { q: query, types: 'conversations,contacts,messages' } });
      if (!ticketRef.current.isCurrent(ticket)) return;
      setResults(data);
    } catch { /* ignore */ }
    finally {
      // Only the newest search owns the spinner. A stale response clearing it
      // would show a settled result list while the current query is still running.
      if (ticketRef.current.isCurrent(ticket)) setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(search, 400);
    // Bumping as well as clearing, the way ChatSidebar does: if the timer has
    // already fired, the request it started is in the air, and this keystroke —
    // or the close, or an unmount — disowns it rather than leaving a window in
    // which it could still write.
    return () => { clearTimeout(timer); ticketRef.current.invalidate(); };
  }, [query, isOpen, search]);

  if (!isOpen || !query?.trim()) return null;

  const hasResults = results.conversations.length > 0 || results.contacts.length > 0 || results.messages.length > 0;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        className="absolute top-full left-0 right-0 mt-1 bg-[#141414] border border-[#1F1F1F] rounded-[8px] shadow-lg z-30 max-h-[60vh] overflow-y-auto mx-3"
        data-testid="global-search-results"
      >
        {loading ? (
          <div className="p-4 text-center text-sm text-[#A3A3A3]">Searching...</div>
        ) : !hasResults ? (
          <div className="p-4 text-center text-sm text-[#A3A3A3]">No results for "{query}"</div>
        ) : (
          <div className="py-1">
            {results.conversations.length > 0 && (
              <div className="px-3 py-2">
                <p className="text-[10px] uppercase text-[#A3A3A3] font-medium tracking-wider mb-1">Conversations</p>
                {results.conversations.map(c => (
                  <button key={c.id} onClick={() => { onSelectConversation(c.id); onClose(); }}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-[6px] hover:bg-[#1A1A1A] text-left transition-colors">
                    <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-xs font-medium">
                      {(c.name || 'C').charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F5F5F5] truncate">{c.name}</p>
                      <p className="text-xs text-[#A3A3A3]">{c.type === 'group' ? 'Group' : 'Direct'}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {results.contacts.length > 0 && (
              <div className="px-3 py-2 border-t border-[#1F1F1F]">
                <p className="text-[10px] uppercase text-[#A3A3A3] font-medium tracking-wider mb-1">Contacts</p>
                {results.contacts.map(c => (
                  <button key={c.id} onClick={() => { onSelectContact(c.id); onClose(); }}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-[6px] hover:bg-[#1A1A1A] text-left transition-colors">
                    <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-xs font-medium">
                      {(c.display_name || 'U').charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F5F5F5] truncate">{c.display_name}</p>
                      <p className="text-xs text-[#A3A3A3]">{c.department}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {results.messages.length > 0 && (
              <div className="px-3 py-2 border-t border-[#1F1F1F]">
                <p className="text-[10px] uppercase text-[#A3A3A3] font-medium tracking-wider mb-1">Messages</p>
                {results.messages.map(m => (
                  <button key={m.message_id} onClick={() => { onSelectMessage(m.conversation_id, m.message_id); onClose(); }}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-[6px] hover:bg-[#1A1A1A] text-left transition-colors">
                    <div className="w-8 h-8 rounded-full bg-[#1A1A1A] flex items-center justify-center text-[#A3A3A3]">
                      <FileText size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-[#F5F5F5] truncate">
                        <span className="font-medium">{m.sender_name}:</span> {m.content_snippet}
                      </p>
                      <p className="text-xs text-[#A3A3A3]">
                        in {m.conversation_name} \u00b7 {new Date(m.created_at).toLocaleDateString()}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
};
