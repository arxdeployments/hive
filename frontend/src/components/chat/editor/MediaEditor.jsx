import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Check, Crop, History, Loader2, Pencil, Type, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  DEFAULT_INK,
  DEFAULT_PEN_KEY,
  emptyEdit,
  hasEdits,
  loadEditableImage,
  pruneEmptyTexts,
  renderEditedFile,
} from '../../../utils/mediaEdit';
import {
  VIDEO_CROP_MAX_SECONDS,
  estimateCropSeconds,
  renderCroppedVideo,
  videoEditSupport,
} from '../../../utils/videoEdit';
import { CropStage } from './CropStage';
import { AnnotateStage } from './AnnotateStage';
import { ToolButton } from './editorKit';

/**
 * The pre-send media editor.
 *
 * Opened from a staged attachment — from a tile in the confirmation tray or from
 * the full-size staged preview — and it never touches the network: it takes the
 * ORIGINAL bytes plus an edit model, and hands back new bytes plus the model that
 * produced them. Nothing has been uploaded at this point, which is what makes
 * Cancel free and Revert exact.
 *
 * ## Why the original is what gets edited, every time
 *
 * The item keeps its untouched original for as long as it is staged, and the
 * editor always opens on `original + model`. So:
 *
 *   - re-opening shows the crop handles where they were left and the strokes
 *     still live, and the user can keep refining instead of starting over;
 *   - "Revert to original" is `emptyEdit()`, not an inverse transform;
 *   - a crop tightened twice never compounds JPEG generations, because the second
 *     pass re-renders from the original rather than from the first pass's output.
 *
 * ## Video
 *
 * Crop, rotate and flip only, and only where the browser can record MP4 — see
 * `utils/videoEdit.js` for why WebM is not an acceptable fallback and why the
 * encode is real time. Drawing and text are image-only, so those two tools are
 * absent for a clip rather than present and inert.
 *
 * ## Layering
 *
 * `z-[1000]`, joining the app's full-screen-media tier alongside
 * `FullscreenImageViewer` and `PdfViewer`, so it sits above the staged preview at
 * `z-[70]` — and deliberately below the call surfaces at `z-[9998]`, because an
 * incoming call must never end up behind a crop rectangle. Portalled to
 * `document.body` for the reason `PdfViewer` and `FullscreenVideoViewer` are: an
 * ancestor with a transform becomes the containing block for `position: fixed`,
 * and the composer sits inside animated parents.
 */

const MAX_HISTORY = 40;

