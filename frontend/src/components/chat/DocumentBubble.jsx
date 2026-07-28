import React from 'react';
import { FileText, FileSpreadsheet, File, FileArchive, Download } from 'lucide-react';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const resolveUrl = (url) => {
  if (!url) return '';
  return url.startsWith('http') ? url : `${backendUrl}${url}`;
};

// Exported so the pre-send attachment preview can render the SAME icon and
// colour a document will have once it is a bubble — one mapping, not two that
// drift apart.
export const FILE_ICONS = {
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

export const formatFileSize = (bytes) => {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

export const DocumentBubble = ({ message, isOwn }) => {
  // Fall back to a file attachment when the message doesn't carry the fields inline.
  const attachment = Array.isArray(message.attachments)
    ? (message.attachments.find(a => !a.type || a.type === 'file' || a.type === 'document') || message.attachments[0])
    : null;

  const filename = message.filename || attachment?.filename || message.content || 'Document';
  const fileSize = message.file_size ?? attachment?.file_size;
  // media_url is already a correct relative path ('/api/media/<id>'); the API
  // serves it with an attachment disposition, so a plain download anchor works.
  const mediaUrl = resolveUrl(message.media_url || attachment?.media_url || attachment?.url);

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const fileInfo = FILE_ICONS[ext] || { icon: File, color: '#A3A3A3' };
  const IconComponent = fileInfo.icon;

  return (
    <a
      href={mediaUrl || undefined}
      download={filename}
      target="_blank"
      rel="noopener noreferrer"
      className={`no-underline w-[280px] flex items-center gap-3 p-3 rounded-[6px] cursor-pointer transition-colors ${
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
          {formatFileSize(fileSize)}
        </p>
      </div>
      <Download size={16} className={isOwn ? 'text-white/60' : 'text-[#A3A3A3]'} />
    </a>
  );
};
