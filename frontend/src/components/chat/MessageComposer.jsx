import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { Send, Smile, Paperclip, Mic, Image, FileText, Film, X, Loader2, Upload } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import EmojiPicker from 'emoji-picker-react';
import wsClient from '../../services/websocket';
import client from '../../api/client';
import useChatStore from '../../stores/chatStore';
// Reused so a staged document shows the SAME icon, colour and size formatting it
// will have once it is a bubble.
import { FILE_ICONS, formatFileSize } from './DocumentBubble';
import { AudioRecorderBar } from './AudioRecorderBar';
import { StagedFilePreview } from './StagedFilePreview';
import useAudioRecorder from '../../hooks/useAudioRecorder';
import { useSendPolicy, acceptFor, isBlockedFile } from '../../hooks/useSendPolicy';
import { canRecordAudio } from '../../utils/audioFormat';

// Client-side size hints (server still enforces its own limits).
const MAX_IMAGE_SIZE = 16 * 1024 * 1024;   // 16MB
const MAX_MEDIA_SIZE = 200 * 1024 * 1024;  // 200MB (video / audio)
const MAX_DOC_SIZE = 100 * 1024 * 1024;    // 100MB

const VIDEO_ACCEPT = '.mp4,.mov,.webm,.m4v';
const AUDIO_ACCEPT = '.mp3,.m4a,.wav,.ogg,.aac';
const DOC_ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip';

// How many files the confirmation tray will hold at once. Images and video each
// hold a live object URL that the browser decodes for the thumbnail, so this is
// a memory bound rather than a server one. Anything beyond it is reported to the
// user instead of being dropped in silence.
const MAX_STAGED_FILES = 10;

// Human label for the confirmation tray header, so it never says "images" about
// a PDF.
const CATEGORY_LABEL = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  document: 'file',
};

const describeStaged = (staged) => {
  if (staged.length === 0) return '';
  const kinds = new Set(staged.map(s => s.category));
  const noun = kinds.size === 1 ? CATEGORY_LABEL[[...kinds][0]] || 'file' : 'file';
  return `${staged.length} ${noun}${staged.length > 1 ? 's' : ''} selected`;
};

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

/**
 * `draft` is an optional `{ token, text }` seed from the parent — "Reply
 * privately" uses it to drop a quote into a freshly opened DM. `token` (not
 * `text`) is the trigger, so seeding the same quote twice still works.
 */
