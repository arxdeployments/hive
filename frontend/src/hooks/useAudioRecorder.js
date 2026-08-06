import { useCallback, useEffect, useRef, useState } from 'react';
import { micErrorMessage, pickAudioFormat } from '../utils/audioFormat';

/**
 * Voice-note recorder.
 *
 * States: 'idle' -> 'recording' <-> 'paused' -> 'preview'.
 *
 * PAUSED is the review stage. MediaRecorder.pause()/resume() keeps ONE recorder
 * and one chunk array alive, so resuming appends to the same take rather than
 * producing a second file that would then have to be concatenated — which is not
 * generally possible for webm/mp4 without a remux. The user can therefore listen
 * back mid-recording and carry on, and Send still uploads a single continuous
 * file.
 *
 * The paused preview is built from the chunks captured SO FAR, after a
 * requestData() flush. Chunk 0 carries the container header, so the partial blob
 * is normally playable. It is best-effort: Safari records audio/mp4, whose moov
 * atom is only written on stop, so a partial preview there may refuse to play.
 * That degrades to "cannot preview yet" and never affects the sent file, which
 * is always assembled from a completed stop().
 *
 * cancel() from any non-idle state discards the blob and releases the mic.
 *
 * Elapsed time is measured by WALL CLOCK, not by reading the recorded file.
 * MediaRecorder writes streaming containers with no duration in the header, so
 * `audio.duration` on the result reads Infinity or NaN until a seek hack — the
 * recorded blob simply cannot be asked how long it is. The wall-clock value is
 * also what gets sent to the server, so the bubble can show a length without
 * fetching the audio.
 *
 * Every exit path stops the MediaStream tracks. A live track keeps the browser's
 * recording indicator lit and holds the device against other apps, so leaking one
 * is immediately visible to the user.
 */

/**
 * Below this a press reads as a mis-tap on the mic rather than as a message.
 * Matches iOS AudioRecorder.minimumDuration.
 */
export const MIN_DURATION_SECONDS = 0.6;

