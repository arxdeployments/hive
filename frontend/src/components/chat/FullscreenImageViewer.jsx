import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Download, ChevronLeft, ChevronRight } from 'lucide-react';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

export const FullscreenImageViewer = ({ images, initialIndex = 0, onClose, senderName, timestamp }) => {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);

  if (!images || images.length === 0) return null;

  const currentImage = images[currentIndex];
  const imageUrl = currentImage?.startsWith('http') ? currentImage : `${backendUrl}${currentImage}`;

  const handlePrev = (e) => { e.stopPropagation(); setCurrentIndex(i => Math.max(0, i - 1)); };
  const handleNext = (e) => { e.stopPropagation(); setCurrentIndex(i => Math.min(images.length - 1, i + 1)); };

  const handleDownload = async (e) => {
    e.stopPropagation();
    try {
      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = currentImage.split('/').pop() || 'image';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { console.error('Download failed:', err); }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowLeft') setCurrentIndex(i => Math.max(0, i - 1));
    if (e.key === 'ArrowRight') setCurrentIndex(i => Math.min(images.length - 1, i + 1));
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[1000] bg-black/95 flex flex-col"
        onClick={onClose}
        onKeyDown={handleKeyDown}
        tabIndex={0}
        ref={el => el?.focus()}
      >
        {/* Top bar */}
        <div className="flex items-center justify-between px-4 py-3 bg-gradient-to-b from-black/80 to-transparent z-10">
          <div className="text-sm">
            <span className="text-[#F5F5F5] font-medium">{senderName || ''}</span>
            {timestamp && <span className="text-[#A3A3A3] ml-2">{new Date(timestamp).toLocaleString()}</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleDownload} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors" data-testid="image-download">
              <Download size={20} />
            </button>
            <button onClick={(e) => { e.stopPropagation(); onClose(); }} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-white/10 rounded-[6px] transition-colors" data-testid="image-viewer-close">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Image */}
        <div className="flex-1 flex items-center justify-center px-16 py-4" onClick={(e) => e.stopPropagation()}>
          <motion.img
            key={currentIndex}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
            src={imageUrl}
            alt=""
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>

        {/* Navigation arrows */}
        {images.length > 1 && (
          <>
            {currentIndex > 0 && (
              <button onClick={handlePrev} className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/80 rounded-full text-white transition-colors">
                <ChevronLeft size={24} />
              </button>
            )}
            {currentIndex < images.length - 1 && (
              <button onClick={handleNext} className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/80 rounded-full text-white transition-colors">
                <ChevronRight size={24} />
              </button>
            )}
            {/* Thumbnails */}
            <div className="flex items-center justify-center gap-2 pb-4">
              {images.map((img, idx) => {
                const thumbUrl = img?.startsWith('http') ? img : `${backendUrl}${img}`;
                return (
                  <button key={idx} onClick={(e) => { e.stopPropagation(); setCurrentIndex(idx); }}
                    className={`w-14 h-14 rounded-lg overflow-hidden border-2 transition-colors ${idx === currentIndex ? 'border-[#10B981]' : 'border-transparent opacity-60 hover:opacity-100'}`}>
                    <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
                  </button>
                );
              })}
            </div>
          </>
        )}
      </motion.div>
    </AnimatePresence>
  );
};
