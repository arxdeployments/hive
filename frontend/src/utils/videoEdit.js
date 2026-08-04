/**
 * Cropping a video in the browser, before it is sent.
 *
 * ## Why this is a re-encode and not a transform
 *
 * A cropped image is one `drawImage` into a smaller canvas. A cropped video has
 * to have every frame redrawn and the result re-compressed, and the browser
 * gives exactly three ways to do that:
 *
 *   ffmpeg.wasm   — ruled out by the app's own CSP. `script-src 'self'` carries
 *                   no `'wasm-unsafe-eval'`, which is the same constraint that
 *                   ruled out pdf.js (see PdfViewer.jsx) and a wasm HEIC decoder
 *                   (see mediaQuality.js:28). It also spawns a blob-URL worker,
 *                   and nginx.conf sets no `worker-src`, so those fall back to
 *                   `default-src 'self'` and are blocked too. Relaxing the CSP
 *                   for a crop would reverse two decisions this repo has already
 *                   written down.
 *   WebCodecs     — decodes and encodes, but does NOT mux: it hands back raw
 *                   `EncodedVideoChunk`s. Putting them in an MP4 means owning a
 *                   muxer, which is where this should eventually go — it is
 *                   faster than real time, writes a proper `moov`, and can pass
 *                   the source's AAC through untouched so audio cannot drift.
 *                   It is a bigger piece of work than the feature warrants today.
 *   canvas +      — what this file does. Play the clip, draw each frame through
 *   MediaRecorder   the same edit transform the image editor uses, capture the
 *                   canvas as a stream, and record it.
 *
 * ## MP4 or nothing
 *
 * `MediaRecorder` will happily produce WebM, the server classifies `.webm` as
 * video, and it would play in the browser — so this looks like a safe fallback
 * and is not. Every video in the iOS client goes through `AVPlayer`
 * (ios/RxHive/Features/Media/MediaAttachmentViews.swift), and AVFoundation
 * cannot decode VP8 or VP9 at all. A crop performed in Firefox would produce a
 * clip that is permanently unplayable for every iPhone user in the org, with
 * nothing on screen to say why.
 *
 * WebM's second problem is that MediaRecorder writes an unknown-size segment, so
 * the result's `duration` is `Infinity` — which is exactly what
 * `utils/videoPoster.js` refuses to work with, and the server generates no video
 * posters at all (`backend/app/api/media.py:144`), so the client-side one is the
 * only one there is.
 *
 * So the container ladder is MP4-only and `videoEditSupport()` reports
 * unsupported rather than falling back. This is the same shape as
 * `utils/audioFormat.js`, which returns null to HIDE the mic instead of
 * recording something the app cannot use.
 *
 * ## The honest cost, stated up front
 *
 * MediaRecorder records WALL CLOCK. A 40-second clip takes 40 seconds to crop,
 * and playing it faster would produce a 40-second clip played fast rather than a
 * shorter wait. The UI shows a determinate bar with an estimate and a working
 * Cancel, and the button says what it is about to do.
 *
 * Because the frame pump is driven by `requestVideoFrameCallback`/
 * `requestAnimationFrame`, both of which stop when the tab is hidden while the
 * recorder keeps muxing, hiding the tab mid-encode would silently produce a clip
 * of frozen frames padded to the full duration. That is detected and aborted
 * rather than shipped.
 *
 * ## What it does NOT do
 *
 * Drawing and text are image-only. They would ride along for free on this
 * pipeline, but annotating a video means promising scrubbing and keyframes — a
 * different feature. `MediaEditor` opens a video in Crop mode only, and the Draw
 * and Text tools are absent rather than present and inert.
 *
 * The geometry is shared with the image path: `applyEditTransform` and
 * `outputPixelSize` from mediaEdit.js. That is deliberate — a video cropped to
 * the rect the user dragged must come out matching the still they dragged it on,
 * and two implementations of one transform would not stay matching for long.
 */

import { applyEditTransform, createCanvas, outputPixelSize } from './mediaEdit';

/** Long edge, in pixels, a cropped clip is fitted inside. Never upscales. */
export const VIDEO_MAX_EDGE = 1920;

/**
 * Longest clip that may be cropped.
 *
 * Not an arbitrary limit: the encode is real time and needs the tab to stay
 * visible for its whole duration, so offering it on a ten-minute clip would be
 * offering a ten-minute hostage situation. Past this the clip sends uncropped,
 * which is what happens today anyway.
 */
