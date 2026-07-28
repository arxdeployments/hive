import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Download, Loader2, X } from 'lucide-react';

/**
 * Full-screen, scrollable, multi-page PDF reader.
 *
 * Pages are IMAGES rendered by the backend (GET /api/media/{id}/page/{n}), not a
 * client-side PDF engine. Three reasons that shape is forced rather than chosen:
 *
 *  - A native <object>/<iframe> viewer cannot work here: app/main.py stamps
 *    X-Frame-Options: DENY on every response including the 307 to /s3, and iOS
 *    Safari renders only page 1 of an embedded PDF with no scrolling.
 *  - pdf.js needs WebAssembly for its JPEG2000 path, and the CSP is
 *    `script-src 'self'` with no 'wasm-unsafe-eval'. Scanned clinical documents
 *    are exactly the case that would fail.
 *  - The backend already rasterises page 1 for the bubble thumbnail, so the
 *    renderer is paid for; per-page images add no dependency and no CSP change.
 *
 * The honest cost: rendered pages carry NO selectable text, so there is no
 * copy/paste and no in-PDF search. Download gives the real file.
 *
 * Pages lazy-load. The backend renders in windows of 10 and caches each page
 * back to object storage, so scrolling a long document does not re-render it.
 *
 * Portalled to document.body: a reader stays open far longer than an image
 * lightbox, and this is mounted inside a react-virtuoso row that would otherwise
 * recycle out from under it mid-read.
 */

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
const resolveUrl = (url) => (!url ? '' : url.startsWith('http') ? url : `${backendUrl}${url}`);

// Mirrors storage.PDF_MAX_PAGES. page_count is parser output over untrusted
// input, so it is clamped here too — the count must never become the attack.
const MAX_PAGES = 2000;

const PdfPage = ({ src, pageNo, onVisible }) => {
  const ref = useRef(null);
  const [state, setState] = useState('loading');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) onVisible(pageNo); },
      { threshold: 0.5 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [pageNo, onVisible]);

  return (
    <div ref={ref} className="relative w-full flex justify-center" data-testid="pdf-page">
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin text-[#A3A3A3]" />
        </div>
      )}
      {state === 'error' ? (
        <div className="w-full max-w-3xl aspect-[1/1.414] bg-[#141414] border border-[#2D2D2D] rounded flex items-center justify-center">
          <p className="text-xs text-[#A3A3A3]">Page {pageNo} could not be rendered</p>
        </div>
      ) : (
        <img
          src={src}
          alt={`Page ${pageNo}`}
          loading="lazy"
          onLoad={() => setState('ok')}
          onError={() => setState('error')}
          className="w-full max-w-3xl h-auto bg-white rounded shadow-lg"
        />
      )}
    </div>
  );
};

export const PdfViewer = ({ mediaUrl, filename, pageCount, onClose }) => {
  const [current, setCurrent] = useState(1);

  const total = Math.min(Math.max(Number(pageCount) || 0, 0), MAX_PAGES);
  const base = resolveUrl(mediaUrl);

  const pages = useMemo(
    () => Array.from({ length: total }, (_, i) => i + 1),
    [total]
  );

  // Capture-phase so Escape closes the reader before anything underneath sees
  // it. Deliberately not the focus-trap trick the image viewer uses, which stops
  // working the moment focus moves inside the scroll area.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // The page images are same-origin and cookie-authenticated, so a plain anchor
  // to the file works for download — the API serves documents with an attachment
  // disposition.
  const body = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[1000] bg-black/95 flex flex-col"
      data-testid="pdf-viewer"
    >
      <div className="flex items-center gap-3 px-4 py-3 bg-gradient-to-b from-black/80 to-transparent flex-shrink-0">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-[#F5F5F5] truncate">{filename}</span>
          <span className="block text-xs text-[#A3A3A3]">
            {total > 0 ? `Page ${Math.min(current, total)} of ${total}` : 'PDF'}
          </span>
        </span>
        <a
          href={base}
          download={filename}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Download PDF"
          title="Download"
          data-testid="pdf-download"
          className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors"
        >
          <Download size={20} />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close PDF"
          data-testid="pdf-viewer-close"
          className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto scrollable-area px-4 pb-8">
        {total === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-6">
            <p className="text-sm text-[#F5F5F5]">No preview available for this PDF</p>
            <p className="text-xs text-[#A3A3A3] max-w-sm">
              It was sent before previews existed, or the file could not be read.
              Use Download to open it.
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-2">
            {pages.map((n) => (
              <PdfPage
                key={n}
                pageNo={n}
                src={`${base}/page/${n}`}
                onVisible={setCurrent}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );

  return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
};

export default PdfViewer;
