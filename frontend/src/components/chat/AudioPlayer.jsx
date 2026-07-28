import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Play, Pause } from 'lucide-react';
import { formatDuration } from '../../utils/audioFormat';

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
 */

const playing = new Set();

const pauseOthers = (self) => {
  playing.forEach((el) => {
    if (el !== self && !el.paused) el.pause();
  });
};

export const AudioPlayer = ({ src, fallbackDuration = null, tone = 'dark', className = '' }) => {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [intrinsic, setIntrinsic] = useState(null);

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
    const onPlay = () => { pauseOthers(el); setIsPlaying(true); };
    const onPause = () => setIsPlaying(false);
    const onEnded = () => { setIsPlaying(false); setPosition(0); };

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('durationchange', onMeta);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('durationchange', onMeta);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      playing.delete(el);
    };
  }, [src]);

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

  const seek = useCallback((e) => {
    const el = audioRef.current;
    if (!el || !total) return;
    const next = (Number(e.target.value) / 1000) * total;
    el.currentTime = next;
    setPosition(next);
  }, [total]);

  const own = tone === 'own';
  const accent = own ? 'text-white' : 'text-[#10B981]';
  const track = own ? 'accent-white' : 'accent-[#10B981]';
  const label = own ? 'text-white/70' : 'text-[#A3A3A3]';

  // Remaining while playing, total while idle — the WhatsApp behaviour, and it
  // means the bubble always shows a length even before playback starts.
  const shown = isPlaying || position > 0 ? Math.max(0, total - position) : total;
  const sliderValue = total > 0 ? Math.min(1000, (position / total) * 1000) : 0;

  return (
    <div className={`flex items-center gap-2 ${className}`} data-testid="audio-player">
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
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
      <input
        type="range"
        min={0}
        max={1000}
        value={sliderValue}
        onChange={seek}
        aria-label="Seek"
        disabled={!total}
        className={`flex-1 h-1 min-w-0 cursor-pointer ${track} disabled:cursor-default`}
      />
      <span className={`text-[11px] tabular-nums flex-shrink-0 ${label}`} data-testid="audio-duration">
        {formatDuration(shown)}
      </span>
    </div>
  );
};

export default AudioPlayer;