export const VIDEO_CROP_MAX_SECONDS = 180;

/** Frames per second the canvas is captured at. */
const CAPTURE_FPS = 30;

/**
 * Containers to try, best first — MP4 only, for the reasons in the header.
 *
 * The explicit codec string first because `isTypeSupported('video/mp4')` alone
 * returns true on engines that then pick a profile the iOS decoder dislikes.
 */
const CANDIDATE_TYPES = [
  { mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', extension: 'mp4' },
  { mimeType: 'video/mp4;codecs=avc1', extension: 'mp4' },
  { mimeType: 'video/mp4', extension: 'mp4' },
];

/**
 * Can this browser crop a video at all, and into what?
 *
 * Called before the Crop tool is offered, so a browser that cannot do it says so
 * instead of offering a control that fails after the user has done the work.
 */
export function videoEditSupport() {
  if (typeof MediaRecorder === 'undefined') {
    return { supported: false, reason: 'This browser cannot re-encode video, so a clip can only be sent as it is.' };
  }
  if (typeof HTMLCanvasElement === 'undefined'
    || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    return { supported: false, reason: 'This browser cannot capture a canvas as video, so a clip can only be sent as it is.' };
  }
  const match = CANDIDATE_TYPES.find((candidate) => {
    try {
      return MediaRecorder.isTypeSupported(candidate.mimeType);
    } catch {
      return false;
    }
  });
  if (!match) {
    // Deliberately not falling back to WebM — see the header. Firefox lands here.
    return {
      supported: false,
      reason: 'This browser can only record video in a format iPhones cannot play, so cropping is turned off here. Chrome, Edge or Safari can crop it.',
    };
  }
  return { supported: true, ...match };
}

/**
 * Roughly how long cropping will take, in seconds.
 *
 * The clip's own length plus a little for setup and flush, because the encode is
 * real time. Shown before the user commits, since "this will take about a
 * minute" is the whole reason they might choose not to.
 */
export function estimateCropSeconds(durationSeconds) {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.ceil(durationSeconds + 2);
}

/** Encoder bitrate for an output of this size. */
function bitrateFor(width, height) {
  const raw = width * height * CAPTURE_FPS * 0.08;
  return Math.round(Math.min(12_000_000, Math.max(1_500_000, raw)));
}

/**
 * H.264 requires even dimensions in both axes.
 *
 * Evened on the UNROTATED box, with the rotated size re-derived from it, so the
 * transform `applyEditTransform` builds still agrees with the canvas it draws
 * into — rounding the final width and height independently would leave a
 * one-pixel disagreement that shows up as a sliver of empty canvas along an edge.
 */
function evenOutput(base, quarterTurned) {
  const uw = Math.max(2, base.unrotatedWidth - (base.unrotatedWidth % 2));
  const uh = Math.max(2, base.unrotatedHeight - (base.unrotatedHeight % 2));
  return {
    scale: base.scale,
    unrotatedWidth: uw,
    unrotatedHeight: uh,
    width: quarterTurned ? uh : uw,
    height: quarterTurned ? uw : uh,
  };
}

/**
 * Best-effort "does this clip have sound?", so a silent track is not invented.
 *
 * Only ever used as POSITIVE evidence. `webkitAudioDecodedByteCount` is 0 until
 * playback has actually decoded something, and this runs before play() — reading
 * that zero as "no audio" would strip the soundtrack from every clip cropped in
 * Safari, which is the one engine where it is available.
 */
function probablyHasAudio(video) {
  if (typeof video.mozHasAudio === 'boolean') return video.mozHasAudio;
  if (video.audioTracks && typeof video.audioTracks.length === 'number') {
    return video.audioTracks.length > 0;
  }
  if (typeof video.webkitAudioDecodedByteCount === 'number'
    && video.webkitAudioDecodedByteCount > 0) {
    return true;
  }
  // Unknown: route it. A silent track costs a few hundred bytes; a dropped
  // soundtrack is the user's voice gone from a clip they just cropped.
  return true;
}

/**
 * Crop, rotate and flip a video, returning a new `File`.
 *
 * `edit` is the same model the image editor produces — only `crop`, `rotation`,
 * `flipH` and `flipV` are read; strokes and texts are ignored by design.
 *
 * `onProgress` is called with 0..1. `signal` aborts, and aborting really stops
 * the encode and the playback rather than only hiding the bar.
 *
 * Returns the measured source `duration` alongside the file. The caller should
 * carry it to the send, because MediaRecorder's fragmented MP4 does not always
 * expose a readable duration and `extractVideoPoster` would then report none —
 * costing the bubble its duration badge for a value we already know exactly.
 */
export async function renderCroppedVideo(file, edit, options = {}) {
  const support = videoEditSupport();
  if (!support.supported) throw new Error(support.reason);

  const { onProgress, signal } = options;
  const maxEdge = options.maxEdge ?? VIDEO_MAX_EDGE;

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.playsInline = true;
  video.preload = 'auto';
  // NOT `muted`. The element's audio is rerouted into the WebAudio graph below
  // and never reaches the speakers, and muting would silence the graph too on
  // several engines — which would strip the soundtrack from every cropped clip.
  video.crossOrigin = 'anonymous';

  let audioContext = null;
  let recorder = null;
  let stream = null;
  let frameHandle = null;
  let rafHandle = null;
  let watchdog = null;
  let abortPoll = null;
  let onVisibilityChange = null;

  const cleanup = () => {
    if (frameHandle && typeof video.cancelVideoFrameCallback === 'function') {
      video.cancelVideoFrameCallback(frameHandle);
    }
    if (rafHandle) cancelAnimationFrame(rafHandle);
    if (watchdog) clearTimeout(watchdog);
    if (abortPoll) clearInterval(abortPoll);
    if (onVisibilityChange) document.removeEventListener('visibilitychange', onVisibilityChange);
    try { video.pause(); } catch { /* already detached */ }
    video.removeAttribute('src');
    try { video.load(); } catch { /* Safari throws on a detached element */ }
    stream?.getTracks().forEach((track) => track.stop());
    audioContext?.close().catch(() => {});
    URL.revokeObjectURL(url);
  };

  try {
    await new Promise((resolve, reject) => {
      video.addEventListener('loadedmetadata', () => resolve(), { once: true });
      video.addEventListener(
        'error',
        () => reject(new Error('This clip could not be opened for cropping')),
        { once: true }
      );
    });

    const sourceWidth = video.videoWidth;
    const sourceHeight = video.videoHeight;
    if (!sourceWidth || !sourceHeight) {
      throw new Error('This clip has no video track to crop');
    }

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    if (!duration) {
      // Refused, not attempted.
      //
      // Without a duration, three things fail together and the failure is invisible:
      // the length limit below cannot be applied, `onProgress` has nothing to divide
      // by so the bar sits at 0%, and the watchdog falls back to a flat two minutes —
      // which for a longer clip means the recorder is stopped mid-way and the
      // TRUNCATED result is returned as a success. A clip that arrives uncropped is a
      // far better outcome than one that silently loses its second half.
      throw new Error(
        'This clip does not report its length, so it cannot be cropped here. It can still be sent as it is.'
      );
    }
    if (duration > VIDEO_CROP_MAX_SECONDS) {
      throw new Error(
        `Cropping re-encodes in real time, so it is limited to ${Math.round(VIDEO_CROP_MAX_SECONDS / 60)} minutes. This clip can still be sent as it is.`
      );
    }

    const quarterTurned = ((Math.round((edit?.rotation || 0) / 90) * 90) % 180) !== 0;
    const output = evenOutput(
      outputPixelSize(sourceWidth, sourceHeight, edit, maxEdge),
      quarterTurned
    );

    const canvas = createCanvas(output.width, output.height);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser could not prepare the cropped clip');

    stream = canvas.captureStream(CAPTURE_FPS);

    if (probablyHasAudio(video)) {
      // Wrapped: a clip with no decodable audio makes createMediaElementSource
      // throw on some engines, and losing the crop over a missing soundtrack
      // would be the wrong trade.
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) {
          audioContext = new AudioCtx();
          // Reached from a click (Save), so the autoplay gesture is still in scope.
          if (audioContext.state === 'suspended') await audioContext.resume();
          const source = audioContext.createMediaElementSource(video);
          const destination = audioContext.createMediaStreamDestination();
          // Connected ONLY to the destination node, never to
          // audioContext.destination — that is what keeps the encode silent in
          // the room while still recording the sound.
          source.connect(destination);
          destination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
        }
      } catch {
        // Video-only output. Better than no crop.
      }
    }

    recorder = new MediaRecorder(stream, {
      mimeType: support.mimeType,
      videoBitsPerSecond: bitrateFor(output.width, output.height),
    });

    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    let failure = null;
    const finished = new Promise((resolve) => {
      recorder.onstop = () => resolve();
      recorder.onerror = (event) => {
        failure = event?.error || new Error('Recording the cropped clip failed');
        resolve();
      };
    });

    let aborted = false;
    const stopEverything = () => {
      aborted = true;
      try { video.pause(); } catch { /* nothing to pause */ }
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    };
    if (signal) {
      if (signal.aborted) throw abortError();
      signal.addEventListener('abort', stopEverything, { once: true });
    }

    // Backgrounding the tab stalls the frame pump but not the muxer, so the
    // output would be frozen frames padded to full length. Refuse it out loud.
    onVisibilityChange = () => {
      if (document.hidden && !aborted) {
        failure = new Error('Cropping stopped because this tab went to the background. Keep it visible and try again.');
        stopEverything();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const drawFrame = () => {
      ctx.save();
      // Opaque fill first: a frame the transform does not fully cover reads as
      // black letterboxing rather than as the previous frame smeared.
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, output.width, output.height);
      applyEditTransform(ctx, sourceWidth, sourceHeight, edit, output);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(video, 0, 0, sourceWidth, sourceHeight);
      ctx.restore();
      if (onProgress && duration) {
        onProgress(Math.min(1, video.currentTime / duration));
      }
    };

    const pump = () => {
      if (aborted || video.ended) return;
      drawFrame();
      if (typeof video.requestVideoFrameCallback === 'function') {
        frameHandle = video.requestVideoFrameCallback(pump);
      } else {
        rafHandle = requestAnimationFrame(pump);
      }
    };

    // First frame before the recorder starts, so the output never opens on a
    // blank canvas — captureStream emits whatever is on it at t=0.
    if (video.currentTime !== 0) {
      video.currentTime = 0;
      await new Promise((resolve) => video.addEventListener('seeked', resolve, { once: true }));
    }
    drawFrame();

    // A 250ms timeslice rather than one blob at the end: the recorder flushes as
    // it goes, so a long clip is not held in memory as a single buffer.
    recorder.start(250);

    const ended = new Promise((resolve) => {
      video.addEventListener('ended', resolve, { once: true });
    });
    const stopped = new Promise((resolve) => {
      // An abort — Cancel, or the tab going to the background — never fires
      // `ended`, so the race below needs a second way to settle. Cleared in
      // `cleanup` for the ordinary path, where it never fires at all.
      abortPoll = setInterval(() => {
        if (aborted) { clearInterval(abortPoll); abortPoll = null; resolve(); }
      }, 120);
    });

    await video.play();
    pump();

    // `ended` does not always fire for a blob source whose duration metadata is
    // slightly short of its real length. Without this the promise never settles and
    // the editor sits at 99% forever. Generous, because firing it early truncates
    // the clip — and `duration` is guaranteed finite by the guard above.
    const watchdogMs = duration * 1000 + 8000;
    const timedOut = new Promise((resolve) => { watchdog = setTimeout(resolve, watchdogMs); });

    await Promise.race([ended, stopped, timedOut]);

    if (!aborted) {
      // One last frame so the final moment of the clip is present, then flush.
      drawFrame();
      if (recorder.state !== 'inactive') recorder.stop();
    }
    await finished;

    if (failure) throw failure;
    if (aborted) throw abortError();
    if (chunks.length === 0) {
      throw new Error('Cropping produced no video — this browser may not be able to re-encode that clip.');
    }

    const blob = new Blob(chunks, { type: support.mimeType });
    const base = (file.name || 'video').replace(/\.[^.]+$/, '');
    // The extension is the ONLY thing that decides the stored MIME type and the
    // bubble that renders it (backend/app/api/media.py:104,133), so `.mp4` here
    // is load-bearing, not cosmetic.
    const cropped = new File([blob], `${base}.${support.extension}`, {
      type: support.mimeType.split(';')[0],
      lastModified: Date.now(),
    });

    onProgress?.(1);
    return { file: cropped, width: output.width, height: output.height, duration };
  } finally {
    cleanup();
  }
}

/**
 * The shape a cancel throws.
 *
 * `AbortError` is the name the platform uses for a user-initiated stop, so the
 * editor can tell "you pressed Cancel" apart from "the encode failed" without a
 * second flag.
 */
function abortError() {
  const err = new Error('Cropping was cancelled');
  err.name = 'AbortError';
  return err;
}