const MessageComposerInner = ({ conversationId, onSend, disabled, replyTo, draft }) => {
  const [text, setText] = useState('');
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  // Files chosen but NOT yet uploaded. Every category stages here now — nothing
  // reaches the network until the user confirms. Shape:
  //   { id, file, url, name, category, size }
  const [stagedFiles, setStagedFiles] = useState([]);
  const [previewCaption, setPreviewCaption] = useState('');
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaInputRef = useRef(null);
  const docInputRef = useRef(null);
  const typingRef = useRef(false);
  const typingTimerRef = useRef(null);

  // Duplicate-send guards. These are refs, not state, deliberately: a second
  // click or keypress in the same tick must see the flag already set, and a
  // setState would not have been applied yet. `uploading` state still drives the
  // spinner and the disabled attribute; these refs are what actually make a
  // double send impossible.
  const sendingFilesRef = useRef(false);
  const sendingTextRef = useRef(false);
  const sendingVoiceRef = useRef(false);
  // Set when Send was pressed while paused, so the finalised recording is
  // uploaded as soon as the recorder promotes it to 'preview'.
  const sendAfterStopRef = useRef(false);

  // Voice notes. `micSupported` is computed once: without MediaRecorder, without
  // getUserMedia, or outside a secure context the button is hidden rather than
  // offered and then failing on click.
  const recorder = useAudioRecorder();
  const [micSupported] = useState(() => canRecordAudio());

  // What this user may send. A rendering hint only — the server re-checks every
  // send at claim time, and it must, because `accept` is advisory and neither
  // drag-and-drop nor paste honours it.
  const sendPolicy = useSendPolicy();
  // A voice note is an audio upload down the identical path, so an audio
  // restriction has to disable the mic as well — otherwise the user records,
  // waits for the upload and only then gets a 403.
  const canRecord = micSupported && sendPolicy.audio;
  const [voiceSending, setVoiceSending] = useState(false);
  // Index of the staged file being previewed full-size, or null. Nothing has been
  // uploaded at this point, so the preview reads the tray's own object URL.
  const [previewIndex, setPreviewIndex] = useState(null);

  // Release every object URL we own on unmount, so closing a chat mid-selection
  // does not leak the decoded previews.
  const stagedRef = useRef(stagedFiles);
  stagedRef.current = stagedFiles;
  useEffect(() => () => {
    stagedRef.current.forEach(s => URL.revokeObjectURL(s.url));
  }, []);

  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, []);

  useEffect(() => { adjustHeight(); }, [text, adjustHeight]);

  // Seed the box from the parent's draft, caret parked at the end so the user
  // types their reply after the quote rather than in front of it.
  const draftToken = draft?.token;
  useEffect(() => {
    if (!draftToken) return;
    const seed = draft?.text || '';
    setText(seed);
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    try {
      el.setSelectionRange(seed.length, seed.length);
    } catch {
      // Older engines reject setSelectionRange before layout; the focus is enough.
    }
    // `draft.text` is intentionally not a dependency: the token is the trigger.
  }, [draftToken]);

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
    // Reentrancy guard: the send button's onClick and the Enter keydown both land
    // here, and setText('') below is asynchronous — so two events in the same
    // tick would each still see the old non-empty `text` and send it twice.
    // Cleared in a finally so an early return can never wedge the composer.
    if (sendingTextRef.current) return;
    sendingTextRef.current = true;
    try {
      const tempId = uuidv4();
      const body = text.trim();
      const replyId = replyTo?._id || null;
      stopTyping();
    // Optimistic bubble (ChatPanel clears replyTo after this). ChatPanel also
    // owns the HTTP fallback, which it applies when the socket is down.
      onSend(body, tempId);
      // Deliver over WS only while the socket is genuinely open, forwarding
      // reply_to so threaded replies actually persist.
      //
      // The guard is the fix for a double-send: this used to call sendMessage
      // unconditionally, and wsClient.send() QUEUES a frame written to a closed
      // socket, which _onOpen then replays on reconnect. Offline, that meant
      // ChatPanel's HTTP fallback created the message and the replayed frame
      // created it again. Both this check and ChatPanel's read wsClient.isOpen()
      // in the same synchronous call stack, so exactly one transport owns
      // any given send.
      if (wsClient.isOpen()) {
        wsClient.sendMessage(conversationId, body, tempId, replyId);
      }
      setText('');
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
    } finally {
      sendingTextRef.current = false;
    }
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
  // `caption` overrides the derived content (the image preview strip's caption).
  const sendMediaFile = async (file, replyId, caption = '', duration = null) => {
    const uploadResult = await uploadFile(file, setUploadProgress);
    const msgType = mapMessageType(uploadResult.file_type);
    const content = caption || (msgType === 'file' ? (uploadResult.filename || '') : '');
    const tempId = uuidv4();

    // Optimistic bubble with the real media url + thumbnail.
    onSend(content, tempId, msgType, uploadResult.file_url, uploadResult.thumbnail_url);

    try {
      const { data } = await client.post(`/api/conversations/${conversationId}/messages`, {
        content,
        type: msgType,
        temp_id: tempId,
        media_url: uploadResult.file_url,
        reply_to: replyId,
        // Only voice notes send this. Measured by wall clock in the recorder,
        // because a MediaRecorder blob cannot be asked its own length.
        duration,
      });
      // Media is created over HTTP, so there is no WS message_ack to reconcile
      // against the way a text send has. Discarding this response left the bubble
      // holding its temp _id at status 'sending' forever — the tick never resolved.
      useChatStore.getState().replaceOptimisticMessage(conversationId, tempId, data);
    } catch (err) {
      // Same reason: leave a retryable bubble rather than one stuck on 'sending'.
      useChatStore.getState().replaceOptimisticMessage(conversationId, tempId, { status: 'failed' });
      throw err;
    }
  };

  // NOTE: the former `sendFilesDirectly` batch sender is gone. It existed only to
  // upload video/audio/documents the instant they were picked, which is exactly
  // the behaviour feature 1 removes — every category now goes through the
  // confirmation tray and handleConfirmSend, so there is one send path instead of
  // two that had to be kept in sync.

  // Stage files for confirmation. NOTHING here touches the network — that is the
  // entire point of the confirmation step. Shared by the picker, drag-and-drop
  // and paste so all four categories behave identically.
  //
  // APPENDS rather than replaces, so choosing a video and then an image builds
  // one batch instead of silently discarding the first pick (and leaking its
  // object URL, which the previous replace-based version did).
  const stageFiles = (files) => {
    const sized = files.filter(validateSize);
    if (sized.length === 0) return;
    setStagedFiles(prev => {
      const room = MAX_STAGED_FILES - prev.length;
      if (room <= 0) {
        toast.error(`Only ${MAX_STAGED_FILES} files can be attached at once`);
        return prev;
      }
      const accepted = sized.slice(0, room);
      if (sized.length > accepted.length) {
        toast.error(
          `Only ${MAX_STAGED_FILES} files can be attached at once — ${sized.length - accepted.length} were not added`
        );
      }
      return [
        ...prev,
        ...accepted.map(f => ({
          id: uuidv4(),
          file: f,
          url: URL.createObjectURL(f),
          // Clipboard images often arrive with no filename at all.
          name: f.name || 'Pasted image',
          category: categorizeFile(f),
          size: f.size,
        })),
      ];
    });
  };

  // A staged file can disappear under the preview (removed, or the batch sent),
  // and an index pointing past the end would render nothing at all.
  useEffect(() => {
    if (previewIndex !== null && previewIndex >= stagedFiles.length) {
      setPreviewIndex(stagedFiles.length > 0 ? stagedFiles.length - 1 : null);
    }
  }, [stagedFiles.length, previewIndex]);

  // Cancel: drop the whole batch, revoking every object URL we created for it.
  const clearStaged = () => {
    setStagedFiles(prev => {
      prev.forEach(s => URL.revokeObjectURL(s.url));
      return [];
    });
    setPreviewCaption('');
  };

  // ── Selection — every category stages for confirmation ────────────────────
  //
  // Previously images went to a preview strip while video, audio and documents
  // were uploaded and posted the instant they were chosen, with no confirmation
  // and no chance to add a caption or back out. All three pickers now funnel
  // into the same staging tray.
  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    setShowAttachMenu(false);
    // Reset the input so re-picking the same file still fires a change event.
    e.target.value = '';
    if (files.length === 0) return;
    stageFiles(files);
  };

  // ── Voice notes ───────────────────────────────────────────────────────────
  const handleMicClick = async () => {
    if (disabled || !conversationId) return;
    const { ok, error } = await recorder.start();
    if (!ok && error) toast.error(error);
  };

  const uploadVoice = useCallback(async (rec) => {
    if (!rec || !conversationId) return;
    // Same reentrancy guard as text and files: the button is disabled while
    // sending, but a double-click can land before React re-renders.
    if (sendingVoiceRef.current) return;
    sendingVoiceRef.current = true;
    setVoiceSending(true);
    try {
      // The extension is what the server classifies on, so it must come from the
      // recorder's chosen format — see utils/audioFormat.js for why .webm is
      // never used here.
      const file = new File(
        [rec.blob],
        `voice-${Date.now()}.${rec.extension}`,
        { type: rec.mimeType }
      );
      await sendMediaFile(file, replyTo?._id || null, '', Math.round(rec.duration * 10) / 10);
      recorder.reset();
    } catch (err) {
      toast.error(err?.response?.data?.detail || err.message || 'Failed to send voice message');
    } finally {
      setVoiceSending(false);
      sendingVoiceRef.current = false;
    }
  }, [conversationId, replyTo, recorder, sendMediaFile]);

  /**
   * Completes a send that was requested while paused.
   *
   * handleSendVoice cannot simply await recorder.stop(): finalising is driven by
   * MediaRecorder's onstop callback, so the completed blob only exists a tick
   * later, once the hook has promoted the state to 'preview'. This picks it up
   * then. The flag is cleared first so a failed upload does not re-fire.
   */
  useEffect(() => {
    if (!sendAfterStopRef.current) return;
    if (recorder.state !== 'preview' || !recorder.result) return;
    sendAfterStopRef.current = false;
    uploadVoice(recorder.result);
  }, [recorder.state, recorder.result, uploadVoice]);

  /**
   * Send from either review stage.
   *
   * From `paused`, the blob currently on screen is a PARTIAL preview assembled
   * mid-recording — it may be missing a trailing container atom and, on Safari,
   * may not even play. It must never be what gets uploaded. So a paused send
   * finalises the recording first and lets the effect above pick up the
   * completed result. Sending is what the user asked for either way; the stop is
   * invisible to them.
   *
   * Declared after uploadVoice deliberately: no-use-before-define is enabled in
   * this project because a dependency array that referenced a later `const`
   * once crashed the whole chat pane at mount.
   */
  const handleSendVoice = async () => {
    if (recorder.state === 'paused') {
      if (sendingVoiceRef.current) return;
      setVoiceSending(true);
      sendAfterStopRef.current = true;
      recorder.stop();
      return;
    }
    await uploadVoice(recorder.result);
  };

  // ── Confirm Send ──────────────────────────────────────────────────────────
  //
  // The only path that uploads a chosen file. Nothing before this point has hit
  // the network, so Cancel is genuinely free.
  //
  // Failures are caught per file: a single bad file used to abort the loop, so
  // the remaining files were never sent AND the tray was never cleared. Only the
  // files that actually failed stay staged, so the user can retry just those.
  const handleConfirmSend = async () => {
    if (stagedFiles.length === 0) return;
    // Reentrancy guard — see sendingTextRef. The button is also disabled while
    // uploading, but a rapid double-click or an Enter in the caption field can
    // both land before React re-renders with the disabled attribute applied.
    if (sendingFilesRef.current) return;
    sendingFilesRef.current = true;

    const batch = stagedFiles;
    setUploading(true);
    const replyId = replyTo?._id || null;
    const caption = previewCaption.trim();
    const stillFailed = [];
    try {
      for (let i = 0; i < batch.length; i++) {
        try {
          // Shared with every other send path so the optimistic bubble is
          // reconciled with the created message in exactly one place.
          await sendMediaFile(
            batch[i].file,
            i === 0 ? replyId : null,
            i === 0 ? caption : ''
          );
          // Sent — release this preview's object URL.
          URL.revokeObjectURL(batch[i].url);
        } catch (err) {
          stillFailed.push(batch[i]);
          toast.error(
            `${batch[i].name || 'File'}: ${err?.response?.data?.detail || err.message || 'Upload failed'}`
          );
        }
      }
    } finally {
      setUploading(false);
      setUploadProgress(0);
      sendingFilesRef.current = false;
    }

    const sent = batch.length - stillFailed.length;
    setStagedFiles(stillFailed);
    if (stillFailed.length === 0) {
      setPreviewCaption('');
      toast.success(sent > 1 ? `${sent} files sent` : 'File sent');
    } else if (sent > 0) {
      toast.error(`${stillFailed.length} of ${batch.length} failed — still attached`);
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
    // `accept` on the hidden inputs does nothing here — drop bypasses it
    // entirely — so the policy has to be applied by hand or a restricted user
    // stages a file that will be refused on send.
    const permitted = files.filter((f) => !isBlockedFile(sendPolicy, f));
    if (permitted.length < files.length) {
      toast.error(
        permitted.length
          ? 'Some files are not allowed for your account and were skipped'
          : 'That file type is not allowed for your account'
      );
    }
    if (permitted.length === 0) return;
    // Everything staged for confirmation — dropping a video no longer sends it
    // before the user has seen it.
    stageFiles(permitted);
  };

  // ── Clipboard paste ───────────────────────────────────────────────────────
  const handlePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'));
    if (imageItems.length > 0) {
      e.preventDefault();
      const files = imageItems.map(item => item.getAsFile()).filter(Boolean);
      // Paste ignores `accept` too. A pasted screenshot is an image upload like
      // any other, so it is subject to the same rule.
      if (!sendPolicy.image) {
        toast.error('Photos are not allowed for your account');
        return;
      }
      stageFiles(files);
    }
  };

  // ── Emoji ─────────────────────────────────────────────────────────────────
  const handleEmojiClick = (emojiData) => {
    setText(prev => prev + emojiData.emoji);
    textareaRef.current?.focus();
  };

  // Remove one staged file, revoking its object URL — previously this dropped
  // the entry and leaked the URL for the lifetime of the tab.
  const removeStagedFile = (id) => {
    setStagedFiles(prev => {
      const target = prev.find(s => s.id === id);
      if (target) URL.revokeObjectURL(target.url);
      const updated = prev.filter(s => s.id !== id);
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

      {/* Attachment confirmation tray — every category lands here BEFORE any
          upload happens, so Cancel costs nothing and a caption is always
          possible. */}
      <AnimatePresence>
        {stagedFiles.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            data-testid="attachment-preview"
            className="absolute bottom-full left-0 right-0 bg-[#0A0A0A] border border-[#1F1F1F] rounded-t-[12px] p-4 z-30 max-h-[60vh] flex flex-col"
          >
            {/* Header + Cancel */}
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-[#F5F5F5] font-medium">
                {describeStaged(stagedFiles)}
                <span className="ml-2 text-[11px] font-normal text-[#525252]">tap to preview</span>
              </span>
              <button
                onClick={clearStaged}
                disabled={uploading}
                data-testid="cancel-attachments-btn"
                aria-label="Cancel attachments"
                className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded transition-colors disabled:opacity-40"
              >
                <X size={16} />
              </button>
            </div>

            {/* Per-category preview tiles. Images and video get a real visual
                preview from the object URL; audio and documents get the same
                icon language they will have as bubbles. */}
            <div className="flex gap-2 overflow-x-auto pb-3 scrollable-area">
              {stagedFiles.map((f) => {
                const iconMeta = FILE_ICONS[(f.name.split('.').pop() || '').toLowerCase()];
                const DocIcon = iconMeta?.icon || FileText;
                return (
                  <div
                    key={f.id}
                    title={`${f.name}${f.size ? ` (${formatFileSize(f.size)})` : ''} — click to preview`}
                    role="button"
                    tabIndex={0}
                    onClick={() => setPreviewIndex(stagedFiles.findIndex(x => x.id === f.id))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setPreviewIndex(stagedFiles.findIndex(x => x.id === f.id));
                      }
                    }}
                    aria-label={`Preview ${f.name}`}
                    data-testid="staged-file-tile"
                    className="relative flex-shrink-0 w-[60px] h-[60px] rounded-lg overflow-hidden border border-[#2D2D2D] bg-[#1A1A1A] cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-[#10B981] hover:border-[#10B981]/60 transition-colors"
                  >
                    {f.category === 'image' && (
                      <img src={f.url} alt={f.name} className="w-full h-full object-cover" />
                    )}
                    {f.category === 'video' && (
                      <>
                        {/* preload=metadata renders the first frame without
                            downloading or playing the whole file. */}
                        <video src={f.url} muted playsInline preload="metadata" className="w-full h-full object-cover" />
                        <span className="absolute inset-0 flex items-center justify-center bg-black/30 pointer-events-none">
                          <Film size={18} className="text-white" />
                        </span>
                      </>
                    )}
                    {f.category === 'audio' && (
                      <span className="w-full h-full flex items-center justify-center">
                        <Mic size={20} className="text-[#A855F7]" />
                      </span>
                    )}
                    {f.category === 'document' && (
                      <span className="w-full h-full flex items-center justify-center">
                        <DocIcon size={20} style={{ color: iconMeta?.color || '#A3A3A3' }} />
                      </span>
                    )}
                    {f.category !== 'image' && f.category !== 'video' && (
                      <span className="absolute bottom-0 left-0 right-0 px-1 pb-0.5 text-[8px] leading-tight text-[#A3A3A3] truncate bg-black/60">
                        {f.name}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); removeStagedFile(f.id); }}
                      disabled={uploading}
                      aria-label={`Remove ${f.name}`}
                      className="absolute top-0 right-0 w-5 h-5 bg-black/70 rounded-bl flex items-center justify-center text-white hover:bg-[#EF4444] transition-colors disabled:opacity-40"
                    >
                      <X size={10} />
                    </button>
                  </div>
                );
              })}
            </div>

            {/* Caption + Confirm Send */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={previewCaption}
                onChange={(e) => setPreviewCaption(e.target.value)}
                placeholder="Add a caption..."
                disabled={uploading}
                className="flex-1 h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#525252] focus:border-[#10B981] focus:outline-none disabled:opacity-60"
                onKeyDown={(e) => { if (e.key === 'Enter' && !uploading) handleConfirmSend(); }}
              />
              <button
                onClick={handleConfirmSend}
                disabled={uploading}
                aria-busy={uploading}
                aria-label={uploading ? 'Sending' : 'Send attachments'}
                /* Test id kept as send-images-btn: the existing e2e suite hooks
                   this selector and the button's role has not changed. */
                data-testid="send-images-btn"
                className="w-10 h-10 rounded-full bg-[#10B981] text-white flex items-center justify-center hover:bg-[#059669] disabled:opacity-50 transition-colors"
              >
                {uploading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
              </button>
            </div>

            {/* Sending state: determinate bar plus an explicit count, so a
                multi-file batch shows progress THROUGH the batch and not just
                within the current file. */}
            {uploading && (
              <>
                <div className="mt-2 h-1 bg-[#1A1A1A] rounded-full overflow-hidden">
                  <div className="h-full bg-[#10B981] transition-all" style={{ width: `${uploadProgress}%` }} />
                </div>
                <p className="mt-1.5 text-[11px] text-[#A3A3A3]" data-testid="attachment-sending-status">
                  Sending {stagedFiles.length} {stagedFiles.length === 1 ? 'file' : 'files'}…
                </p>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-size look at a staged file, before anything is uploaded. */}
      <AnimatePresence>
        {previewIndex !== null && stagedFiles[previewIndex] && (
          <StagedFilePreview
            files={stagedFiles}
            index={previewIndex}
            onIndex={setPreviewIndex}
            onClose={() => setPreviewIndex(null)}
          />
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

      {/* While recording or reviewing a voice note the recorder REPLACES the
          composer row, so there is no ambiguity about what Send would send. */}
      {recorder.state !== 'idle' ? (
        <AudioRecorderBar
          stage={recorder.state}
          elapsed={recorder.elapsed}
          result={recorder.result}
          stream={recorder.stream}
          onCancel={() => { sendAfterStopRef.current = false; recorder.cancel(); }}
          onPause={recorder.pause}
          onResume={recorder.resume}
          onStop={recorder.stop}
          onSend={handleSendVoice}
          sending={voiceSending}
        />
      ) : (
      /* Main composer bar */
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
                    {(sendPolicy.image || sendPolicy.video) && (
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      data-testid="attach-image-btn"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#F5F5F5] hover:bg-[#2D2D2D] transition-colors"
                    >
                      <Image size={16} className="text-[#10B981]" /> Photos &amp; Videos
                    </button>
                    )}
                    {(sendPolicy.video || sendPolicy.audio) && (
                    <button
                      onClick={() => mediaInputRef.current?.click()}
                      data-testid="attach-media-btn"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#F5F5F5] hover:bg-[#2D2D2D] transition-colors"
                    >
                      <Film size={16} className="text-[#A855F7]" /> Media
                    </button>
                    )}
                    {sendPolicy.document && (
                    <button
                      onClick={() => docInputRef.current?.click()}
                      data-testid="attach-doc-btn"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#F5F5F5] hover:bg-[#2D2D2D] transition-colors"
                    >
                      <FileText size={16} className="text-[#3B82F6]" /> Document
                    </button>
                    )}
                    {/* Every category blocked. Saying so beats an empty popover,
                        which reads as a broken menu rather than a policy. */}
                    {!sendPolicy.image && !sendPolicy.video && !sendPolicy.audio && !sendPolicy.document && (
                      <p className="px-4 py-2.5 text-xs text-[#A3A3A3]" data-testid="attach-none-allowed">
                        Attachments are turned off for your account.
                      </p>
                    )}
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>

          {/* Hidden file inputs */}
          {/* Photos & videos: one picker for both so a mixed batch is a single
              selection. All three pickers share handleFileSelect, which stages
              every category for confirmation instead of sending anything. */}
          <input ref={fileInputRef} type="file" accept={sendPolicy.image || sendPolicy.video ? `${sendPolicy.image ? 'image/*,' : ''}${sendPolicy.video ? `video/*,${acceptFor(sendPolicy, 'video', VIDEO_ACCEPT)}` : ''}`.replace(/,$/, '') : ''} multiple className="hidden" onChange={handleFileSelect} />
          <input ref={mediaInputRef} type="file" accept={[sendPolicy.video && `video/*,${acceptFor(sendPolicy, 'video', VIDEO_ACCEPT)}`, sendPolicy.audio && `audio/*,${acceptFor(sendPolicy, 'audio', AUDIO_ACCEPT)}`].filter(Boolean).join(',')} multiple className="hidden" onChange={handleFileSelect} />
          <input ref={docInputRef} type="file" accept={acceptFor(sendPolicy, 'document', DOC_ACCEPT)} multiple className="hidden" onChange={handleFileSelect} />

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

          {/* Send / Mic / Loading.
              The Mic half used to be `onClick={hasText ? handleSend : undefined}` —
              with an empty box the button rendered a microphone and its handler was
              literally undefined, so clicking it did nothing at all. It also had no
              aria-label in either role. Both roles are now labelled, and the mic
              records. When recording is unsupported (no MediaRecorder, no
              getUserMedia, or an insecure context) the button falls back to
              send-only rather than offering a control that cannot work. */}
          <button
            onClick={hasText ? handleSend : (canRecord ? handleMicClick : undefined)}
            disabled={uploading || (!hasText && !canRecord)}
            aria-label={hasText ? 'Send message' : 'Record voice message'}
            title={hasText ? 'Send' : (canRecord ? 'Record voice message' : (micSupported ? 'Voice messages are turned off for your account' : 'Recording is not supported in this browser'))}
            data-testid={hasText ? 'message-send-btn' : 'voice-record-btn'}
            className={`p-2.5 rounded-full flex-shrink-0 mb-0.5 transition-all duration-150 ${
              uploading
                ? 'text-[#A3A3A3]'
                : hasText
                  ? 'bg-[#10B981] text-white hover:bg-[#059669] active:scale-[0.95]'
                  : 'text-[#A3A3A3] hover:text-[#F5F5F5] disabled:opacity-40'
            }`}
          >
            {uploading ? <Loader2 size={18} className="animate-spin" /> : hasText ? <Send size={18} /> : <Mic size={20} />}
          </button>
        </div>
      </div>
      )}
    </div>
  );
};

/**
 * Memoised: the composer owns a textarea, an emoji picker and file inputs, and
 * none of it depends on the message stream. Before this it re-rendered on every
 * ChatPanel render — roughly 14 times for a single inbound message — purely
 * because it was a child.
 */
export const MessageComposer = memo(MessageComposerInner);
