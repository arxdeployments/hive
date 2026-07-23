import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Smile, Paperclip, Mic, Image, FileText, Film, X, Loader2, Upload } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import EmojiPicker from 'emoji-picker-react';
import wsClient from '../../services/websocket';
import client from '../../api/client';

// Client-side size hints (server still enforces its own limits).
const MAX_IMAGE_SIZE = 16 * 1024 * 1024;   // 16MB
const MAX_MEDIA_SIZE = 200 * 1024 * 1024;  // 200MB (video / audio)
const MAX_DOC_SIZE = 100 * 1024 * 1024;    // 100MB

const VIDEO_ACCEPT = '.mp4,.mov,.webm,.m4v';
const AUDIO_ACCEPT = '.mp3,.m4a,.wav,.ogg,.aac';
const DOC_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip';

// Map the upload service's file_type onto the message `type` the API/bubbles expect.
const mapMessageType = (fileType) => {
  switch (fileType) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    default: return 'file'; // 'document' (and anything unknown) -> file
  }
};

// Best-effort local categorisation so we can pick the right size limit before upload.
const categorizeFile = (file) => {
  const mime = file.type || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  const name = (file.name || '').toLowerCase();
  if (/\.(mp4|mov|webm|m4v)$/.test(name)) return 'video';
  if (/\.(mp3|m4a|wav|ogg|aac)$/.test(name)) return 'audio';
  return 'document';
};

const maxSizeForCategory = (category) => {
  if (category === 'image') return MAX_IMAGE_SIZE;
  if (category === 'video' || category === 'audio') return MAX_MEDIA_SIZE;
  return MAX_DOC_SIZE;
};

