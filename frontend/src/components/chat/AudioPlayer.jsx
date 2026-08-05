import { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause, Mic } from 'lucide-react';
import { formatDuration } from '../../utils/audioFormat';
import { PeaksWaveform } from './Waveform';

/**
 * Play/pause + scrubbable progress + length, shared by the pre-send preview and
 * the message bubble so both look and behave identically.
 *
 * Replaces bare `<audio controls>`, which rendered completely different chrome in
 * Safari vs Chrome and was squeezed into 32px inside a 260px bubble.
 *
 * `fallbackDuration` is the server-sent length. It is preferred over
 * `audio.duration` because MediaRecorder writes streaming containers with no
 * duration in the header — the element reports Infinity or NaN for exactly the
 * files this app records. The element's own value is used only when it is a
 * finite number and no server value exists.
 *
 * Only one player sounds at a time: starting one pauses every other, via a
 * module-level registry rather than a context, so a bubble deep in a virtualised
 * list needs no provider above it.
 *
 * Playback rate cycles 1x -> 1.5x -> 2x -> 1x on one button. A cycling control
 * rather than a menu because there are only three values and the common gesture
 * is "faster, faster, back" — a dropdown would cost two interactions per step.
 * preservesPitch keeps a sped-up voice intelligible rather than chipmunked,
 * which matters when the content is clinical.
 */

const RATES = [1, 1.5, 2];

const playing = new Set();

const pauseOthers = (self) => {
  playing.forEach((el) => {
    if (el !== self && !el.paused) el.pause();
  });
};

