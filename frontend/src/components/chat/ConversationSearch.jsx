import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import client from '../../api/client';

export const ConversationSearch = ({ conversationId, isOpen, onClose, onScrollToMessage }) => {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async () => {
    if (!query.trim() || !conversationId) { setMatches([]); return; }
    setLoading(true);
    try {
      const { data } = await client.post(
        `/api/conversations/${conversationId}/messages/search?q=${encodeURIComponent(query)}`
      );
      setMatches(data.matches || []);
      setCurrentIdx(0);
      if (data.matches?.length > 0 && onScrollToMessage) {
        onScrollToMessage(data.matches[0].message_id);
      }
    } catch (err) { setMatches([]); }
    finally { setLoading(false); }
  }, [query, conversationId, onScrollToMessage]);

  useEffect(() => {
    if (!isOpen) { setQuery(''); setMatches([]); return; }
    const timer = setTimeout(search, 400);
    return () => clearTimeout(timer);
  }, [query, isOpen, search]);

  const navigate = (dir) => {
    const newIdx = dir === 'up'
      ? (currentIdx > 0 ? currentIdx - 1 : matches.length - 1)
      : (currentIdx < matches.length - 1 ? currentIdx + 1 : 0);
    setCurrentIdx(newIdx);
    if (matches[newIdx] && onScrollToMessage) onScrollToMessage(matches[newIdx].message_id);
  };

  if (!isOpen) return null;

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 48, opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="bg-[#0F0F0F] border-b border-[#1F1F1F] flex items-center gap-2 px-4 overflow-hidden"
      data-testid="conversation-search-bar"
    >
      <Search size={16} className="text-[#A3A3A3] flex-shrink-0" />
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search messages..."
        autoFocus
        data-testid="conv-search-input"
        className="flex-1 bg-transparent text-sm text-[#F5F5F5] placeholder:text-[#525252] focus:outline-none"
      />
      {matches.length > 0 && (
        <span className="text-xs text-[#A3A3A3] flex-shrink-0">{currentIdx + 1} of {matches.length}</span>
      )}
      <div className="flex items-center gap-1 flex-shrink-0">
        <button onClick={() => navigate('up')} disabled={matches.length === 0}
          className="p-1 text-[#A3A3A3] hover:text-[#F5F5F5] disabled:opacity-30 transition-colors">
          <ChevronUp size={16} />
        </button>
        <button onClick={() => navigate('down')} disabled={matches.length === 0}
          className="p-1 text-[#A3A3A3] hover:text-[#F5F5F5] disabled:opacity-30 transition-colors">
          <ChevronDown size={16} />
        </button>
      </div>
      <button onClick={onClose} className="p-1 text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors flex-shrink-0">
        <X size={16} />
      </button>
    </motion.div>
  );
};
