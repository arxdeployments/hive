import React, { useState } from 'react';
import { FullscreenImageViewer } from './FullscreenImageViewer';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const resolveUrl = (url) => {
  if (!url) return '';
  return url.startsWith('http') ? url : `${backendUrl}${url}`;
};

// Grid layouts for 1-5 images
const ImageGrid = ({ images, onImageClick }) => {
  const count = images.length;

  if (count === 1) {
    return (
      <div className="max-w-[330px] cursor-pointer" onClick={() => onImageClick(0)}>
        <img src={resolveUrl(images[0])} alt="" className="w-full rounded-[6px] object-cover max-h-[300px]" loading="lazy" />
      </div>
    );
  }

  if (count === 2) {
    return (
      <div className="max-w-[330px] grid grid-cols-2 gap-0.5 rounded-[6px] overflow-hidden">
        {images.map((img, i) => (
          <div key={i} className="cursor-pointer aspect-square" onClick={() => onImageClick(i)}>
            <img src={resolveUrl(img)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        ))}
      </div>
    );
  }

  if (count === 3) {
    return (
      <div className="max-w-[330px] rounded-[6px] overflow-hidden">
        <div className="grid grid-cols-2 gap-0.5">
          {images.slice(0, 2).map((img, i) => (
            <div key={i} className="cursor-pointer aspect-square" onClick={() => onImageClick(i)}>
              <img src={resolveUrl(img)} alt="" className="w-full h-full object-cover" loading="lazy" />
            </div>
          ))}
        </div>
        <div className="mt-0.5 cursor-pointer" onClick={() => onImageClick(2)}>
          <img src={resolveUrl(images[2])} alt="" className="w-full h-[140px] object-cover" loading="lazy" />
        </div>
      </div>
    );
  }

  if (count === 4) {
    return (
      <div className="max-w-[330px] grid grid-cols-2 gap-0.5 rounded-[6px] overflow-hidden">
        {images.map((img, i) => (
          <div key={i} className="cursor-pointer aspect-square" onClick={() => onImageClick(i)}>
            <img src={resolveUrl(img)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        ))}
      </div>
    );
  }

  // 5 images: 2 on top + 3 on bottom
  return (
    <div className="max-w-[330px] rounded-[6px] overflow-hidden">
      <div className="grid grid-cols-2 gap-0.5">
        {images.slice(0, 2).map((img, i) => (
          <div key={i} className="cursor-pointer aspect-square" onClick={() => onImageClick(i)}>
            <img src={resolveUrl(img)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-3 gap-0.5 mt-0.5">
        {images.slice(2, 5).map((img, i) => (
          <div key={i + 2} className="cursor-pointer aspect-square" onClick={() => onImageClick(i + 2)}>
            <img src={resolveUrl(img)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        ))}
      </div>
    </div>
  );
};

export const ImageBubble = ({ message, isOwn }) => {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);

  // Support single or multiple images
  const images = message.media_urls || (message.media_url ? [message.media_url] : []);
  const caption = message.caption || (message.type === 'image' && message.content && !message.content.startsWith('/api/') ? message.content : '');

  if (images.length === 0) return null;

  const handleImageClick = (index) => {
    setViewerIndex(index);
    setViewerOpen(true);
  };

  return (
    <>
      <div data-testid="image-bubble">
        <ImageGrid images={images} onImageClick={handleImageClick} />
        {caption && (
          <p className={`text-sm mt-1 ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>{caption}</p>
        )}
      </div>

      {viewerOpen && (
        <FullscreenImageViewer
          images={images}
          initialIndex={viewerIndex}
          onClose={() => setViewerOpen(false)}
          senderName={message.sender_name}
          timestamp={message.created_at}
        />
      )}
    </>
  );
};
