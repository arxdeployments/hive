import React, { useCallback, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Download, Pencil, X } from 'lucide-react';
import { AudioPlayer } from './AudioPlayer';
import { FILE_ICONS, formatFileSize } from './DocumentBubble';
import { describeEdits } from '../../utils/mediaEdit';

/**
 * Full-size look at a file that has been SELECTED but not yet sent.
 *
 * The confirmation tray shows 60px tiles, which is enough to tell files apart but
 * not enough to actually check one — "is this the right screenshot?" needs the
 * screenshot. This renders the staged file at full size, per category, from the
 * same object URL the tray already holds, so it costs no network at all.
 *
 * Renders through the tray's own object URL rather than uploading first, which is
 * what keeps Cancel free: nothing has touched the server at this point.
 *
 * Documents deliberately do NOT render inline, including PDFs. The app's CSP is
 * `default-src 'self'` with no object-src, so object-src falls back to 'self' and
 * a blob: URL is blocked — an <object>/<iframe> PDF viewer would need
 * `object-src 'self' blob:` added to nginx.conf. That is a real CSP relaxation on
 * a plugin-class sink, and the question a pre-send preview has to answer is "is
 * this the right file?", which the name, size and type icon already answer. So
 * documents show icon + name + size, plus a Download that opens the local file in
 * whatever the OS uses. Images, video and audio DO render — img-src and media-src
 * already permit blob:.
 */
/**
 * `keysSuspended` is set while the editor is open on top of this.
 *
 * It has to be a prop rather than something this component can work out for itself.
 * Both keydown handlers sit on `window` in the capture phase, and listeners on one
 * target fire in REGISTRATION order — this component mounts first, so its handler
 * runs first and `stopPropagation` in the editor's handler comes too late to stop
 * it. One Escape would close both layers. Not installing the listener at all is the
 * only version that cannot race, and it fixes the quieter half of the same bug:
 * arrow keys were paging this preview invisibly behind the editor.
 */
export const StagedFilePreview = ({ files, index, onIndex, onClose, onEdit, keysSuspended = false }) => {
  const file = files[index];
  const many = files.length > 1;

  const prev = useCallback(() => onIndex((index - 1 + files.length) % files.length),
    [index, files.length, onIndex]);
  const next = useCallback(() => onIndex((index + 1) % files.length),
    [index, files.length, onIndex]);

  // Escape closes, arrows page — a viewer that traps the keyboard is worse than
  // no viewer.
  useEffect(() => {
    if (keysSuspended) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      else if (many && e.key === 'ArrowLeft') prev();
      else if (many && e.key === 'ArrowRight') next();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, prev, next, many, keysSuspended]);

  if (!file) return null;

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const iconMeta = FILE_ICONS[ext];
  const DocIcon = iconMeta?.icon;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] bg-black/90 backdrop-blur-sm flex flex-col"
      data-testid="staged-file-preview"
      onClick={onClose}
    >
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-white truncate">{file.name}</span>
          <span className="block text-[11px] text-white/60">
            {file.category}{file.size ? ` · ${formatFileSize(file.size)}` : ''}
            {many ? ` · ${index + 1} of ${files.length}` : ''}
            {file.edit ? ` · ${describeEdits(file.edit)}` : ''}
          </span>
        </span>
        {/* Crop, draw, add text. Offered here as well as on the tray tile because
            this is the size at which someone actually decides a photo needs
            straightening — a 60px thumbnail is not. Pictures and clips only. */}
        {onEdit && (file.category === 'image' || file.category === 'video') && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onEdit(file.id); }}
            aria-label="Edit this file"
            title="Crop, draw or add text"
            data-testid="staged-preview-edit"
            className="p-2 text-white/70 hover:text-white rounded-full hover:bg-white/10 transition-colors"
          >
            <Pencil size={18} />
          </button>
        )}
        {/* Download the LOCAL file — useful for documents you cannot render. */}
        <a
          href={file.url}
          download={file.name}
          onClick={(e) => e.stopPropagation()}
          aria-label="Download this file"
          title="Download"
          className="p-2 text-white/70 hover:text-white rounded-full hover:bg-white/10 transition-colors"
        >
          <Download size={18} />
        </a>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          data-testid="staged-preview-close"
          className="p-2 text-white/70 hover:text-white rounded-full hover:bg-white/10 transition-colors"
        >
          <X size={20} />
        </button>
      </div>

      {/* Body */}
      <div
        className="flex-1 min-h-0 flex items-center justify-center px-4 pb-4"
        onClick={(e) => e.stopPropagation()}
      >
        {file.category === 'image' && (
          <img src={file.url} alt={file.name} className="max-w-full max-h-full object-contain rounded-[8px]" />
        )}

        {file.category === 'video' && (
          // controls, not autoplay: this is a check-before-send, not playback.
          <video src={file.url} controls playsInline className="max-w-full max-h-full rounded-[8px] bg-black" />
        )}

        {file.category === 'audio' && (
          <div className="w-full max-w-md bg-[#141414] border border-[#2D2D2D] rounded-[10px] p-4">
            <AudioPlayer src={file.url} />
          </div>
        )}

        {file.category === 'document' && (
          <div className="text-center px-6">
            {DocIcon
              ? <DocIcon size={64} style={{ color: iconMeta.color }} className="mx-auto mb-4" />
              : null}
            <p className="text-sm text-white break-all max-w-sm mx-auto">{file.name}</p>
            <p className="text-xs text-white/50 mt-1">
              {[file.size ? formatFileSize(file.size) : null, ext ? ext.toUpperCase() : null]
                .filter(Boolean).join(' · ')}
            </p>
            <p className="text-[11px] text-white/40 mt-3 max-w-xs mx-auto">
              Documents are not rendered in the browser. Use Download above to open
              it before sending.
            </p>
          </div>
        )}
      </div>

      {many && (
        <>
          {/* These arrows gained a resting bg-black/50 pill along with the green
              glyph. They previously floated bare over the staged file, which was
              fine for white-at-70% but not for #10B981: a staged photo or a
              scanned document is frequently white where the arrow sits, and
              green-on-white fails contrast outright. The lightbox arrows already
              had this pill, so this also brings the two into line. */}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); prev(); }}
            aria-label="Previous file"
            data-testid="staged-preview-prev"
            className="absolute left-2 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/80 rounded-full text-[#10B981] transition-colors"
          >
            <ChevronLeft size={28} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); next(); }}
            aria-label="Next file"
            data-testid="staged-preview-next"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/80 rounded-full text-[#10B981] transition-colors"
          >
            <ChevronRight size={28} />
          </button>
        </>
      )}
    </motion.div>
  );
};

export default StagedFilePreview;
