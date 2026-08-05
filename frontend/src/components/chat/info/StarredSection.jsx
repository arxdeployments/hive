/**
 * Starred messages for one conversation — GET /api/conversations/{id}/starred.
 * Clicking a row jumps to the message in the thread; the star button un-stars
 * it via the same POST toggle the message context menu uses.
 *
 * Rows that carry a file also show a preview tile. Nothing had to be added
 * server-side for that: /starred is serialized by the same enrich.serialize_message
 * the main message list uses, so every row already arrived with attachments[]
 * (thumbnail_url, mime_type, page_count, file_size, duration) plus the mirrored
 * top-level fields. This component simply used to throw all of it away and
 * render "Document · report.pdf".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AudioLines, File as FileIcon, Film, Star } from 'lucide-react';
import { toast } from 'sonner';
import client from '../../../api/client';
import { FILE_ICONS } from '../DocumentBubble';
import { FullscreenImageViewer } from '../FullscreenImageViewer';
import { FullscreenVideoViewer } from '../FullscreenVideoViewer';
import { PdfViewer } from '../PdfViewer';
import {
  Avatar,
  EmptyState,
  LoadingState,
  Portal,
  formatBytes,
  formatDateTime,
  resolveMediaUrl,
} from './InfoPanelPrimitives';

const TYPE_LABELS = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice message',
  file: 'Document',
};

const formatDuration = (seconds) => {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return '';
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * A deleted message carries no attachments at all (enrich.py drops them), so
 * every reader has to tolerate the array being absent rather than assuming a
 * non-text type implies a file.
 */
const attachmentOf = (msg) =>
  (Array.isArray(msg.attachments) && msg.attachments.length ? msg.attachments[0] : null);

/**
 * There is no top-level mime_type on a message doc — only attachments[i].mime_type
 * — so a `msg.mime_type` read silently yields undefined. Prefer the attachment's
 * and keep the filename extension as the fallback, the way DocumentBubble does.
 */
const isPdfMessage = (msg, att) =>
  (att?.mime_type || '') === 'application/pdf' ||
  /\.pdf$/i.test(msg.filename || att?.filename || '');

const kindOf = (msg, att) => {
  if (msg.is_deleted) return null;
  if (msg.type === 'image') return 'image';
  if (msg.type === 'video') return 'video';
  if (msg.type === 'audio') return 'audio';
  if (msg.type === 'file') return isPdfMessage(msg, att) ? 'pdf' : 'doc';
  return null;
};

const snippetOf = (msg) => {
  if (msg.is_deleted) return 'This message was deleted';
  const text = (msg.content || '').trim();
  if (text) return text;
  const label = TYPE_LABELS[msg.type];
  if (!label) return 'Message';
  const att = attachmentOf(msg);
  // The payload always carried these; the row just never showed them.
  const pages = msg.page_count ?? att?.page_count;
  const detail = [
    msg.filename || att?.filename,
    pages ? `${pages} page${pages === 1 ? '' : 's'}` : null,
    formatDuration(msg.duration ?? att?.duration),
    formatBytes(msg.file_size ?? att?.file_size),
  ].filter(Boolean);
  return detail.length ? `${label} · ${detail.join(' · ')}` : label;
};

/**
 * The 44px preview tile. Openable kinds render a button; audio and non-PDF
 * documents render an inert span, because there is nothing to open them with —
 * their row still jumps to the message, which is the useful thing to do with a
 * file the browser cannot display.
 *
 * A sibling of the row's own <button>, never nested inside it: DocumentBubble
 * documents that trap, and a button inside a button is invalid markup that the
 * outer control swallows.
 */
