/**
 * Starred messages for one conversation — GET /api/conversations/{id}/starred.
 * Clicking a row jumps to the message in the thread; the star button un-stars
 * it via the same POST toggle the message context menu uses.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { toast } from 'sonner';
import client from '../../../api/client';
import { Avatar, EmptyState, LoadingState, formatDateTime } from './InfoPanelPrimitives';

const TYPE_LABELS = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  file: 'Document',
};

const snippetOf = (msg) => {
  if (msg.is_deleted) return 'This message was deleted';
  const text = (msg.content || '').trim();
  if (text) return text;
  const label = TYPE_LABELS[msg.type];
  if (label) return msg.filename ? `${label} · ${msg.filename}` : label;
  return 'Message';
};

export const StarredSection = ({ conversationId, onJumpToMessage, testIdPrefix = 'info-starred' }) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(false);
    try {
      const { data } = await client.get(`/api/conversations/${conversationId}/starred`);
      setMessages(data?.data || []);
    } catch {
      setMessages([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleUnstar = async (msgId) => {
    // Optimistic: the row leaves immediately, and comes back if the toggle fails.
    const previous = messages;
    setMessages((prev) => prev.filter((m) => m._id !== msgId));
    try {
      await client.post(`/api/conversations/messages/${msgId}/star`);
    } catch {
      setMessages(previous);
      toast.error('Could not remove star');
    }
  };

  if (loading) return <LoadingState label="Loading starred messages…" />;

  if (error) {
    return (
      <div className="flex flex-col items-center py-16 gap-3">
        <p className="text-sm text-[#A3A3A3]">Couldn&apos;t load starred messages.</p>
        <button
          type="button"
          onClick={load}
          className="px-3 py-1.5 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <EmptyState
        icon={Star}
        title="No starred messages"
        hint="Star a message from its menu to keep it here for quick access."
      />
    );
  }

  return (
    <div className="p-4 space-y-1" data-testid={`${testIdPrefix}-list`}>
      {messages.map((msg) => (
        <div
          key={msg._id}
          className="flex items-start gap-3 p-3 rounded-[8px] bg-[#141414] border border-[#1F1F1F] hover:border-[#2D2D2D] transition-colors"
        >
          <Avatar name={msg.sender_name} src={msg.sender_avatar} size={32} />
          <button
            type="button"
            onClick={() => onJumpToMessage?.(msg._id)}
            data-testid={`${testIdPrefix}-item`}
            className="flex-1 min-w-0 text-left"
          >
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-medium text-[#F5F5F5] truncate">{msg.sender_name}</span>
              <span className="text-[11px] text-[#A3A3A3] shrink-0">{formatDateTime(msg.created_at)}</span>
            </span>
            <span className="block text-sm text-[#A3A3A3] mt-0.5 line-clamp-2 break-words">
              {snippetOf(msg)}
            </span>
          </button>
          <button
            type="button"
            onClick={() => handleUnstar(msg._id)}
            aria-label="Remove star"
            data-testid={`${testIdPrefix}-unstar`}
            className="shrink-0 p-1.5 text-[#FBBF24] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
          >
            <Star size={16} className="fill-[#FBBF24]" />
          </button>
        </div>
      ))}
    </div>
  );
};
