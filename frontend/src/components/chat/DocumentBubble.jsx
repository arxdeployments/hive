import React, { useState } from 'react';
import { FileText, FileSpreadsheet, File, FileArchive, Download } from 'lucide-react';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const FILE_ICONS = {
  pdf: { icon: FileText, color: '#EF4444' },
  doc: { icon: FileText, color: '#3B82F6' },
  docx: { icon: FileText, color: '#3B82F6' },
  xls: { icon: FileSpreadsheet, color: '#22C55E' },
  xlsx: { icon: FileSpreadsheet, color: '#22C55E' },
  ppt: { icon: File, color: '#F97316' },
  pptx: { icon: File, color: '#F97316' },
  txt: { icon: FileText, color: '#A3A3A3' },
  csv: { icon: FileSpreadsheet, color: '#A3A3A3' },
  zip: { icon: FileArchive, color: '#A855F7' },
};

const formatFileSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const DocumentBubble = ({ message, isOwn }) => {
  const filename = message.content || message.filename || 'Document';
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const fileInfo = FILE_ICONS[ext] || { icon: File, color: '#A3A3A3' };
  const IconComponent = fileInfo.icon;
  const mediaUrl = message.media_url?.startsWith('http') ? message.media_url : `${backendUrl}${message.media_url}`;

  const handleDownload = () => {
    if (mediaUrl) {
      const a = document.createElement('a');
      a.href = mediaUrl;
      a.download = filename;
      a.target = '_blank';
      a.click();
    }
  };

  return (
    <div
      onClick={handleDownload}
      className={`w-[280px] flex items-center gap-3 p-3 rounded-[6px] cursor-pointer transition-colors ${
        isOwn ? 'bg-[#059669] hover:bg-[#047857]' : 'bg-[#2D2D2D] hover:bg-[#333333]'
      }`}
      data-testid="document-bubble"
    >
      <div className="w-10 h-10 rounded-[6px] flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${fileInfo.color}20` }}>
        <IconComponent size={20} style={{ color: fileInfo.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>{filename}</p>
        <p className={`text-xs ${isOwn ? 'text-white/60' : 'text-[#A3A3A3]'}`}>
          {formatFileSize(message.file_size)}
        </p>
      </div>
      <Download size={16} className={isOwn ? 'text-white/60' : 'text-[#A3A3A3]'} />
    </div>
  );
};
