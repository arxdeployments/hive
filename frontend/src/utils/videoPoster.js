/**
 * Poster frames and durations pulled out of a video, client-side.
 *
 * The upload service only thumbnails images and PDFs (backend media.py builds a
 * thumbnail for file_type == "image" or application/pdf and nothing else), so
 * every video in the system arrives with thumbnail_url null. Left alone that
 * gives a black rectangle in the thread and an anonymous grey tile in the
 * gallery — every clip in a conversation looking identical.
 *
 * Both numbers come from the same offscreen <video>, because loading one is the
 * expensive part and it yields both.
 *
 * WHY 0.5s AND NOT FRAME ZERO. The first frame of a phone recording is very
 * often black or half-exposed — the sensor is still settling. iOS makes the same
 * choice for the same reason (MediaAttachmentViews VideoFrameThumbnail seeks to
 * 0.5s, MediaQuality.videoPoster to 0.15s for the pre-send case, where the file
 * is local and latency matters more).
 *
 * Same-origin only, which is what makes the canvas readable: /api/media/{id}
 * 307-redirects to storage and the app deliberately keeps that redirect
 * same-origin (see storage.rewrite_to_public). A cross-origin frame would taint
 * the canvas and toBlob would throw, so every failure here resolves to null and
 * the caller falls back to what it did before.
 */

const POSTER_SEEK_SECONDS = 0.5;
const POSTER_MAX_EDGE = 720;
// A poster is worth a couple of seconds of wait, not a hung tile. Mobile Safari
// in particular will refuse to load a video's data at all while the tab is
// backgrounded, and without a timeout that leaves a promise pending forever.
const LOAD_TIMEOUT_MS = 8000;

/** In-memory, keyed by source URL. Scrolling back through a thread is free. */
const posterCache = new Map();
const inflight = new Map();

/**
 * Grab a frame and the duration from a video URL or File/Blob.
 * @returns {Promise<{posterUrl: string|null, duration: number|null}>}
 */
export async function extractVideoPoster(source) {
  const isBlobSource = typeof source !== 'string';
  const key = isBlobSource ? null : source;

  if (key && posterCache.has(key)) return posterCache.get(key);
  // Two bubbles showing the same clip must not each decode it.
  if (key && inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    const objectUrl = isBlobSource ? URL.createObjectURL(source) : null;
    const video = document.createElement('video');
    let result = { posterUrl: null, duration: null };

    try {
      video.preload = 'metadata';
      video.muted = true;
      // Required or iOS Safari takes over the screen the moment data loads.
      video.playsInline = true;
      // Only meaningful for the remote case; harmless for a blob.
      if (!isBlobSource) video.crossOrigin = 'use-credentials';
      video.src = objectUrl || source;

      const ready = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
        const done = (ok) => { clearTimeout(timer); resolve(ok); };
        video.onloadedmetadata = () => done(true);
        video.onerror = () => done(false);
      });
      if (!ready) return result;

      // Duration first: it survives even when the frame grab fails, and it is
      // the half the duration badge needs. Streaming containers report
      // Infinity/NaN, which is why this is guarded rather than trusted.
      const d = video.duration;
      result.duration = Number.isFinite(d) && d > 0 ? d : null;

      // Seek before the end for a very short clip, or the seek never completes.
      const target = Math.min(POSTER_SEEK_SECONDS, Math.max(0, (result.duration || 1) - 0.05));
      const seeked = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
        video.onseeked = () => { clearTimeout(timer); resolve(true); };
        video.onerror = () => { clearTimeout(timer); resolve(false); };
        try { video.currentTime = target; } catch { clearTimeout(timer); resolve(false); }
      });
      if (!seeked || !video.videoWidth) return result;

      const scale = Math.min(1, POSTER_MAX_EDGE / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return result;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      // Throws on a tainted canvas rather than returning null, hence the try.
      const blob = await new Promise((resolve) => {
        try { canvas.toBlob(resolve, 'image/jpeg', 0.8); } catch { resolve(null); }
      });
      if (blob) result.posterUrl = URL.createObjectURL(blob);
      return result;
    } catch {
      return result;
    } finally {
      // Detach the source or Chrome keeps the whole decode pipeline alive.
      video.removeAttribute('src');
      video.load();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (key) {
        posterCache.set(key, result);
        inflight.delete(key);
      }
    }
  })();

  if (key) inflight.set(key, run);
  return run;
}

/** m:ss, matching utils/audioFormat.formatDuration and the iOS clockLabel. */
export function formatVideoDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return `${m}:${ss}`;
}
