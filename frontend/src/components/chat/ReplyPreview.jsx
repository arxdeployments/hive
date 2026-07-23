import React from 'react';
import { X, Image } from 'lucide-react';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

export const ReplyPreview = ({ message, onClose }) => {
  if (!message) return null;

  const isImage = message.type === 'image';
  const isDeleted = message.is_deleted;
  const senderName = message.sender_name || 'Unknown';
  const content = isDeleted ? 'This message was deleted' : (message.content || '');

  return (
    <div className="bg-[#141414] border-t border-[#1F1F1F] px-4 py-2 flex items-center gap-3" data-testid="reply-preview">
      <div className="w-1 h-10 bg-[#10B981] rounded-full flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-[#10B981]">{senderName}</p>
        <p className="text-[13px] text-[#A3A3A3] truncate">
          {isImage ? '📷 Photo' : content.substring(0, 100)}
        </p>
      </div>
      {isImage && message.media_url && (
        <img
          src={message.media_url.startsWith('http') ? message.media_url : `${backendUrl}${message.media_url}`}
          alt=""
          className="w-10 h-10 rounded object-cover flex-shrink-0"
        />
      )}
      <button onClick={onClose} className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded transition-colors flex-shrink-0">
        <X size={16} />
      </button>
    </div>
  );
};
