import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, ChevronLeft, ChevronRight, CornerUpLeft } from 'lucide-react';
import { useZoomPan } from '../../hooks/useZoomPan';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const resolveUrl = (url) => {
  if (!url) return '';
  return url.startsWith('http') ? url : `${backendUrl}${url}`;
};

/**
 * @param captions   Optional per-image `{ senderName, timestamp }`, indexed by
 *                   slide. Only the media gallery needs it: its images span many
 *                   senders and dates, whereas ImageBubble's all come from one
 *                   message and can keep passing the scalar props.
 * @param onJumpTo   Optional. When present, a "go to message" control appears.
 *                   Meaningless from a bubble (you are already at the message),
 *                   so it renders only when a caller supplies it.
 */
export const FullscreenImageViewer = ({
  images,
  thumbnails,
  initialIndex = 0,
  onClose,
  senderName,
  timestamp,
  captions,
  onJumpTo,
}) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  // resetKey: paging must not land the user on a photo that is still zoomed in.
  const zoom = useZoomPan({ resetKey: currentIndex });

  // Capture-phase on window, matching PdfViewer and FullscreenVideoViewer.
  //
  // This was a React onKeyDown on the overlay div with no stopPropagation, which
  // was fine while ImageBubble was the only caller — no drawer is open there. It
  // is not fine now that the info panel opens this viewer: InfoPanelShell keeps a
  // bubble-phase Escape listener on `document` for as long as the drawer is open,
  // React 19 attaches its delegated listeners to the portal container, and the
  // native event kept travelling overlay -> body -> document. Both handlers ran,
  // so Escape closed the lightbox AND tore down the whole drawer — while Escape
  // on a video or PDF tile in the same grid correctly closed only the overlay.
  //
  // Arrows are swallowed too: an unhandled ArrowDown would scroll the message
  // list underneath the overlay.
  useEffect(() => {
    const count = Array.isArray(images) ? images.length : 0;
    if (!count) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        e.stopPropagation();
        e.preventDefault();
        setCurrentIndex((i) => Math.max(0, i - 1));
      } else if (e.key === 'ArrowRight') {
        e.stopPropagation();
        e.preventDefault();
        setCurrentIndex((i) => Math.min(count - 1, i + 1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [images, onClose]);

  if (!images || images.length === 0) return null;

  const currentImage = images[currentIndex];
  const imageUrl = resolveUrl(currentImage);
  // Prefer explicit thumbnail sources for the strip; fall back to full images.
  const thumbList = Array.isArray(thumbnails) && thumbnails.length === images.length ? thumbnails : images;
  const caption = Array.isArray(captions) ? captions[currentIndex] : null;
  const shownSender = caption?.senderName ?? senderName;
  const shownTimestamp = caption?.timestamp ?? timestamp;

  const handlePrev = (e) => { e.stopPropagation(); setCurrentIndex(i => Math.max(0, i - 1)); };
  const handleNext = (e) => { e.stopPropagation(); setCurrentIndex(i => Math.min(images.length - 1, i + 1)); };

  const handleDownload = async (e) => {
    e.stopPropagation();
    const filename = ((currentImage || '').split('?')[0].split('/').pop()) || 'image';
    try {
      // Cookie-based auth — credentials ride along, no Authorization header,
      // no localStorage token. The relative /api/media/* path is same-origin.
      const response = await fetch(imageUrl, { credentials: 'include' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: let the browser fetch the media URL directly. The API sets an
      // attachment disposition and cookies flow automatically.
      const a = document.createElement('a');
      a.href = imageUrl;
      a.download = filename;
      a.target = '_blank';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[1000] bg-black/95 flex flex-col"
        onClick={onClose}
        // Keys are handled on window (see above); the focus move is kept purely
        // so the overlay, not the page behind it, owns the focus ring.
        tabIndex={0}
        ref={el => el?.focus()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent z-10">
          <div className="text-sm">
            <span className="text-[#F5F5F5] font-medium">{shownSender || ''}</span>
            {shownTimestamp && (
              <span className="text-[#A3A3A3] ml-2">{new Date(shownTimestamp).toLocaleString()}</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {onJumpTo && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onJumpTo(currentIndex); }}
                aria-label="Go to message"
                title="Go to message"
                className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors"
                data-testid="image-jump-to-message"
              >
                <CornerUpLeft size={20} />
              </button>
            )}
            <button onClick={handleDownload} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors" data-testid="image-download">
              <Download size={20} />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors" data-testid="image-viewer-close">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Image.

            touch-action: none is required, not optional: without it the
            browser's own page pinch claims the gesture before any pointer event
            is delivered, and the two-finger zoom below never fires. overflow
            hidden keeps a panned image inside the viewer rather than spilling
            over the header. */}
        <div
          ref={zoom.containerRef}
          className="flex-1 flex items-center justify-center px-16 py-4 overflow-hidden touch-none select-none"
          style={{ cursor: zoom.isZoomed ? 'grab' : 'default' }}
          onClick={(e) => e.stopPropagation()}
          {...zoom.handlers}
        >
          <motion.img
            key={currentIndex}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.2 }}
            src={imageUrl}
            alt=""
            draggable={false}
            data-testid="viewer-image"
            data-zoom={zoom.scale.toFixed(2)}
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg"
            style={{
              transform: `translate(${zoom.offset.x}px, ${zoom.offset.y}px) scale(${zoom.scale})`,
              // No transition while zooming: a CSS transition on a wheel or
              // pinch stream lags a frame behind the fingers and reads as jank.
              transformOrigin: 'center center',
              willChange: 'transform',
            }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        {zoom.isZoomed && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); zoom.reset(); }}
            data-testid="image-zoom-reset"
            className="absolute bottom-24 left-1/2 -translate-x-1/2 z-20 px-3 py-1.5 rounded-full bg-black/60 text-xs text-white hover:bg-black/80 transition-colors"
          >
            {Math.round(zoom.scale * 100)}% · reset
          </button>
        )}

        {/* Navigation arrows */}
        {images.length > 1 && (
          <>
            {/* Green glyph on the existing black pill. The pill is what carries
                the contrast — #10B981 directly on a photo is not reliably
                legible — so hover brightens the pill and leaves the glyph green
                rather than the usual #10B981 -> #059669 fill transition, which
                would make an icon-only control recede on hover. */}
            {currentIndex > 0 && (
              <button
                type="button"
                onClick={handlePrev}
                aria-label="Previous image"
                data-testid="image-viewer-prev"
                className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/80 rounded-full text-[#10B981] transition-colors"
              >
                <ChevronLeft size={24} />
              </button>
            )}
            {currentIndex < images.length - 1 && (
              <button
                type="button"
                onClick={handleNext}
                aria-label="Next image"
                data-testid="image-viewer-next"
                className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/80 rounded-full text-[#10B981] transition-colors"
              >
                <ChevronRight size={24} />
              </button>
            )}
            {/* Thumbnails.
                shrink-0 + overflow-x-auto rather than a plain centred row: this
                used to be fed one message's attachments (a handful), but the
                media gallery hands it up to 100. Without shrink-0 the w-14 tiles
                divide the width between them and collapse to ~13px slivers that
                are neither recognisable nor tappable. justify-center stays only
                while the strip actually fits — combined with overflow it would
                otherwise push the first tiles out of reach on the left. */}
            <div
              className={`flex items-center gap-2 pb-4 px-4 overflow-x-auto scrollable-area ${
                images.length > 8 ? 'justify-start' : 'justify-center'
              }`}
            >
              {images.map((img, idx) => (
                <button key={idx} type="button" onClick={(e) => { e.stopPropagation(); setCurrentIndex(idx); }}
                  aria-label={`Show image ${idx + 1} of ${images.length}`}
                  className={`w-14 h-14 shrink-0 rounded-lg overflow-hidden border-2 transition-colors ${idx === currentIndex ? 'border-[#10B981]' : 'border-transparent opacity-60 hover:opacity-100'}`}>
                  <img src={resolveUrl(thumbList[idx])} alt="" loading="lazy" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
};
