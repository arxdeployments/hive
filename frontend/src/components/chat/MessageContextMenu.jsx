import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Reply, SmilePlus, Forward, Copy, Star, Info, Trash, Trash2, Pencil } from 'lucide-react';
import { toast } from 'sonner';

const MENU_ITEMS = [
  { key: 'reply', icon: Reply, label: 'Reply', showFor: 'all' },
  { key: 'react', icon: SmilePlus, label: 'React', showFor: 'all' },
  { key: 'edit', icon: Pencil, label: 'Edit', showFor: 'own_editable' },
  { key: 'forward', icon: Forward, label: 'Forward', showFor: 'all' },
  { key: 'copy', icon: Copy, label: 'Copy', showFor: 'text' },
  { key: 'star', icon: Star, label: 'Star', showFor: 'all' },
  { key: 'info', icon: Info, label: 'Message Info', showFor: 'own' },
  { key: 'delete_me', icon: Trash, label: 'Delete for Me', showFor: 'all' },
  { key: 'delete_all', icon: Trash2, label: 'Delete for Everyone', showFor: 'own_recent', danger: true },
];

export const MessageContextMenu = ({ message, isOwn, position, onAction, onClose }) => {
  if (!position) return null;

  const isRecent = message.created_at &&
    (Date.now() - new Date(message.created_at).getTime()) < 60 * 60 * 1000;

  const filteredItems = MENU_ITEMS.filter(item => {
    if (item.showFor === 'text' && message.type !== 'text') return false;
    if (item.showFor === 'own' && !isOwn) return false;
    if (item.showFor === 'own_recent' && (!isOwn || !isRecent)) return false;
    // Edit: own, non-deleted, non-system messages only.
    if (item.showFor === 'own_editable' && (!isOwn || message.is_deleted || message.type === 'system')) return false;
    return true;
  });

  const handleAction = (key) => {
    if (key === 'copy') {
      navigator.clipboard.writeText(message.content || '');
      toast.success('Message copied');
      onClose();
      return;
    }
    onAction(key, message);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.1 }}
          className="fixed z-50 min-w-[180px] bg-[#1A1A1A] border border-[#2D2D2D] rounded-[8px] shadow-lg py-1"
          style={{ top: position.y, left: position.x }}
          data-testid="message-context-menu"
        >
          {filteredItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.key}
                onClick={() => handleAction(item.key)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
                  item.danger
                    ? 'text-[#EF4444] hover:bg-[#EF4444]/10'
                    : 'text-[#F5F5F5] hover:bg-[#2D2D2D]'
                }`}
                data-testid={`ctx-${item.key}`}
              >
                <Icon size={16} />
                {item.label}
              </button>
            );
          })}
        </motion.div>
      </AnimatePresence>
    </>
  );
};
