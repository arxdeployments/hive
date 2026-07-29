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
import { FullscreenImageViewer } from '../FullscreenImageViewer';
import { FullscreenVideoViewer } from '../FullscreenVideoViewer';
import { PdfViewer } from '../PdfViewer';
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

/**
 * Trust the server's mime_type first: `filename` is whatever the sender's file
 * was called, so an extension test alone can be wrong in both directions. The
 * extension is kept only as a fallback for rows whose message has no attachment
 * and therefore no mime_type at all.
 */
const isPdfItem = (item) =>
  item?.mime_type === 'application/pdf' || /\.pdf$/i.test(item?.filename || '');

const fetchType = async (conversationId, type) => {
  const { data } = await client.get(`/api/conversations/${conversationId}/media`, {
    params: { type, limit: 100 },
  });
  return (data?.data || []).map((item) => ({ ...item, media_kind: type }));
};

/**
 * Leading tile for a Docs row: page 1 for a PDF, the generic icon otherwise.
 *
 * The onError fallback is mandatory rather than defensive. enrich._thumb_url
 * returns a thumbnail URL optimistically for any PDF whose page_count is still
 * NULL — before page 1 has ever been rendered — and /media/{id}/thumb 404s if
 * the render then fails on an encrypted or corrupt file. A non-null
 * thumbnail_url is therefore a maybe, not a promise.
 *
 * loading="lazy" is load-bearing too: that same /thumb route rasterises, uploads
 * and commits on first hit, so eagerly fetching a screenful of legacy PDFs would
 * fire a render, an S3 put and a DB write for each one.
 */
