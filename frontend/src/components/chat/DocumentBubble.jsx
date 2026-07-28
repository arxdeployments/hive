import React, { useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import { FileText, FileSpreadsheet, File, FileArchive, Download } from 'lucide-react';
import { PdfViewer } from './PdfViewer';

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
  const rawMediaUrl = message.media_url || attachment?.media_url || attachment?.url;
  const mediaUrl = resolveUrl(rawMediaUrl);

  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const fileInfo = FILE_ICONS[ext] || { icon: File, color: '#A3A3A3' };
  const IconComponent = fileInfo.icon;

  // Read the ATTACHMENT's fields first. The top-level ones mirror
  // attachments[0], but this component deliberately .find()s its own attachment,
  // which on a mixed message is not necessarily index 0.
  const thumbUrl = resolveUrl(attachment?.thumbnail_url ?? message.thumbnail_url);
  const pageCount = attachment?.page_count ?? message.page_count ?? null;

  const [thumbBroken, setThumbBroken] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);

  // Only PDFs ever get a preview: the backend rasterises page 1 at upload time
  // and nothing else has a thumbnail_key. docx/xlsx/zip therefore fall through
  // to the original icon layout byte-for-byte, and so do PDFs sent BEFORE
  // previews existed (their /thumb 404s, which onError catches).
  const isPdf = ext === 'pdf';
  const showPreview = isPdf && !!thumbUrl && !thumbBroken;

  const subtitle = [
    pageCount ? `${pageCount} page${pageCount === 1 ? '' : 's'}` : null,
    ext ? ext.toUpperCase() : null,
    formatFileSize(fileSize) || null,
  ].filter(Boolean).join(' · ');

  const surface = isOwn ? 'bg-[#059669] hover:bg-[#047857]' : 'bg-[#2D2D2D] hover:bg-[#333333]';
  const titleColor = isOwn ? 'text-white' : 'text-[#F5F5F5]';
  const subColor = isOwn ? 'text-white/60' : 'text-[#A3A3A3]';

  const meta = (
    <>
      <div
        className="w-10 h-10 rounded-[6px] flex items-center justify-center flex-shrink-0"
        style={{ backgroundColor: `${fileInfo.color}20` }}
      >
        <IconComponent size={20} style={{ color: fileInfo.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm truncate ${titleColor}`}>{filename}</p>
        <p className={`text-xs ${subColor}`}>{subtitle}</p>
      </div>
    </>
  );

  // Non-PDF (or preview-less) documents keep the original anchor: one click
  // downloads, exactly as before.
  if (!showPreview) {
    return (
      <a
        href={mediaUrl || undefined}
        download={filename}
        target="_blank"
        rel="noopener noreferrer"
        className={`no-underline w-[280px] flex items-center gap-3 p-3 rounded-[6px] cursor-pointer transition-colors ${surface}`}
        data-testid="document-bubble"
      >
        {meta}
        <Download size={16} className={subColor} />
      </a>
    );
  }

  // PDF with a preview: the surface OPENS THE READER, and download becomes its
  // own control. It has to be a <button> with a nested <a> rather than an
  // anchor — an <a> inside an <a> is invalid and the outer one would swallow it.
  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setViewerOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewerOpen(true); }
        }}
        aria-label={`Open ${filename}`}
        className={`w-[280px] flex flex-col gap-2 p-1.5 rounded-[6px] cursor-pointer transition-colors outline-none focus-visible:ring-1 focus-visible:ring-white/40 ${surface}`}
        data-testid="document-bubble"
      >
        <img
          src={thumbUrl}
          alt=""
          onError={() => setThumbBroken(true)}
          // object-top matters: a cropped portrait page must show the TOP of
          // page 1, which is where the title is, not its middle.
          className="w-full h-[150px] object-cover object-top rounded-[4px] bg-white"
          data-testid="document-thumbnail"
        />
        <div className="flex items-center gap-3 px-1.5 pb-1">
          {meta}
          <a
            href={mediaUrl || undefined}
            download={filename}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            aria-label={`Download ${filename}`}
            title="Download"
            data-testid="document-download"
            className={`p-1 rounded hover:bg-black/15 transition-colors ${subColor}`}
          >
            <Download size={16} />
          </a>
        </div>
      </div>

      <AnimatePresence>
        {viewerOpen && (
          <PdfViewer
            mediaUrl={rawMediaUrl}
            filename={filename}
            pageCount={pageCount}
            onClose={() => setViewerOpen(false)}
          />
        )}
      </AnimatePresence>
    </>
  );
};
