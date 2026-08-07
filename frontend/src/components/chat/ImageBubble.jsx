import { useState } from 'react';
import { FullscreenImageViewer } from './FullscreenImageViewer';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const resolveUrl = (url) => {
  if (!url) return '';
  return url.startsWith('http') ? url : `${backendUrl}${url}`;
};

// Build parallel lists of full-size + thumbnail sources from a message.
// Media URLs are now relative same-origin paths like '/api/media/<id>' and
// '/api/media/<id>/thumb' — the API 307-redirects to a presigned URL and
// cookies flow automatically, so we use the value directly (prefixed by the
// possibly-empty backendUrl so a cross-origin backend still works).
const collectImages = (message) => {
  // Prefer an explicit attachments array (image attachments only).
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const imgs = message.attachments.filter(
      (a) => !a.type || a.type === 'image' || (a.mime_type || '').startsWith('image/')
    );
    if (imgs.length > 0) {
      return imgs.map((a) => ({
        full: a.media_url || a.url || '',
        thumb: a.thumbnail_url || a.media_url || a.url || '',
      }));
    }
  }
  // Legacy multi-image array of URL strings.
  if (Array.isArray(message.media_urls) && message.media_urls.length > 0) {
    return message.media_urls.map((u) => ({ full: u, thumb: u }));
  }
  // Single image — thumbnail for the grid, full-size for the viewer.
  if (message.media_url) {
    return [{ full: message.media_url, thumb: message.thumbnail_url || message.media_url }];
  }
  return [];
};

// Grid layouts for 1-5 images. `items` is [{ full, thumb }]; the grid renders
// the thumbnail, the fullscreen viewer opens the full-size media.
/**
 * One clickable cell, shared by all five layouts below.
 *
 * Photos were the only message type with no keyboard route at all: seven bare
 * divs with onClick, so a keyboard user could not open a picture and a screen
 * reader announced nothing — the <img> carries alt="" because the thumbnail is
 * decoration for a control, which left the control itself unnamed.
 *
 * role="button" rather than a real <button>: four of these are grid items,
 * where blockification would hide the difference, but the single-image wrapper
 * and the wide third tile are plain block children, and a button's
 * shrink-to-fit inline-block box would then size the `w-full` image inside it.
 * Same trade DocumentBubble already makes.
 *
 * The ring is inset because the grid wrappers are overflow-hidden, so an outset
 * one is clipped away exactly where it is needed. alt="" stays on the images:
 * the name belongs on the control, and repeating it on the child would have a
 * screen reader announce every photo twice.
 */
const PhotoTile = ({ index, count, className, onImageClick, children }) => (
  <div
    role="button"
    tabIndex={0}
    onClick={() => onImageClick(index)}
    onKeyDown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onImageClick(index);
      }
    }}
    aria-label={count === 1 ? 'Open photo' : `Open photo ${index + 1} of ${count}`}
    className={`cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[#10B981] ${className}`}
  >
    {children}
  </div>
);

const ImageGrid = ({ items, onImageClick }) => {
  const count = items.length;

  if (count === 1) {
    return (
      <PhotoTile index={0} count={1} className="max-w-[330px]" onImageClick={onImageClick}>
        <img src={resolveUrl(items[0].thumb)} alt="" className="w-full rounded-[6px] object-cover max-h-[300px]" loading="lazy" />
      </PhotoTile>
    );
  }

  if (count === 2) {
    return (
      <div className="max-w-[330px] grid grid-cols-2 gap-0.5 rounded-[6px] overflow-hidden">
        {items.map((img, i) => (
          <PhotoTile key={i} index={i} count={count} className="aspect-square" onImageClick={onImageClick}>
            <img src={resolveUrl(img.thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </PhotoTile>
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="max-w-[330px] rounded-[6px] overflow-hidden">
        <div className="grid grid-cols-2 gap-0.5">
          {items.slice(0, 2).map((img, i) => (
            <PhotoTile key={i} index={i} count={count} className="aspect-square" onImageClick={onImageClick}>
              <img src={resolveUrl(img.thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
            </PhotoTile>
          ))}
        </div>
        <PhotoTile index={2} count={count} className="mt-0.5" onImageClick={onImageClick}>
          <img src={resolveUrl(items[2].thumb)} alt="" className="w-full h-[140px] object-cover" loading="lazy" />
        </PhotoTile>
      </div>
    );
  }

  if (count === 4) {
    return (
      <div className="max-w-[330px] grid grid-cols-2 gap-0.5 rounded-[6px] overflow-hidden">
        {items.map((img, i) => (
          <PhotoTile key={i} index={i} count={count} className="aspect-square" onImageClick={onImageClick}>
            <img src={resolveUrl(img.thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </PhotoTile>
        ))}
      </div>
    );
  }

  // 5 images: 2 on top + 3 on bottom
  return (
    <div className="max-w-[330px] rounded-[6px] overflow-hidden">
      <div className="grid grid-cols-2 gap-0.5">
        {items.slice(0, 2).map((img, i) => (
          <PhotoTile key={i} index={i} count={count} className="aspect-square" onImageClick={onImageClick}>
            <img src={resolveUrl(img.thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </PhotoTile>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-0.5 mt-0.5">
        {items.slice(2, 5).map((img, i) => (
          <PhotoTile key={i + 2} index={i + 2} count={count} className="aspect-square" onImageClick={onImageClick}>
            <img src={resolveUrl(img.thumb)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </PhotoTile>
        ))}
      </div>
    </div>
  );
};

export const ImageBubble = ({ message, isOwn, footer = null }) => {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  const items = collectImages(message);
  const caption = message.caption || (message.type === 'image' && message.content && !message.content.startsWith('/api/') ? message.content : '');

  if (items.length === 0) return null;

  const handleImageClick = (index) => {
    setViewerIndex(index);
    setViewerOpen(true);
  };

  return (
    <>
      <div data-testid="image-bubble">
        {/* relative so the footer can be absolutely positioned over the picture
            rather than adding a row of bubble colour beneath it. With a caption
            the caller passes no footer and puts it under the text instead.

            min-h is load-bearing, not cosmetic: an overlaid footer is positioned
            against THIS box, so a picture that renders with no height — a 404,
            a decode failure, a degenerate 1x1 — would let the scrim escape the
            bubble and land on top of whatever is below it in the thread. */}
        <div className="relative min-h-[34px]">
          <ImageGrid items={items} onImageClick={handleImageClick} />
          {!caption && footer}
        </div>
        {caption && (
          <p className={`text-sm mt-1 ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>{caption}</p>
        )}
      </div>

      {viewerOpen && (
        <FullscreenImageViewer
          images={items.map((i) => i.full)}
          thumbnails={items.map((i) => i.thumb)}
          initialIndex={viewerIndex}
          onClose={() => setViewerOpen(false)}
          senderName={message.sender_name}
          timestamp={message.created_at}
        />
      )}
    </>
  );
};