export const MediaEditor = ({ item, onSave, onClose }) => {
  const isVideo = item.category === 'video';

  const [edit, setEdit] = useState(() => item.edit || emptyEdit());
  const [history, setHistory] = useState([]);
  const [mode, setMode] = useState('crop');
  const [source, setSource] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(null);
  const [aspectKey, setAspectKey] = useState('free');
  const [ink, setInk] = useState(DEFAULT_INK);
  const [penKey, setPenKey] = useState(DEFAULT_PEN_KEY);
  const [selectedTextId, setSelectedTextId] = useState(null);

  const abortRef = useRef(null);
  const savingRef = useRef(false);

  /** The bytes every render starts from — never the previously saved output. */
  const original = item.originalFile || item.file;

  const videoSupport = useMemo(() => (isVideo ? videoEditSupport() : { supported: true }), [isVideo]);

  // ── Load the still the editor works on ────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    let cleanup = null;

    const load = async () => {
      if (isVideo) {
        // The video ELEMENT is the drawable: `drawImage` accepts one, so a poster
        // frame does not have to be encoded to a blob and decoded again just to
        // put a still behind the crop rectangle.
        const url = URL.createObjectURL(original);
        const video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        cleanup = () => {
          video.removeAttribute('src');
          try { video.load(); } catch { /* Safari throws on a detached element */ }
          URL.revokeObjectURL(url);
        };
        try {
          await new Promise((resolve, reject) => {
            video.addEventListener('loadeddata', resolve, { once: true });
            video.addEventListener('error', () => reject(new Error('This clip could not be opened')), { once: true });
          });
          // A hair in, not zero: the first frame of a phone recording is often
          // the sensor still settling, and a black still looks like a failure.
          const at = Math.min(0.15, (video.duration || 1) / 2);
          if (Number.isFinite(at) && at > 0) {
            video.currentTime = at;
            await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
          }
          if (cancelled) return;
          setSource({
            image: video,
            width: video.videoWidth,
            height: video.videoHeight,
            duration: Number.isFinite(video.duration) ? video.duration : null,
            release: cleanup,
          });
          cleanup = null;
        } catch (err) {
          if (!cancelled) setLoadError(err.message || 'This clip could not be opened');
        }
        return;
      }

      try {
        const loaded = await loadEditableImage(original);
        if (cancelled) { loaded.release?.(); return; }
        setSource(loaded);
      } catch (err) {
        if (!cancelled) setLoadError(err.message || 'This image could not be opened for editing');
      }
    };

    load();
    return () => {
      cancelled = true;
      cleanup?.();
    };
    // `original` is a stable File for the lifetime of this editor.
  }, [original, isVideo]);

  // Release the decoded still when the editor closes, so a batch of ten photos
  // edited one after another does not accumulate ten bitmaps.
  const sourceRef = useRef(null);
  sourceRef.current = source;
  useEffect(() => () => { sourceRef.current?.release?.(); }, []);

  // ── History ───────────────────────────────────────────────────────────────

  const pushHistory = useCallback(() => {
    setEdit((current) => {
      setHistory((stack) => [...stack, current].slice(-MAX_HISTORY));
      return current;
    });
  }, []);

  const undo = useCallback(() => {
    setHistory((stack) => {
      if (stack.length === 0) return stack;
      setEdit(stack[stack.length - 1]);
      setSelectedTextId(null);
      return stack.slice(0, -1);
    });
  }, []);

  const revert = useCallback(() => {
    pushHistory();
    setEdit(emptyEdit());
    setAspectKey('free');
    setSelectedTextId(null);
  }, [pushHistory]);

  // ── Escape, and the keyboard ──────────────────────────────────────────────

  useEffect(() => {
    const onKey = (event) => {
      // A live caret owns its own keys. Escape should dismiss the caret, not the
      // editor, and Cmd/Ctrl+Z should be the textarea's own undo — stealing it would
      // roll the whole model back to before the box existed instead of fixing a typo.
      const inField = event.target
        && (event.target.tagName === 'TEXTAREA' || event.target.tagName === 'INPUT');

      if (event.key === 'Escape') {
        if (inField) return;
        // Capture phase on `window`, matching StagedFilePreview and the three media
        // viewers.
        //
        // Neither stop below is what keeps Escape from also closing the staged preview
        // underneath — it registers its listener BEFORE this one and listeners on a
        // single target fire in registration order, so by the time this runs the
        // preview has already acted. That is fixed at the source: MessageComposer
        // passes `keysSuspended` while the editor is open and the preview installs no
        // listener at all. These remain as defence for any layer that registers later.
        event.stopImmediatePropagation();
        event.stopPropagation();
        event.preventDefault();
        if (saving) {
          abortRef.current?.abort();
        } else {
          onClose();
        }
      } else if (!inField && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.stopPropagation();
        event.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, undo, saving]);

  /**
   * Abort a running video encode if the editor goes away underneath it.
   *
   * `renderCroppedVideo` only stops early when its signal fires; otherwise it plays
   * the clip to the end with a live MediaRecorder, a playing `<video>` and an
   * AudioContext. Unmounting can happen without a Cancel — ChatPanel is swapped at
   * the 768px breakpoint, and the conversation can change under the composer — and
   * the encode would otherwise run to completion, silently, with nowhere to deliver
   * its result.
   */
  useEffect(() => () => { abortRef.current?.abort(); }, []);

  // ── Save ──────────────────────────────────────────────────────────────────

  const save = async () => {
    if (savingRef.current) return;
    if (!source) return;

    // A box the user opened and never typed into is not an edit — see pruneEmptyTexts.
    const model = pruneEmptyTexts(edit);

    // Nothing to bake. Hand back the original so a save with no edits cannot
    // silently re-encode a photo — and so the item stops being marked as edited.
    if (!hasEdits(model)) {
      onSave({ file: original, edit: emptyEdit(), duration: item.editedDuration ?? null });
      return;
    }

    savingRef.current = true;
    setSaving(true);
    setProgress(isVideo ? 0 : null);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      if (isVideo) {
        const result = await renderCroppedVideo(original, model, {
          signal: controller.signal,
          onProgress: setProgress,
        });
        onSave({ file: result.file, edit: model, duration: result.duration });
      } else {
        const result = await renderEditedFile(original, model, { loaded: source });
        onSave({ file: result.file, edit: model, duration: null });
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        // The user asked for it; nothing to report.
      } else {
        toast.error(err?.message || 'The edit could not be saved');
      }
    } finally {
      abortRef.current = null;
      savingRef.current = false;
      setSaving(false);
      setProgress(null);
    }
  };

  // ── Chrome ────────────────────────────────────────────────────────────────

  const edited = hasEdits(edit);
  const cropSeconds = isVideo && source?.duration ? estimateCropSeconds(source.duration) : null;
  const tooLong = isVideo && source?.duration && source.duration > VIDEO_CROP_MAX_SECONDS;
  const cropBlocked = isVideo && (!videoSupport.supported || tooLong);
  /**
   * A GIF cannot survive this.
   *
   * Cropping an animation with a canvas means picking one frame, and there is no
   * way around that short of a GIF encoder. `transcodeImage` refuses to touch
   * GIFs at all for exactly this reason — so rather than silently flattening one,
   * say what will happen while the user can still back out.
   */
  const flattensAnimation = !isVideo
    && (/^image\/gif$/i.test(original.type || '') || /\.gif$/i.test(original.name || ''));

  const body = (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[1000] bg-black/95 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${item.name}`}
      data-testid="media-editor"
    >
      {/* Top bar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-3 bg-gradient-to-b from-black/80 to-transparent">
        <ToolButton
          icon={X}
          label="Close without saving"
          onClick={saving ? () => abortRef.current?.abort() : onClose}
          testId="media-editor-close"
        />

        <div className="flex-1 flex items-center justify-center gap-1.5">
          <ToolButton
            icon={Crop}
            label="Crop, rotate and flip"
            active={mode === 'crop'}
            onClick={() => setMode('crop')}
            disabled={saving || cropBlocked}
            testId="media-editor-tool-crop"
          />
          {!isVideo && (
            <>
              <ToolButton
                icon={Pencil}
                label="Draw"
                active={mode === 'draw'}
                onClick={() => setMode('draw')}
                disabled={saving}
                testId="media-editor-tool-draw"
              />
              <ToolButton
                icon={Type}
                label="Add text"
                active={mode === 'text'}
                onClick={() => setMode('text')}
                disabled={saving}
                testId="media-editor-tool-text"
              />
            </>
          )}
        </div>

        <ToolButton
          icon={Undo2}
          label="Undo"
          onClick={undo}
          disabled={saving || history.length === 0}
          testId="media-editor-undo"
        />
        {/* Only offered when there is something to revert, so it never reads as a
            button that does nothing. */}
        {edited && (
          <ToolButton
            icon={History}
            label="Revert to the original"
            onClick={revert}
            disabled={saving}
            testId="media-editor-revert"
          />
        )}
        <button
          type="button"
          onClick={save}
          disabled={saving || !source}
          aria-busy={saving}
          aria-label={saving ? 'Saving' : 'Save and use this version'}
          data-testid="media-editor-save"
          className="ml-1 h-9 px-4 rounded-full bg-[#10B981] text-[#0A0A0A] text-[13px] font-semibold flex items-center gap-1.5 hover:bg-[#059669] disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 size={15} className="animate-spin" /> : <Check size={16} />}
          {saving ? 'Saving' : 'Done'}
        </button>
      </div>

      {/* Body */}
      {loadError ? (
        <div className="flex-1 min-h-0 flex items-center justify-center px-8">
          <p className="text-sm text-[#A3A3A3] text-center max-w-sm">{loadError}</p>
        </div>
      ) : !source ? (
        <div className="flex-1 min-h-0 flex items-center justify-center">
          <Loader2 size={22} className="animate-spin text-[#10B981]" />
        </div>
      ) : mode === 'crop' ? (
        <CropStage
          image={source.image}
          sourceWidth={source.width}
          sourceHeight={source.height}
          edit={edit}
          onEdit={setEdit}
          onCommit={pushHistory}
          aspectKey={aspectKey}
          onAspectKey={setAspectKey}
        />
      ) : (
        <AnnotateStage
          image={source.image}
          sourceWidth={source.width}
          sourceHeight={source.height}
          edit={edit}
          onEdit={setEdit}
          onCommit={pushHistory}
          tool={mode}
          ink={ink}
          onInk={setInk}
          penKey={penKey}
          onPenKey={setPenKey}
          selectedId={selectedTextId}
          onSelect={setSelectedTextId}
        />
      )}

      {flattensAnimation && !loadError && (
        <div className="flex-shrink-0 px-4 pb-3">
          <p className="text-[11px] text-[#F59E0B]" data-testid="media-editor-gif-note">
            Editing a GIF saves a single still frame — close without saving to send it animated.
          </p>
        </div>
      )}

      {/* What a video crop is about to cost, said before it is spent — and while
          it is being spent, a determinate bar with a working Cancel. */}
      {isVideo && !loadError && (
        <div className="flex-shrink-0 px-4 pb-3">
          {cropBlocked ? (
            <p className="text-[11px] text-[#A3A3A3]" data-testid="media-editor-video-blocked">
              {tooLong
                ? `Cropping re-encodes in real time, so it is limited to ${Math.round(VIDEO_CROP_MAX_SECONDS / 60)} minutes. This clip can still be sent as it is.`
                : videoSupport.reason}
            </p>
          ) : saving ? (
            <div className="flex items-center gap-3">
              <div className="flex-1 h-1 bg-[#1A1A1A] rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#10B981] transition-all"
                  style={{ width: `${Math.round((progress || 0) * 100)}%` }}
                  data-testid="media-editor-video-progress"
                />
              </div>
              <span className="text-[11px] text-[#A3A3A3] tabular-nums w-9 text-right">
                {Math.round((progress || 0) * 100)}%
              </span>
              <span className="text-[11px] text-[#525252]">keep this tab open</span>
            </div>
          ) : (
            <p className="text-[11px] text-[#525252]">
              Cropping re-encodes the clip in real time
              {cropSeconds ? ` — about ${cropSeconds}s` : ''}, and needs this tab to stay visible.
              Drawing and text are for photos only.
            </p>
          )}
        </div>
      )}
    </motion.div>
  );

  return createPortal(body, document.body);
};

export default MediaEditor;