const StarredThumb = ({ msg, onOpen }) => {
  const [broken, setBroken] = useState(false);
  const att = attachmentOf(msg);
  const kind = kindOf(msg, att);
  if (!kind) return null;

  // Images fall back to the full-size file: make_thumbnail covers images and
  // PDFs only, and a small image may never have been given a separate thumb.
  // Video has no server-side poster at all, so it goes straight to its icon.
  const rawThumb = msg.thumbnail_url ?? att?.thumbnail_url;
  const src = resolveMediaUrl(kind === 'image' ? rawThumb || msg.media_url : rawThumb);

  let fallback;
  if (kind === 'video') {
    fallback = <Film size={18} className="text-[#A3A3A3]" />;
  } else if (kind === 'audio') {
    fallback = <AudioLines size={18} className="text-[#10B981]" />;
  } else {
    const ext = (msg.filename || att?.filename || '').split('.').pop()?.toLowerCase() || '';
    const meta = FILE_ICONS[ext];
    const Icon = meta?.icon || FileIcon;
    fallback = <Icon size={18} style={meta ? { color: meta.color } : undefined} className={meta ? '' : 'text-[#A3A3A3]'} />;
  }

  const inner =
    src && !broken ? (
      <img
        src={src}
        alt=""
        // Lazy because /media/{id}/thumb rasterises, uploads and commits on first
        // hit for a PDF whose page 1 has never been rendered — a screenful of
        // legacy PDFs would otherwise fire one render each on open.
        loading="lazy"
        // thumbnail_url is optimistic for PDFs with a NULL page_count, and /thumb
        // 404s when the render fails, so a non-null URL is a maybe, not a promise.
        onError={() => setBroken(true)}
        className="w-full h-full object-cover object-top bg-white"
      />
    ) : (
      fallback
    );

  const className =
    'w-11 h-11 shrink-0 rounded-[8px] overflow-hidden flex items-center justify-center bg-[#1A1A1A] border border-[#1F1F1F]';

  const openable = kind === 'image' || kind === 'video' || kind === 'pdf';
  if (!openable) {
    return <span className={className} data-testid="starred-thumb">{inner}</span>;
  }

  return (
    <button
      type="button"
      onClick={() => onOpen(kind, msg)}
      aria-label={`Open ${msg.filename || TYPE_LABELS[msg.type] || 'attachment'}`}
      data-testid="starred-thumb"
      className={`${className} hover:border-[#10B981]/50 transition-colors`}
    >
      {inner}
    </button>
  );
};

export const StarredSection = ({ conversationId, onJumpToMessage, testIdPrefix = 'info-starred' }) => {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // { kind: 'image', index } | { kind: 'video' | 'pdf', msg }
  const [viewer, setViewer] = useState(null);

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

  // The lightbox pages across every starred photo, not just the one clicked.
  const imageMessages = useMemo(
    () => messages.filter((m) => !m.is_deleted && m.type === 'image'),
    [messages]
  );

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

  const openViewer = (kind, msg) => {
    if (kind === 'image') {
      const index = imageMessages.findIndex((m) => m._id === msg._id);
      setViewer({ kind: 'image', index: index < 0 ? 0 : index });
      return;
    }
    setViewer({ kind, msg });
  };

  // Jumping closes the whole drawer, so the viewer has to come down with it.
  const jumpTo = useCallback(
    (messageId) => {
      setViewer(null);
      onJumpToMessage?.(messageId);
    },
    [onJumpToMessage]
  );

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
            onClick={() => jumpTo(msg._id)}
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
          <StarredThumb msg={msg} onOpen={openViewer} />
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

      {/* FullscreenImageViewer has no portal of its own and this subtree sits
          inside the drawer's transformed, overflow-hidden box — see Portal's own
          comment in InfoPanelPrimitives. PdfViewer and FullscreenVideoViewer
          portal themselves and must not be wrapped again. */}
      {viewer?.kind === 'image' && imageMessages.length > 0 && (
        <Portal>
          <FullscreenImageViewer
            images={imageMessages.map((m) => m.media_url)}
            thumbnails={imageMessages.map((m) => m.thumbnail_url || m.media_url)}
            initialIndex={viewer.index}
            captions={imageMessages.map((m) => ({ senderName: m.sender_name, timestamp: m.created_at }))}
            onJumpTo={(index) => jumpTo(imageMessages[index]?._id)}
            onClose={() => setViewer(null)}
          />
        </Portal>
      )}

      {viewer?.kind === 'video' && (
        <FullscreenVideoViewer
          src={resolveMediaUrl(viewer.msg.media_url)}
          filename={viewer.msg.filename}
          senderName={viewer.msg.sender_name}
          timestamp={viewer.msg.created_at}
          onJumpTo={() => jumpTo(viewer.msg._id)}
          onClose={() => setViewer(null)}
        />
      )}

      {viewer?.kind === 'pdf' && (
        <PdfViewer
          mediaUrl={viewer.msg.media_url}
          filename={viewer.msg.filename || 'Document'}
          pageCount={viewer.msg.page_count ?? attachmentOf(viewer.msg)?.page_count}
          onJumpTo={() => jumpTo(viewer.msg._id)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
};