const DocThumb = ({ item }) => {
  const [broken, setBroken] = useState(false);
  const src = resolveMediaUrl(item.thumbnail_url);
  return (
    <span className="w-10 h-10 shrink-0 rounded-[8px] overflow-hidden flex items-center justify-center bg-[#1A1A1A]">
      {src && !broken ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setBroken(true)}
          // object-top: a cropped page must show its title, not its middle.
          className="w-full h-full object-cover object-top bg-white"
          data-testid="doc-row-thumbnail"
        />
      ) : (
        <FileText size={16} className="text-[#A3A3A3]" />
      )}
    </span>
  );
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
  // { kind: 'image', index } | { kind: 'video' | 'pdf', item }
  const [viewer, setViewer] = useState(null);

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
    // An open viewer holds an index into the previous tab's list; leaving it up
    // across a tab change would page through the wrong images.
    setViewer(null);
  }, [tab, conversationId]);

  const grouped = useMemo(() => groupByMonth(items), [items]);

  // The lightbox pages across the WHOLE Media tab, not just the month bucket the
  // click came from — a photo browser that stops at a month boundary is worse
  // than no paging. Videos are excluded: they cannot render in an <img>.
  const imageItems = useMemo(() => items.filter((i) => i.media_kind === 'image'), [items]);

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

  // Jumping to the message closes the whole drawer (both hosts wrap the callback
  // as `onClose(); onJumpToMessage(id)`), so the viewer must come down with it.
  const jumpTo = useCallback(
    (messageId) => {
      setViewer(null);
      onJumpToMessage?.(messageId);
    },
    [onJumpToMessage]
  );

  /**
   * Every tile used to fall through to jump-to-message, which closed the drawer
   * and scrolled the thread — so clicking a photo, video or PDF looked like it
   * did nothing at all. Media now opens in place; jump-to-message survives as a
   * control inside each viewer rather than being deleted.
   *
   * Formats with no renderer (docx, xlsx, zip, audio) keep the old behaviour:
   * jumping to the message is a genuinely useful thing to do with a file the
   * browser cannot display, and the Docs row already carries its own download.
   */
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
    if (item.media_kind === 'image') {
      const index = imageItems.findIndex((i) => i.message_id === item.message_id);
      setViewer({ kind: 'image', index: index < 0 ? 0 : index });
      return;
    }
    if (item.media_kind === 'video') {
      setViewer({ kind: 'video', item });
      return;
    }
    if (isPdfItem(item)) {
      setViewer({ kind: 'pdf', item });
      return;
    }
    jumpTo(item.message_id);
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
                    const isVideo = item.media_kind === 'video';
                    // Videos never get a server-side poster (storage.make_thumbnail
                    // is image-only), so the old `thumbnail_url || media_url`
                    // fallback pointed an <img> at an mp4 and rendered a broken
                    // tile. Fall back to media_url for images only and let video
                    // show its Film placeholder instead.
                    const thumb = resolveMediaUrl(item.thumbnail_url || (isVideo ? null : item.media_url));
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => handleActivate(item, key)}
                        data-testid={`${testIdPrefix}-item`}
                        aria-pressed={selectMode ? checked : undefined}
                        // The tile's only content is an alt="" image and
                        // decorative icons, so without this it announces as a
                        // bare "button" — and in select mode as "button,
                        // pressed" with nothing to pin the state to.
                        aria-label={`${isVideo ? 'Video' : 'Photo'} from ${item.sender_name}, ${formatDateTime(item.created_at)}`}
                        className={`relative aspect-square rounded-[6px] overflow-hidden bg-[#141414] border transition-colors ${
                          checked ? 'border-[#10B981]' : 'border-[#1F1F1F] hover:border-[#2D2D2D]'
                        }`}
                      >
                        {thumb ? (
                          <img src={thumb} alt="" className="w-full h-full object-cover" loading="lazy" />
                        ) : (
                          <span className="w-full h-full flex items-center justify-center">
                            {isVideo ? (
                              <Film size={20} className="text-[#A3A3A3]" />
                            ) : (
                              <ImageIcon size={18} className="text-[#A3A3A3]" />
                            )}
                          </span>
                        )}
                        {isVideo && (
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
                          {isLink ? (
                            <span className="w-10 h-10 shrink-0 rounded-[8px] flex items-center justify-center bg-[#10B981]/10">
                              <Link2 size={16} className="text-[#10B981]" />
                            </span>
                          ) : (
                            <DocThumb item={item} />
                          )}
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

      {/* FullscreenImageViewer needs the same <Portal> treatment as ForwardModal
          above — it is a bare `fixed inset-0` with no portal of its own, so
          rendered in place it would be pinned to the 720px drawer and clipped by
          the content pane's overflow-y-auto. That failure looks identical to the
          bug being fixed here: the click appears to do nothing.
          PdfViewer and FullscreenVideoViewer portal themselves, so they must NOT
          be wrapped again. */}
      {viewer?.kind === 'image' && imageItems.length > 0 && (
        <Portal>
          <FullscreenImageViewer
            images={imageItems.map((i) => i.media_url)}
            thumbnails={imageItems.map((i) => i.thumbnail_url || i.media_url)}
            initialIndex={viewer.index}
            captions={imageItems.map((i) => ({ senderName: i.sender_name, timestamp: i.created_at }))}
            onJumpTo={(index) => jumpTo(imageItems[index]?.message_id)}
            onClose={() => setViewer(null)}
          />
        </Portal>
      )}

      {viewer?.kind === 'video' && (
        <FullscreenVideoViewer
          src={resolveMediaUrl(viewer.item.media_url)}
          filename={viewer.item.filename}
          senderName={viewer.item.sender_name}
          timestamp={viewer.item.created_at}
          onJumpTo={() => jumpTo(viewer.item.message_id)}
          onClose={() => setViewer(null)}
        />
      )}

      {viewer?.kind === 'pdf' && (
        <PdfViewer
          mediaUrl={viewer.item.media_url}
          filename={viewer.item.filename || 'Document'}
          pageCount={viewer.item.page_count}
          onJumpTo={() => jumpTo(viewer.item.message_id)}
          onClose={() => setViewer(null)}
        />
      )}
    </div>
  );
};