export const AudioPlayer = ({
  src,
  fallbackDuration = null,
  tone = 'dark',
  className = '',
  /* Leading slot: shown with a mic badge until the note is played, then
     replaced by the speed control. Omit for previews, which have no sender. */
  senderInitial = null,
  senderColor = null,
  /* The owning bubble's timestamp / ticks, composed onto the duration row. */
  trailingMeta = null,
  /* Called when the element cannot load this source at all. The mid-recording
     preview needs it: a paused MP4 has no finalised moov atom, so the browser
     refuses it and the player would otherwise sit there doing nothing. */
  onUnplayable = null,
}) => {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  // Latched on first play, deliberately NOT derived from position > 0: reaching
  // the end rewinds to zero, which would flip a fully-listened note back to
  // looking unplayed.
  const [hasPlayed, setHasPlayed] = useState(false);

  const [position, setPosition] = useState(0);
  const [intrinsic, setIntrinsic] = useState(null);
  const [rate, setRate] = useState(1);

  const total = (() => {
    if (Number.isFinite(fallbackDuration) && fallbackDuration > 0) return fallbackDuration;
    if (Number.isFinite(intrinsic) && intrinsic > 0) return intrinsic;
    return 0;
  })();

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return undefined;
    playing.add(el);

    const onTime = () => setPosition(el.currentTime || 0);
    const onMeta = () => {
      // Guard the Infinity/NaN case explicitly rather than letting it reach the UI.
      setIntrinsic(Number.isFinite(el.duration) ? el.duration : null);
    };
    const onPlay = () => { pauseOthers(el); setIsPlaying(true); setHasPlayed(true); };
    // There was NO error handling here at all, which is why the documented
    // "degrades to cannot-preview" behaviour never actually happened: the user
    // tapped play on a paused preview, the waveform was flat, and nothing
    // occurred. Reported upward rather than rendered here, because only the
    // caller knows whether an unplayable source is expected.
    const onError = () => { setIsPlaying(false); onUnplayable?.(); };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => { setIsPlaying(false); setPosition(0); };

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('play', onPlay);
    el.addEventListener('error', onError);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('error', onError);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      playing.delete(el);
    };
  }, [src, onUnplayable]);

  // Re-applied on src change too: a new <audio> src resets playbackRate to 1,
  // so without this the badge would say 2x while the audio played at normal
  // speed — the recorder swaps src every time the preview is rebuilt.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = rate;
    // Vendor-prefixed on Safari. Without it a 2x voice note is comically
    // high-pitched and much harder to understand.
    if ('preservesPitch' in el) el.preservesPitch = true;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
  }, [rate, src]);

  const cycleRate = useCallback(() => {
    setRate((prev) => RATES[(RATES.indexOf(prev) + 1) % RATES.length]);
  }, []);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => setIsPlaying(false));
    } else {
      el.pause();
    }
  }, []);

  const seek = useCallback((fraction) => {
    const el = audioRef.current;
    if (!el || !total) return;
    const next = Math.min(total, Math.max(0, fraction * total));
    el.currentTime = next;
    setPosition(next);
  }, [total]);

  const own = tone === 'own';
  const accent = own ? 'text-white' : 'text-[#10B981]';
  const label = own ? 'text-white/70' : 'text-[#A3A3A3]';

  // Remaining while playing, total while idle — the WhatsApp behaviour, and it
  // means the bubble always shows a length even before playback starts.
  const shown = isPlaying || position > 0 ? Math.max(0, total - position) : total;

  // The leading slot swaps once the note has been heard.
  //
  // Before first play it identifies WHO the note is from and that you have not
  // heard it — on a thread of voice notes every bubble otherwise looks
  // identical and equally listened-to. After that the identity has done its job
  // and the space is better spent on the speed control, which is a decision the
  // listener can only sensibly make once they have started listening.
  //
  // Only rendered when the caller supplies an initial: the pre-send preview and
  // the staged-file preview have no sender and keep the speed pill throughout.
  const showsUnplayedBadge = Boolean(senderInitial) && !hasPlayed;

  const speedButton = (
    <button
      type="button"
      onClick={cycleRate}
      aria-label={`Playback speed ${rate}x, tap to change`}
      title={`Playback speed: ${rate}x`}
      data-testid="audio-speed-toggle"
      className={`px-1.5 py-0.5 rounded-[4px] text-[10px] font-medium tabular-nums flex-shrink-0 transition-colors ${
        rate === 1
          ? `${label} hover:bg-white/10`
          : own
            ? 'bg-white/25 text-white'
            : 'bg-[#10B981]/20 text-[#10B981]'
      }`}
    >
      {rate}x
    </button>
  );

  return (
    <div className={`flex items-center gap-2 ${className}`} data-testid="audio-player">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      {showsUnplayedBadge && (
        <div
          className="relative w-9 h-9 flex-shrink-0"
          data-testid="audio-unplayed-avatar"
          aria-label="Not played yet"
        >
          <div
            className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-medium ${
              own ? 'bg-white/15 text-white' : 'bg-[#10B981]/15'
            }`}
            style={own ? undefined : { color: senderColor || '#10B981' }}
          >
            {senderInitial}
          </div>
          <span className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full flex items-center justify-center ${
            own ? 'bg-[#10B981]' : 'bg-[#10B981]'
          }`}>
            <Mic size={9} className="text-white" />
          </span>
        </div>
      )}
      <button
        type="button"
        onClick={toggle}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        data-testid="audio-play-toggle"
        className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-colors ${
          own ? 'bg-white/20 hover:bg-white/30' : 'bg-[#10B981]/15 hover:bg-[#10B981]/25'
        } ${accent}`}
      >
        {isPlaying ? <Pause size={14} /> : <Play size={14} />}
      </button>
      {/* Bars, not a range input. The flat line read as a loading bar rather
          than audio, and gave no sense of where the speech actually is.
          These are the clip's REAL peaks — decoded from the audio, never
          fabricated — which is what makes the seek surface aimable.

          Decoding is deferred until the note is first played (or is a local
          blob, where the bytes are already in memory). A thread scrolled past
          fifty voice notes therefore fetches none of them, and by the time this
          does fetch, the player is downloading the same file anyway. */}
      <PeaksWaveform
        src={src}
        progress={total > 0 ? Math.min(1, position / total) : 0}
        onSeek={seek}
        tone={tone}
        decode={hasPlayed || Boolean(src && src.startsWith('blob:'))}
        className="flex-1 min-w-0"
      />
      {!showsUnplayedBadge && speedButton}
      <span className={`text-[11px] tabular-nums flex-shrink-0 ${label}`} data-testid="audio-duration">
        {formatDuration(shown)}
      </span>
      {/* The bubble's own timestamp and ticks, rendered on THIS row rather than
          on a full-width strip beneath a fixed-width card. This row already had
          the horizontal room going spare. */}
      {trailingMeta}
    </div>
  );
};

export default AudioPlayer;