export function useAudioRecorder() {
  const [state, setState] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null); // { blob, url, mimeType, extension, duration }
  // Exposed as STATE, not just the ref below: the live waveform needs to mount
  // an AnalyserNode when the stream appears, which means a render.
  const [stream, setStream] = useState(null);

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  // Elapsed excludes paused time: `accumulated` is the total of finished
  // segments, `segmentStart` the wall clock of the live one.
  const accumulatedRef = useRef(0);
  const segmentStartRef = useRef(0);
  const tickRef = useRef(null);
  const formatRef = useRef(null);
  // Set when the user cancels, so the recorder's onstop knows to throw the audio
  // away instead of promoting it to a preview.
  const discardRef = useRef(false);
  // True from the moment we begin acquiring the microphone until the stream is
  // released. `state` cannot do this job — setState('recording') only runs after
  // the getUserMedia await — and neither can streamRef, which is not assigned
  // until that same point. So two clicks inside the device-open window both saw
  // an idle recorder and each opened a stream, and only the second was ever
  // released: the first kept the mic held and the recording indicator lit until
  // reload, kept appending into the shared chunk array, and left its 200ms tick
  // running for the life of the page. Cleared in releaseStream(), which every
  // exit path runs through.
  const micHeldRef = useRef(false);
  // Why the last recording ended with nothing, so the composer can SAY so. The
  // hook used to return silently to idle on three separate paths and the bar
  // just vanished with no explanation.
  const [lastError, setLastError] = useState(null);
  const trackWatcherRef = useRef(null);
  // pause() is defined below but the track watcher is installed above it, so the
  // watcher reaches it through a ref rather than forcing a reorder that would
  // put the pause logic before the state it reads.
  const pauseRef = useRef(null);

  /** Total recorded milliseconds, excluding time spent paused. */
  const elapsedNow = useCallback(
    () => accumulatedRef.current + (segmentStartRef.current ? Date.now() - segmentStartRef.current : 0),
    []
  );

  const startTick = useCallback(
    () => setInterval(() => setElapsed(elapsedNow() / 1000), 200),
    [elapsedNow]
  );

  const releaseStream = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (trackWatcherRef.current) {
      trackWatcherRef.current();
      trackWatcherRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setStream(null);
    recorderRef.current = null;
    micHeldRef.current = false;
  }, []);

  // Unmount mid-recording (closing the chat, navigating away) must not leave the
  // microphone open or leak the preview's object URL.
  const resultRef = useRef(result);
  resultRef.current = result;
  // Unmounting DURING the getUserMedia await is the one case releaseStream
  // cannot reach: streamRef is still null when the cleanup runs, and the stream
  // then arrives into a dead instance that nothing will ever call again. The
  // composer is keyed on the conversation, so switching threads mid-acquisition
  // does exactly this. Set in the body, not just the cleanup, so a StrictMode
  // remount comes back alive.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      releaseStream();
      if (resultRef.current?.url) URL.revokeObjectURL(resultRef.current.url);
    };
  }, [releaseStream]);

  /**
   * The microphone going away underneath a live recording.
   *
   * A browser has no phone-call interruption to listen for, but it has the two
   * events that actually matter: `ended` when the device is unplugged or the
   * permission is revoked, and `mute`/`unmute` when another application seizes
   * the input. Without handling them the wall-clock tick keeps counting against
   * a recorder that has stopped capturing, and the user sends silence — the
   * failure is invisible until after it has been sent.
   *
   * PAUSES rather than cancels, deliberately: throwing away a half-finished
   * message without asking is worse than handing it back paused.
   */
  const watchTrack = useCallback((mediaStream, onLost) => {
    const track = mediaStream.getAudioTracks()[0];
    if (!track) return () => {};
    const lost = () => onLost();
    track.addEventListener('ended', lost);
    track.addEventListener('mute', lost);
    return () => {
      track.removeEventListener('ended', lost);
      track.removeEventListener('mute', lost);
    };
  }, []);

  const start = useCallback(async () => {
    if (micHeldRef.current || state !== 'idle') return { ok: false, error: null };
    const format = pickAudioFormat();
    if (!format) return { ok: false, error: 'Recording is not supported in this browser.' };
    // Claimed synchronously, before the first await, which is the only way to
    // close an async window: a second click cannot land between these lines.
    micHeldRef.current = true;

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Mono and the browser's own cleanup: a voice note does not need stereo,
        // and this roughly halves the bitrate for free.
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      micHeldRef.current = false;
      return { ok: false, error: micErrorMessage(err) };
    }

    // The hook went away while the device was opening — see mountedRef above.
    if (!mountedRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      micHeldRef.current = false;
      return { ok: false, error: null };
    }

    try {
      const recorder = new MediaRecorder(stream, {
        mimeType: format.mimeType,
        // ~4 KB/s. Speech at 32 kbps AAC/Opus is clean, and a 60s note is ~240 KB
        // against a 200 MB server cap.
        audioBitsPerSecond: 32000,
      });

      chunksRef.current = [];
      discardRef.current = false;
      formatRef.current = format;
      setLastError(null);

      // The device going away mid-take pauses the recording rather than letting
      // the timer run on against an input that has stopped capturing.
      trackWatcherRef.current = watchTrack(stream, () => {
        if (recorderRef.current?.state === 'recording') {
          setLastError('device_lost');
          pauseRef.current?.();
        }
      });

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const seconds = elapsedNow() / 1000;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        releaseStream();

        if (discardRef.current) {
          setState('idle');
          setElapsed(0);
          return;
        }
        const blob = new Blob(chunks, { type: format.mimeType });
        if (blob.size === 0) {
          // Nothing captured — a muted device, or stopped before the first chunk.
          setState('idle');
          setElapsed(0);
          setLastError('empty');
          return;
        }
        // Below this a press reads as a mis-tap on the mic rather than as a
        // message. Matters more once hold-to-talk exists, where a stray tap
        // would otherwise send a 200ms note — but it is worth having now, since
        // click-mic-then-immediately-click-finish produces the same thing.
        if (seconds < MIN_DURATION_SECONDS) {
          setState('idle');
          setElapsed(0);
          setLastError('too_short');
          return;
        }
        setResult({
          blob,
          url: URL.createObjectURL(blob),
          mimeType: format.mimeType,
          extension: format.extension,
          duration: seconds,
        });
        setState('preview');
      };

      recorderRef.current = recorder;
      streamRef.current = stream;
      setStream(stream);
      accumulatedRef.current = 0;
      segmentStartRef.current = Date.now();
      setElapsed(0);
      // 1s timeslices so a long recording is not one giant final chunk, which
      // also means a crash mid-recording loses only the last second.
      recorder.start(1000);
      setState('recording');
      tickRef.current = startTick();
      return { ok: true, error: null };
    } catch (err) {
      // MediaRecorder construction can still fail even after isTypeSupported.
      // `recorder.start()` throwing lands here too, by which point streamRef is
      // already assigned — so the claim has to be released explicitly or one
      // failure would disable voice notes for the rest of the session.
      stream.getTracks().forEach((t) => t.stop());
      micHeldRef.current = false;
      return { ok: false, error: micErrorMessage(err) };
    }
  }, [state, releaseStream]);

  /**
   * Pause and build a preview of what has been captured so far.
   *
   * requestData() first: without it the current timeslice is still buffered
   * inside the recorder and the preview would be up to a second short of what
   * the user just said. ondataavailable is synchronous enough in practice, but
   * the blob is assembled on the next tick so the flushed chunk has landed.
   */
  const pause = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'recording') return;

    accumulatedRef.current = elapsedNow();
    segmentStartRef.current = 0;
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    try {
      rec.requestData();
    } catch {
      // Not all implementations allow requestData while recording; the preview
      // is then simply one timeslice behind.
    }
    rec.pause();

    setTimeout(() => {
      const format = formatRef.current;
      if (!format) return;
      const blob = new Blob(chunksRef.current, { type: format.mimeType });
      setResult((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        // A pause before the first chunk landed. Previously this set null and
        // left the bar in `paused` rendering an AudioPlayer with src=undefined
        // beside a live Send button — an empty player you could send.
        return blob.size === 0
          ? null
          : {
              blob,
              url: URL.createObjectURL(blob),
              mimeType: format.mimeType,
              extension: format.extension,
              duration: accumulatedRef.current / 1000,
              // Flags a preview assembled mid-recording. The sent file is always
              // built from a completed stop(), never from this.
              partial: true,
            };
      });
      setElapsed(accumulatedRef.current / 1000);
      setState('paused');
    }, 0);
  }, [elapsedNow]);

  /** Carry on recording into the SAME take. */
  const resume = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state !== 'paused') return;
    // The preview URL is dropped here rather than on the next pause: leaving it
    // alive would let the bar keep showing a player for audio that is now stale.
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    segmentStartRef.current = Date.now();
    rec.resume();
    setState('recording');
    tickRef.current = startTick();
  }, [startTick]);

  /** Finish recording and move to the final preview. */
  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    discardRef.current = false;
    // A paused recorder must be resumed before stop(), or Chrome fires onstop
    // without flushing the final buffered chunk.
    if (rec.state === 'paused') {
      segmentStartRef.current = Date.now();
      rec.resume();
    }
    rec.stop();
  }, []);

  /** Discard: works while recording AND from the preview stage. */
  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      discardRef.current = true;
      // Same reason as stop(): a paused recorder has to be resumed before it
      // will fire onstop reliably.
      if (rec.state === 'paused') rec.resume();
      rec.stop();
      return;
    }
    releaseStream();
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    accumulatedRef.current = 0;
    segmentStartRef.current = 0;
    setState('idle');
    setElapsed(0);
  }, [releaseStream]);

  /** Clear after a successful send, without revoking twice. */
  const reset = useCallback(() => {
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    accumulatedRef.current = 0;
    segmentStartRef.current = 0;
    setState('idle');
    setElapsed(0);
  }, []);

  pauseRef.current = pause;

  return {
    state, elapsed, result, stream, start, pause, resume, stop, cancel, reset,
    /** 'too_short' | 'empty' | 'device_lost' | null — for the composer's toast. */
    lastError,
    clearLastError: useCallback(() => setLastError(null), []),
  };
}

export default useAudioRecorder;
