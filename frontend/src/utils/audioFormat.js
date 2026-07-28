/**
 * Which container MediaRecorder should produce for a voice note, and what to call
 * the resulting file.
 *
 * THIS ORDER IS LOAD-BEARING, not a preference.
 *
 * The backend classifies uploads by EXTENSION (app/services/storage.py), and
 * ".webm" is in VIDEO_EXTS. Chrome's MediaRecorder default is
 * `audio/webm;codecs=opus`, so a voice note uploaded as `voice.webm` comes back
 * classified as a VIDEO: it renders in the video bubble and shows up under the
 * media gallery's video tab. Naming matters as much as the codec.
 *
 *  1. audio/mp4 (AAC) -> .m4a
 *     Safari's own output, and Chrome's since it gained MP4 muxing. `.m4a` is in
 *     AUDIO_EXTS and maps to audio/mp4, and AAC-in-MP4 is the one thing that
 *     plays natively EVERYWHERE — which matters because a recording made in
 *     Chrome has to be playable by a recipient on Safari.
 *  2. audio/ogg;codecs=opus -> .ogg
 *     Firefox. `.ogg` is already accepted as audio. Opus is not dependably
 *     playable in Safari across versions, so this is a fallback, not a default.
 *  3. audio/webm;codecs=opus -> .weba
 *     Last resort. `.weba` (not `.webm`) so it classifies as audio; the backend
 *     accepts it explicitly for this reason.
 *
 * Returns null when the browser cannot record at all, which is the signal to hide
 * the mic button rather than offer a control that throws.
 */
const CANDIDATES = [
  { mimeType: 'audio/mp4', extension: 'm4a' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', extension: 'm4a' },
  { mimeType: 'audio/ogg;codecs=opus', extension: 'ogg' },
  { mimeType: 'audio/ogg', extension: 'ogg' },
  { mimeType: 'audio/webm;codecs=opus', extension: 'weba' },
  { mimeType: 'audio/webm', extension: 'weba' },
];

export function pickAudioFormat() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const candidate of CANDIDATES) {
    // isTypeSupported is itself missing on some older implementations.
    if (typeof MediaRecorder.isTypeSupported !== 'function') break;
    if (MediaRecorder.isTypeSupported(candidate.mimeType)) return candidate;
  }
  return null;
}

/** Can this browser record audio at all, in a context that permits it? */
export function canRecordAudio() {
  return Boolean(
    typeof navigator !== 'undefined'
    && navigator.mediaDevices
    && typeof navigator.mediaDevices.getUserMedia === 'function'
    // getUserMedia is unavailable outside a secure context; without this the
    // button would appear and then fail on the first click over plain HTTP.
    && (typeof window === 'undefined' || window.isSecureContext !== false)
    && pickAudioFormat() !== null
  );
}

/** Seconds -> m:ss. Voice notes are short, so no hours case. */
export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const mins = Math.floor(s / 60);
  const secs = s % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Map a getUserMedia failure onto something a user can act on. Mirrors the
 * vocabulary already used for calls (utils/callErrors.js) so the microphone reads
 * the same whether it was a call or a voice note that failed.
 */
export function micErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return 'Microphone blocked. Allow microphone access in your browser settings, then try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'No microphone found. Connect one and try again.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Your microphone is in use by another app.';
  }
  return 'Could not start recording.';
}
