import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { CornerUpLeft, Download, X } from 'lucide-react';

/**
 * Full-screen video playback.
 *
 * Net-new: before this, the only way to watch a video in the web app was the
 * inline `<video controls>` in MessageBubble. The media gallery had nothing to
 * open, which is part of why clicking a video tile appeared to do nothing.
 *
 * Deliberately single-item rather than a pager like FullscreenImageViewer.
 * Paging images is a glance; paging videos would tear down and re-establish a
 * media element mid-playback, and nobody flicks through videos the way they
 * flick through photos.
 *
 * Self-portalled to document.body. Its only caller today lives inside the info
 * drawer, which animates `x` and therefore becomes the containing block for any
 * `position: fixed` descendant — an overlay rendered in place would be pinned to
 * the 720px drawer and clipped by its `overflow-y-auto` pane. Portalling here
 * rather than at the call site means that trap cannot be reintroduced by a
 * future caller who does not know about it.
 */
export const FullscreenVideoViewer = ({ src, filename, senderName, timestamp, onClose, onJumpTo }) => {
  const videoRef = useRef(null);

  // Capture-phase, matching PdfViewer: Escape must close this before anything
  // underneath (the drawer, the chat panel) also acts on it.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Pause on unmount. Without this a closed viewer can keep audio playing until
  // the element is garbage collected.
  useEffect(() => () => { videoRef.current?.pause(); }, []);

  if (!src) return null;

  const body = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[1000] bg-black/95 flex flex-col"
      data-testid="video-viewer"
      onClick={onClose}
    >
      <div
        className="flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-[#F5F5F5] truncate">{filename || 'Video'}</span>
          <span className="block text-xs text-[#A3A3A3] truncate">
            {[senderName, timestamp ? new Date(timestamp).toLocaleString() : null]
              .filter(Boolean).join(' · ')}
          </span>
        </span>
        {onJumpTo && (
          <button
            type="button"
            onClick={onJumpTo}
            aria-label="Go to message"
            title="Go to message"
            data-testid="video-jump-to-message"
            className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors"
          >
            <CornerUpLeft size={20} />
          </button>
        )}
        {/* Same-origin and cookie-authenticated, and the API serves media with an
            attachment disposition, so a plain anchor is enough here — no need for
            the blob dance FullscreenImageViewer does for its own download. */}
        <a
          href={src}
          download={filename || undefined}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Download video"
          title="Download"
          data-testid="video-download"
          className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors"
        >
          <Download size={20} />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close video"
          data-testid="video-viewer-close"
          className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      <div
        className="flex-1 min-h-0 flex items-center justify-center px-4 pb-6"
        onClick={(e) => e.stopPropagation()}
      >
        <video
          ref={videoRef}
          src={src}
          controls
          autoPlay
          playsInline
          className="max-w-full max-h-full rounded-[8px] bg-black"
          data-testid="video-viewer-element"
        />
      </div>
    </motion.div>
  );

  return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
};

export default FullscreenVideoViewer;
