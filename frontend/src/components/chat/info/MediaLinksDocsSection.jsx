/**
 * "Media, links and docs" — three tabs over GET /api/conversations/{id}/media.
 *
 *   Media -> ?type=image  + ?type=video   (merged, newest first)
 *   Links -> ?type=link                   (URLs extracted from message text server-side)
 *   Docs  -> ?type=file
 *
 * Mirrors WhatsApp's Select mode: checkboxes plus a Forward / Star / Delete
 * action bar. Forward reuses the app's ForwardModal (it accepts a `messages`
 * array for multi-select); Delete is delete-for-me only, never for everyone —
 * a bulk destructive wipe of other people's copies is not something a media
 * browser should be able to do by accident.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  Circle,
  Download,
  FileText,
  Film,
  Forward,
  ImageIcon,
  Link2,
  Loader2,
  Star,
} from 'lucide-react';
import { toast } from 'sonner';
import client from '../../../api/client';
import { ForwardModal } from '../ForwardModal';
import {
  EmptyState,
  LoadingState,
  Portal,
  formatBytes,
  formatDateTime,
  groupByMonth,
  resolveMediaUrl,
  safeHref,
} from './InfoPanelPrimitives';

const TABS = [
  { id: 'media', label: 'Media' },
  { id: 'links', label: 'Links' },
  { id: 'docs', label: 'Docs' },
];

const EMPTY_COPY = {
  media: { icon: ImageIcon, title: 'No media yet', hint: 'Photos and videos shared in this chat will appear here.' },
  links: { icon: Link2, title: 'No links yet', hint: 'Links shared in messages will be collected here.' },
  docs: { icon: FileText, title: 'No documents yet', hint: 'Files shared in this chat will appear here.' },
};

const fetchType = async (conversationId, type) => {
  const { data } = await client.get(`/api/conversations/${conversationId}/media`, {
    params: { type, limit: 100 },
  });
  return (data?.data || []).map((item) => ({ ...item, media_kind: type }));
};

export const MediaLinksDocsSection = ({ conversationId, onJumpToMessage, testIdPrefix = 'info-media' }) => {
  const [tab, setTab] = useState('media');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [forwardTargets, setForwardTargets] = useState(null);
  const [working, setWorking] = useState(false);

  const load = useCallback(async () => {
    if (!conversationId) return;
    setLoading(true);
    setError(false);
    try {
      let next;
      if (tab === 'media') {
        // Media is images + videos. Fetch both and interleave by recency so the
        // grid reads as one timeline rather than two stacked lists.
        const [images, videos] = await Promise.all([
          fetchType(conversationId, 'image'),
          fetchType(conversationId, 'video').catch(() => []),
        ]);
        next = [...images, ...videos].sort((a, b) =>
          String(b.created_at || '').localeCompare(String(a.created_at || ''))
        );
      } else if (tab === 'links') {
        next = await fetchType(conversationId, 'link');
      } else {
        next = await fetchType(conversationId, 'file');
      }
      setItems(next);
    } catch {
      setItems([]);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId, tab]);

  useEffect(() => {
    load();
  }, [load]);

  // Selection is per-tab: switching tabs drops it rather than silently carrying
  // ids the new list doesn't contain into a Forward/Delete.
  useEffect(() => {
    setSelected([]);
    setSelectMode(false);
  }, [tab, conversationId]);

  const grouped = useMemo(() => groupByMonth(items), [items]);

  // Links are keyed by url too: one message can hold several distinct links, so
  // message_id alone would collapse them into a single selectable row.
  const keyOf = useCallback(
    (item, index) => (tab === 'links' ? `${item.message_id}::${item.url}::${index}` : item.message_id),
    [tab]
  );

  const toggleSelect = (key) =>
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const selectedMessageIds = useMemo(
    () => Array.from(new Set(selected.map((key) => key.split('::')[0]))),
    [selected]
  );

  const exitSelect = () => {
    setSelectMode(false);
    setSelected([]);
  };

  const handleActivate = (item, key) => {
    if (selectMode) {
      toggleSelect(key);
      return;
    }
    if (tab === 'links') {
      const href = safeHref(item.url);
      if (href) window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    onJumpToMessage?.(item.message_id);
  };

  const handleStar = async () => {
    if (selectedMessageIds.length === 0) return;
    setWorking(true);
    let ok = 0;
    for (const id of selectedMessageIds) {
      try {
        await client.post(`/api/conversations/messages/${id}/star`);
        ok += 1;
      } catch {
        /* reported in aggregate below */
      }
    }
    setWorking(false);
    if (ok > 0) toast.success(`Star toggled on ${ok} ${ok === 1 ? 'message' : 'messages'}`);
    if (ok < selectedMessageIds.length) toast.error('Some messages could not be starred');
    exitSelect();
  };

  // handleDelete removed with the message-deletion feature. It called
  // DELETE /api/conversations/messages/{id}, which no longer exists, so every
  // item would have failed with 405 and reported "Some items could not be
  // deleted". Star and Forward remain as the panel's bulk actions.

  const empty = EMPTY_COPY[tab];

  return (
    <div className="pb-6">
      {/* Tabs */}
      <div className="sticky top-0 z-10 bg-[#0A0A0A] border-b border-[#1F1F1F] px-4 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-1" role="tablist" aria-label="Media, links and docs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                data-testid={`${testIdPrefix}-tab-${t.id}`}
                className={`px-3 py-2 text-sm rounded-t-[6px] border-b-2 transition-colors ${
                  tab === t.id
                    ? 'border-[#10B981] text-[#10B981]'
                    : 'border-transparent text-[#A3A3A3] hover:text-[#F5F5F5]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => (selectMode ? exitSelect() : setSelectMode(true))}
              data-testid={`${testIdPrefix}-select-toggle`}
              className="text-xs text-[#10B981] hover:text-[#059669] transition-colors pb-2"
            >
              {selectMode ? 'Cancel' : 'Select'}
            </button>
          )}
        </div>
      </div>

      {/* Select action bar */}
      {selectMode && (
        <div className="sticky top-[57px] z-10 flex items-center justify-between gap-3 px-4 py-2.5 bg-[#141414] border-b border-[#1F1F1F]">
          <span className="text-xs text-[#A3A3A3]" data-testid={`${testIdPrefix}-selected-count`}>
            {selected.length} selected
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={selected.length === 0 || working}
              onClick={() => setForwardTargets(selectedMessageIds.map((id) => ({ _id: id })))}
              data-testid={`${testIdPrefix}-forward`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#F5F5F5] rounded-[6px] hover:bg-[#1A1A1A] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Forward size={14} /> Forward
            </button>
            <button
              type="button"
              disabled={selected.length === 0 || working}
              onClick={handleStar}
              data-testid={`${testIdPrefix}-star`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[#F5F5F5] rounded-[6px] hover:bg-[#1A1A1A] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working ? <Loader2 size={14} className="animate-spin" /> : <Star size={14} />} Star
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <LoadingState label="Loading…" />
      ) : error ? (
        <div className="flex flex-col items-center py-16 gap-3">
          <p className="text-sm text-[#A3A3A3]">Couldn&apos;t load this list.</p>
          <button
            type="button"
            onClick={load}
            className="px-3 py-1.5 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors"
          >
            Try again
          </button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={empty.icon} title={empty.title} hint={empty.hint} />
      ) : (
        <div className="px-4 pt-4 space-y-6">
          {grouped.map((bucket) => (
            <section key={bucket.label}>
              <h5 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#A3A3A3] mb-2">
                {bucket.label}
              </h5>

              {tab === 'media' ? (
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1">
                  {bucket.items.map((item) => {
                    const key = keyOf(item, 0);
                    const checked = selected.includes(key);
                    const thumb = resolveMediaUrl(item.thumbnail_url || item.media_url);
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => handleActivate(item, key)}
                        data-testid={`${testIdPrefix}-item`}
                        aria-pressed={selectMode ? checked : undefined}
                        className={`relative aspect-square rounded-[6px] overflow-hidden bg-[#141414] border transition-colors ${
                          checked ? 'border-[#10B981]' : 'border-[#1F1F1F] hover:border-[#2D2D2D]'
                        }`}
                      >
                        {thumb ? (
                          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <span className="w-full h-full flex items-center justify-center">
                            <ImageIcon size={18} className="text-[#A3A3A3]" />
                          </span>
                        )}
                        {item.media_kind === 'video' && (
                          <span className="absolute bottom-1 left-1 p-0.5 rounded bg-black/60">
                            <Film size={12} className="text-white" />
                          </span>
                        )}
                        {selectMode && (
                          <span className="absolute top-1 right-1">
                            {checked ? (
                              <CheckCircle2 size={18} className="text-[#10B981] fill-[#0A0A0A]" />
                            ) : (
                              <Circle size={18} className="text-white/80" />
                            )}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-1">
                  {bucket.items.map((item, index) => {
                    const key = keyOf(item, index);
                    const checked = selected.includes(key);
                    const isLink = tab === 'links';
                    const href = isLink ? safeHref(item.url) : resolveMediaUrl(item.media_url);
                    return (
                      <div
                        key={key}
                        className={`flex items-center gap-3 p-2.5 rounded-[8px] border transition-colors ${
                          checked ? 'border-[#10B981] bg-[#10B981]/5' : 'border-[#1F1F1F] bg-[#141414]'
                        }`}
                      >
                        {selectMode && (
                          <button
                            type="button"
                            onClick={() => toggleSelect(key)}
                            aria-label={checked ? 'Deselect' : 'Select'}
                            className="shrink-0"
                          >
                            {checked ? (
                              <CheckCircle2 size={18} className="text-[#10B981]" />
                            ) : (
                              <Circle size={18} className="text-[#A3A3A3]" />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleActivate(item, key)}
                          data-testid={`${testIdPrefix}-item`}
                          className="flex-1 min-w-0 flex items-center gap-3 text-left"
                        >
                          <span
                            className={`w-10 h-10 shrink-0 rounded-[8px] flex items-center justify-center ${
                              isLink ? 'bg-[#10B981]/10' : 'bg-[#1A1A1A]'
                            }`}
                          >
                            {isLink ? (
                              <Link2 size={16} className="text-[#10B981]" />
                            ) : (
                              <FileText size={16} className="text-[#A3A3A3]" />
                            )}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm text-[#F5F5F5] truncate">
                              {isLink ? item.title || item.domain : item.filename || 'Document'}
                            </span>
                            <span className="block text-xs text-[#A3A3A3] truncate">
                              {isLink ? item.domain : formatBytes(item.file_size)}
                              {' · '}
                              {item.sender_name}
                              {' · '}
                              {formatDateTime(item.created_at)}
                            </span>
                          </span>
                        </button>
                        {!selectMode && href && !isLink && (
                          <a
                            href={href}
                            download={item.filename || undefined}
                            rel="noopener noreferrer"
                            aria-label={`Download ${item.filename || 'document'}`}
                            className="shrink-0 p-2 text-[#A3A3A3] hover:text-[#10B981] rounded-[6px] hover:bg-[#1A1A1A] transition-colors"
                          >
                            <Download size={16} />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ))}
        </div>
      )}

      {/* Portalled: this subtree lives inside the transformed drawer, which would
          otherwise become the containing block for the modal's fixed overlay. */}
      {forwardTargets && (
        <Portal>
          <ForwardModal
            messages={forwardTargets}
            isOpen
            onClose={() => {
              setForwardTargets(null);
              exitSelect();
            }}
          />
        </Portal>
      )}

    </div>
  );
};
