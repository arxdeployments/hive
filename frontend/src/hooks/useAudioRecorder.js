import { useCallback, useEffect, useRef, useState } from 'react';
import { micErrorMessage, pickAudioFormat } from '../utils/audioFormat';

/**
 * Voice-note recorder.
 *
 * States: 'idle' -> 'recording' -> 'preview' (a finished blob awaiting send).
 * cancel() from either non-idle state discards the blob and releases the mic.
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
export function useAudioRecorder() {
  const [state, setState] = useState('idle');
  const [elapsed, setElapsed] = useState(0);
  const [result, setResult] = useState(null); // { blob, url, mimeType, extension, duration }

  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef(null);
  const formatRef = useRef(null);
  // Set when the user cancels, so the recorder's onstop knows to throw the audio
  // away instead of promoting it to a preview.
  const discardRef = useRef(false);

  const releaseStream = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    recorderRef.current = null;
  }, []);

  // Unmount mid-recording (closing the chat, navigating away) must not leave the
  // microphone open or leak the preview's object URL.
  const resultRef = useRef(result);
  resultRef.current = result;
  useEffect(() => () => {
    releaseStream();
    if (resultRef.current?.url) URL.revokeObjectURL(resultRef.current.url);
  }, [releaseStream]);

  const start = useCallback(async () => {
    if (state !== 'idle') return { ok: false, error: null };
    const format = pickAudioFormat();
    if (!format) return { ok: false, error: 'Recording is not supported in this browser.' };

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
      return { ok: false, error: micErrorMessage(err) };
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

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const seconds = (Date.now() - startedAtRef.current) / 1000;
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
      startedAtRef.current = Date.now();
      setElapsed(0);
      // 1s timeslices so a long recording is not one giant final chunk, which
      // also means a crash mid-recording loses only the last second.
      recorder.start(1000);
      setState('recording');
      tickRef.current = setInterval(() => {
        setElapsed((Date.now() - startedAtRef.current) / 1000);
      }, 200);
      return { ok: true, error: null };
    } catch (err) {
      // MediaRecorder construction can still fail even after isTypeSupported.
      stream.getTracks().forEach((t) => t.stop());
      return { ok: false, error: micErrorMessage(err) };
    }
  }, [state, releaseStream]);

  /** Finish recording and move to preview. */
  const stop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec || rec.state === 'inactive') return;
    discardRef.current = false;
    rec.stop();
  }, []);

  /** Discard: works while recording AND from the preview stage. */
  const cancel = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      discardRef.current = true;
      rec.stop();
      return;
    }
    releaseStream();
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    setState('idle');
    setElapsed(0);
  }, [releaseStream]);

  /** Clear after a successful send, without revoking twice. */
  const reset = useCallback(() => {
    setResult((prev) => {
      if (prev?.url) URL.revokeObjectURL(prev.url);
      return null;
    });
    setState('idle');
    setElapsed(0);
  }, []);

  return { state, elapsed, result, start, stop, cancel, reset };
}

export default useAudioRecorder;
