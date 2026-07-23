import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus } from 'lucide-react';
import EmojiPicker from 'emoji-picker-react';

const QUICK_REACTIONS = ['\ud83d\udc4d', '\u2764\ufe0f', '\ud83d\ude02', '\ud83d\ude2e', '\ud83d\ude22', '\ud83d\ude4f'];

export const ReactionPicker = ({ position, onReact, onClose }) => {
  const [showFull, setShowFull] = useState(false);

  if (!position) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.1 }}
          className="fixed z-50"
          style={{ top: position.y - 50, left: position.x }}
          data-testid="reaction-picker"
        >
          {showFull ? (
            <div onClick={(e) => e.stopPropagation()}>
              <EmojiPicker
                onEmojiClick={(data) => { onReact(data.emoji); onClose(); }}
                theme="dark"
                width={320}
                height={350}
                searchPlaceholder="Search..."
                skinTonesDisabled
                previewConfig={{ showPreview: false }}
              />
            </div>
          ) : (
            <div className="flex items-center gap-1 bg-[#1A1A1A] border border-[#2D2D2D] rounded-full px-2 py-1 shadow-lg">
              {QUICK_REACTIONS.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => { onReact(emoji); onClose(); }}
                  className="text-[28px] hover:scale-125 transition-transform p-1"
                >
                  {emoji}
                </button>
              ))}
              <button
                onClick={() => setShowFull(true)}
                className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#2D2D2D] rounded-full transition-colors"
              >
                <Plus size={16} />
              </button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </>
  );
};
