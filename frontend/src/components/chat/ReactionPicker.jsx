import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus } from 'lucide-react';
import EmojiPicker from 'emoji-picker-react';

const QUICK_REACTIONS = ['\ud83d\udc4d', '\u2764\ufe0f', '\ud83d\ude02', '\ud83d\ude2e', '\ud83d\ude22', '\ud83d\ude4f'];

/** Spoken name per quick reaction \u2014 an emoji glyph alone announces inconsistently. */
const REACTION_NAMES = {
  '\ud83d\udc4d': 'Thumbs up',
  '\u2764\ufe0f': 'Heart',
  '\ud83d\ude02': 'Laughing',
  '\ud83d\ude2e': 'Surprised',
  '\ud83d\ude22': 'Crying',
  '\ud83d\ude4f': 'Thank you',
};

export const ReactionPicker = ({ position, onReact, onClose }) => {
  const [showFull, setShowFull] = useState(false);
  const rowRef = useRef(null);
  const restoreRef = useRef(null);

  /**
   * Escape, and focus that actually enters the picker.
   *
   * It was dismissible only by clicking the backdrop, which a keyboard cannot
   * do \u2014 so opening it was a trap: Tab walked off into the thread behind while
   * the picker stayed up. Nothing is trapped here on purpose, unlike the modals:
   * this is a small popover anchored to a message, and Tab moving on is the
   * expected way to leave a popover once Escape exists.
   */
  /**
   * Read through a ref so a changing `onClose` cannot restart the effect below.
   * ChatPanel passes it as an inline arrow, so its identity changes on every
   * parent render — and the thread re-renders on every inbound message.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    if (!position) return undefined;
    restoreRef.current = document.activeElement;
    rowRef.current?.querySelector('button')?.focus({ preventScroll: true });
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onCloseRef.current?.();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const opener = restoreRef.current;
      restoreRef.current = null;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
    // `position` only — it is what actually means "a different picker opened".
    // With `onClose` here too, every message arriving in the thread tore this
    // down and re-ran it: the cleanup handed focus back to the opener and the
    // body then pulled it to the first quick reaction, so someone who had moved
    // to "Crying" was yanked back to "Thumbs up" whenever anyone sent anything.
  }, [position]);

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
            <div
              ref={rowRef}
              role="group"
              aria-label="React to message"
              className="flex items-center gap-1 bg-[#1A1A1A] border border-[#2D2D2D] rounded-full px-2 py-1 shadow-lg"
            >
              {QUICK_REACTIONS.map(emoji => (
                <button
                  key={emoji}
                  onClick={() => { onReact(emoji); onClose(); }}
                  // The glyph is the only content, and a screen reader's name for
                  // a bare emoji varies by platform and voice — "thumbs up sign",
                  // "+1", or nothing at all.
                  aria-label={REACTION_NAMES[emoji] || 'React'}
                  className="text-[28px] hover:scale-125 transition-transform p-1"
                >
                  {emoji}
                </button>
              ))}
              <button
                onClick={() => setShowFull(true)}
                aria-label="More reactions"
                aria-expanded={showFull}
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