export const MessageComposer = ({ conversationId, onSend, disabled, replyTo }) => {
  const [text, setText] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const [previewImages, setPreviewImages] = useState([]);
  const [previewCaption, setPreviewCaption] = useState('');
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaInputRef = useRef(null);
  const docInputRef = useRef(null);
  const typingRef = useRef(false);
  const typingTimerRef = useRef(null);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  useEffect(() => { adjustHeight(); }, [text, adjustHeight]);

  useEffect(() => {
    return () => {
      if (typingRef.current && conversationId) {
        wsClient.sendTypingStop(conversationId);
        typingRef.current = false;
      }
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [conversationId]);

  const handleTyping = useCallback(() => {
    if (!conversationId) return;
    if (!typingRef.current) {
      typingRef.current = true;
      wsClient.sendTypingStart(conversationId);
    }
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    typingTimerRef.current = setTimeout(() => {
      if (typingRef.current) {
        typingRef.current = false;
        wsClient.sendTypingStop(conversationId);
      }
    }, 3000);
  }, [conversationId]);

  const stopTyping = () => {
    if (typingRef.current && conversationId) {
      typingRef.current = false;
      wsClient.sendTypingStop(conversationId);
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    }
  };

  // ── Text send ────────────────────────────────────────────────────────────
  const handleSend = () => {
    if (!text.trim() || disabled || !conversationId) return;
    const tempId = uuidv4();
    const body = text.trim();
    const replyId = replyTo?._id || null;
    stopTyping();
    // Optimistic bubble (ChatPanel clears replyTo after this).
    onSend(body, tempId);
    // Deliver over WS, forwarding reply_to so threaded replies actually persist.
    wsClient.sendMessage(conversationId, body, tempId, replyId);
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    // 'rxhive_enter_sends': unset/'on' => Enter sends, Shift+Enter = newline.
    //                       'off'        => Enter always newlines; only the button sends.
    const enterSends = localStorage.getItem('rxhive_enter_sends') !== 'off';
    if (enterSends && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    // Otherwise let the newline through.
  };

  // ── Upload + media send ───────────────────────────────────────────────────
  const uploadFile = async (file, onProgress) => {
    const formData = new FormData();
    formData.append('file', file);
    // Cookie + CSRF auth via the shared axios client (no Bearer token, no raw fetch).
    const { data } = await client.post('/api/upload', formData, {
      onUploadProgress: (evt) => {
        if (onProgress && evt.total) {
          onProgress(Math.round((evt.loaded / evt.total) * 100));
        }
      },
    });
    return data;
  };

  const validateSize = (file) => {
    const category = categorizeFile(file);
    const max = maxSizeForCategory(category);
    if (file.size > max) {
      const mb = Math.round(max / (1024 * 1024));
      toast.error(`${file.name || 'File'} is too large (max ${mb}MB)`);
      return false;
    }
    return true;
  };

  // Upload a single file, then create the message carrying media_url (the fix).
  const sendMediaFile = async (file, replyId) => {
    const uploadResult = await uploadFile(file, setUploadProgress);
    const msgType = mapMessageType(uploadResult.file_type);
    const content = msgType === 'file' ? (uploadResult.filename || '') : '';
    const tempId = uuidv4();

    // Optimistic bubble with the real media url + thumbnail.
    onSend(content, tempId, msgType, uploadResult.file_url, uploadResult.thumbnail_url);

    await client.post(`/api/conversations/${conversationId}/messages`, {
      content,
      type: msgType,
      temp_id: tempId,
      media_url: uploadResult.file_url,
      reply_to: replyId,
    });
  };

  // Send a batch of non-image files (video / audio / documents) directly.
  const sendFilesDirectly = async (files) => {
    if (!conversationId || files.length === 0) return;
    const valid = files.filter(validateSize);
    if (valid.length === 0) return;

    setUploading(true);
    // Attach the reply only to the first file in the batch.
    const replyId = replyTo?._id || null;
    try {
      for (let i = 0; i < valid.length; i++) {
        await sendMediaFile(valid[i], i === 0 ? replyId : null);
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || err.message || 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  // ── Image selection (preview strip) ───────────────────────────────────────
  const handleImageSelect = (e) => {
    const files = Array.from(e.target.files || []);
    setShowAttachMenu(false);
    e.target.value = '';
    if (files.length === 0) return;
    const images = files.filter(f => (f.type || '').startsWith('image/'));
    if (images.length === 0) { toast.error('No valid images selected'); return; }
    const valid = images.filter(validateSize).slice(0, 5);
    if (valid.length === 0) return;

    setPreviewImages(valid.map(f => ({
      file: f,
      url: URL.createObjectURL(f),
      name: f.name,
    })));
  };

  // ── Media (video / audio) + Document selection — sent directly ────────────
  const handleDirectSelect = async (e) => {
    const files = Array.from(e.target.files || []);
    setShowAttachMenu(false);
    e.target.value = '';
    if (files.length === 0) return;
    await sendFilesDirectly(files);
  };

  // ── Send preview images ───────────────────────────────────────────────────
  const handleSendImages = async () => {
    if (previewImages.length === 0) return;
    setUploading(true);
    const replyId = replyTo?._id || null;
    try {
      for (let i = 0; i < previewImages.length; i++) {
        const uploadResult = await uploadFile(previewImages[i].file, setUploadProgress);
        const msgType = mapMessageType(uploadResult.file_type);
        const caption = i === 0 ? previewCaption.trim() : '';
        const tempId = uuidv4();

        onSend(caption, tempId, msgType, uploadResult.file_url, uploadResult.thumbnail_url);

        await client.post(`/api/conversations/${conversationId}/messages`, {
          content: caption,
          type: msgType,
          temp_id: tempId,
          media_url: uploadResult.file_url,
          reply_to: i === 0 ? replyId : null,
        });
      }
      setPreviewImages([]);
      setPreviewCaption('');
      toast.success(previewImages.length > 1 ? 'Images sent' : 'Image sent');
    } catch (err) {
      toast.error(err?.response?.data?.detail || err.message || 'Upload failed');
    } finally {
      setUploading(false);
      setUploadProgress(0);
    }
  };

  // ── Drag and drop ─────────────────────────────────────────────────────────
  const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(true); };
  const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setDragOver(false); };
  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) return;

    const images = files.filter(f => (f.type || '').startsWith('image/'));
    const others = files.filter(f => !(f.type || '').startsWith('image/'));

    if (images.length > 0) {
      const valid = images.filter(validateSize).slice(0, 5);
      if (valid.length > 0) {
        setPreviewImages(valid.map(f => ({ file: f, url: URL.createObjectURL(f), name: f.name })));
      }
    }
    if (others.length > 0) {
      // Video / audio / documents send straight through.
      sendFilesDirectly(others);
    }
  };

  // ── Clipboard paste ───────────────────────────────────────────────────────
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map(item => item.getAsFile()).filter(Boolean);
      const valid = files.filter(validateSize);
      if (valid.length > 0) {
        setPreviewImages(valid.map(f => ({ file: f, url: URL.createObjectURL(f), name: f.name || 'Pasted image' })));
      }
    }
  };

  // ── Emoji ─────────────────────────────────────────────────────────────────
  const handleEmojiClick = (emojiData) => {
    setText(prev => prev + emojiData.emoji);
    textareaRef.current?.focus();
  };

  const removePreviewImage = (index) => {
    setPreviewImages(prev => {
      const updated = prev.filter((_, i) => i !== index);
      if (updated.length === 0) setPreviewCaption('');
      return updated;
    });
  };

  const hasText = text.trim().length > 0;

  return (
    <div
      className="relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-20 bg-[#10B981]/10 border-2 border-dashed border-[#10B981] rounded-lg flex items-center justify-center pointer-events-none"
          >
            <div className="text-center">
              <Upload size={32} className="text-[#10B981] mx-auto mb-2" />
              <p className="text-sm text-[#10B981] font-medium">Drop files here</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Image Preview Modal */}
      <AnimatePresence>
        {previewImages.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-full left-0 right-0 bg-[#0A0A0A] border border-[#1F1F1F] rounded-t-[12px] p-4 z-30 max-h-[60vh] flex flex-col"
          >
            {/* Preview header */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[#F5F5F5] font-medium">{previewImages.length} image{previewImages.length > 1 ? 's' : ''} selected</span>
              <button onClick={() => { setPreviewImages([]); setPreviewCaption(''); }}
                className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded transition-colors">
                <X size={16} />
              </button>
            </div>

            {/* Thumbnail strip */}
            <div className="flex gap-2 overflow-x-auto pb-3">
              {previewImages.map((img, idx) => (
                <div key={idx} className="relative flex-shrink-0 w-[60px] h-[60px] rounded-lg overflow-hidden border border-[#2D2D2D]">
                  <img src={img.url} alt="" className="w-full h-full object-cover" />
                  <button onClick={() => removePreviewImage(idx)}
                    className="absolute top-0 right-0 w-5 h-5 bg-black/70 rounded-bl flex items-center justify-center text-white hover:bg-[#EF4444] transition-colors">
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>

            {/* Caption + Send */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={previewCaption}
                onChange={(e) => setPreviewCaption(e.target.value)}
                placeholder="Add a caption..."
                className="flex-1 h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#525252] focus:border-[#10B981] focus:outline-none"
                onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) handleSendImages(); }}
              />
              <button
                onClick={handleSendImages}
                disabled={uploading}
                data-testid="send-images-btn"
                className="w-10 h-10 rounded-full bg-[#10B981] text-white flex items-center justify-center hover:bg-[#059669] disabled:opacity-50 transition-colors"
              >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </div>

            {/* Upload progress */}
            {uploading && (
              <div className="mt-2 h-1 bg-[#1A1A1A] rounded-full overflow-hidden">
                <div className="h-full bg-[#10B981] transition-all" style={{ width: `${uploadProgress}%` }} />
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Emoji Picker */}
      <AnimatePresence>
        {showEmoji && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="absolute bottom-full left-0 mb-2 z-30"
          >
            <div className="relative">
              <div className="fixed inset-0 z-[-1]" onClick={() => setShowEmoji(false)} />
              <EmojiPicker
                onEmojiClick={handleEmojiClick}
                theme="dark"
                width={350}
                height={400}
                searchPlaceholder="Search emoji..."
                skinTonesDisabled
                previewConfig={{ showPreview: false }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main composer bar */}
      <div className="bg-[#0F0F0F] border-t border-[#1F1F1F] px-3 sm:px-4 py-3 safe-bottom">
        <div className="flex items-end gap-2">
          {/* Emoji button */}
          <button
            onClick={() => { setShowEmoji(!showEmoji); setShowAttachMenu(false); }}
            data-testid="composer-emoji-btn"
            className={`p-2 transition-colors flex-shrink-0 mb-0.5 ${showEmoji ? 'text-[#10B981]' : 'text-[#A3A3A3] hover:text-[#F5F5F5]'}`}
          >
            <Smile size={20} />
          </button>

          {/* Attachment button */}
          <div className="relative">
            <button
              onClick={() => { setShowAttachMenu(!showAttachMenu); setShowEmoji(false); }}
              data-testid="composer-attach-btn"
              className={`p-2 transition-colors flex-shrink-0 mb-0.5 ${showAttachMenu ? 'text-[#10B981]' : 'text-[#A3A3A3] hover:text-[#F5F5F5]'}`}
            >
              <Paperclip size={20} />
            </button>

            <AnimatePresence>
              {showAttachMenu && (
                <>
                  <div className="fixed inset-0 z-20" onClick={() => setShowAttachMenu(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="absolute bottom-full left-0 mb-2 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[8px] shadow-lg z-30 py-1 w-40"
                  >
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="attach-image-btn"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#F5F5F5] hover:bg-[#2D2D2D] transition-colors"
                    >
                      <Image size={16} className="text-[#10B981]" /> Image
                    </button>
                    <button
                      onClick={() => mediaInputRef.current?.click()}
                      data-testid="attach-media-btn"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#F5F5F5] hover:bg-[#2D2D2D] transition-colors"
                    >
                      <Film size={16} className="text-[#A855F7]" /> Media
                    </button>
                    <button
                      onClick={() => docInputRef.current?.click()}
                      data-testid="attach-doc-btn"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#F5F5F5] hover:bg-[#2D2D2D] transition-colors"
                    >
                      <FileText size={16} className="text-[#3B82F6]" /> Document
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          {/* Hidden file inputs */}
          <input ref={fileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleImageSelect} />
          <input ref={mediaInputRef} type="file" accept={`video/*,audio/*,${VIDEO_ACCEPT},${AUDIO_ACCEPT}`} multiple className="hidden" onChange={handleDirectSelect} />
          <input ref={docInputRef} type="file" accept={`${DOC_ACCEPT},${VIDEO_ACCEPT},${AUDIO_ACCEPT}`} multiple className="hidden" onChange={handleDirectSelect} />

          {/* Text input */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => { setText(e.target.value); handleTyping(); }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onFocus={(e) => {
              // Prevent browser from scrolling page to show input
              setTimeout(() => { window.scrollTo(0, 0); document.body.scrollTop = 0; }, 0);
            }}
            placeholder="Type a message"
            rows={1}
            disabled={disabled || uploading}
            data-testid="message-input"
            className="flex-1 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[8px] px-4 py-2.5 text-sm text-[#F5F5F5] placeholder:text-[#525252] resize-none focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all overflow-y-auto"
            style={{ maxHeight: 120, minHeight: 40 }}
          />

          {/* Send / Mic / Loading */}
          <button
            onClick={hasText ? handleSend : undefined}
            disabled={uploading}
            data-testid="message-send-btn"
            className={`p-2.5 rounded-full flex-shrink-0 mb-0.5 transition-all duration-150 ${
              uploading
                ? 'text-[#A3A3A3]'
                : hasText
                  ? 'bg-[#10B981] text-white hover:bg-[#059669] active:scale-[0.95]'
                  : 'text-[#A3A3A3] hover:text-[#F5F5F5]'
            }`}
          >
            {uploading ? <Loader2 size={18} className="animate-spin" /> : hasText ? <Send size={18} /> : <Mic size={20} />}
          </button>
        </div>
      </div>
    </div>
  );
};
