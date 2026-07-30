import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Waveforms for the voice-note UI.
 *
 * Two components, because the two situations have genuinely different data:
 *
 *   LiveWaveform   — driven by the microphone in real time, via an AnalyserNode
 *                    on the recording MediaStream. Canvas + requestAnimationFrame
 *                    rather than React state: this repaints ~60 times a second,
 *                    and putting that through setState would re-render the whole
 *                    composer on every frame.
 *   PeaksWaveform  — a finished clip. Decodes the audio ONCE and draws its real
 *                    envelope, with the played portion filled.
 *
 * PeaksWaveform decodes only same-origin blob: URLs — i.e. the local pre-send
 * preview, where the bytes are already in memory. A sent voice note in a bubble
 * would mean fetching and decoding every clip in the thread just to draw it, so
 * those fall back to a flat bar row. That row is a progress indicator wearing
 * the same clothes, deliberately NOT a fabricated envelope: showing invented
 * amplitude for a clinical recording would be a lie the UI has no business
 * telling.
 */

const BAR_W = 3;
const GAP = 2;

/** Nearest even split of a Uint8 time-domain buffer into an RMS level 0..1. */
const rmsOf = (buf) => {
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const v = (buf[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / buf.length);
};

export const LiveWaveform = ({ stream, paused = false, className = '' }) => {
  const canvasRef = useRef(null);
  // Rolling history of bar heights, newest last. Held in a ref so the animation
  // loop can mutate it without triggering React.
  const barsRef = useRef([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !stream) return undefined;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return undefined;

    const audioCtx = new Ctx();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    // Small FFT: we want a loudness number per frame, not a spectrum, and a
    // short window tracks speech transients closely enough to look alive.
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.6;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.fftSize);
    let raf = 0;
    let lastPush = 0;

    const draw = (now) => {
      raf = requestAnimationFrame(draw);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const capacity = Math.max(1, Math.floor(cssW / (BAR_W + GAP)));

      // Push a new bar on a fixed cadence rather than every frame, so the
      // waveform scrolls at the same speed regardless of refresh rate.
      if (!paused && now - lastPush > 55) {
        lastPush = now;
        analyser.getByteTimeDomainData(buf);
        // Gain then clamp: speech RMS sits low (~0.05-0.25), so the raw value
        // would render as a barely-visible stub.
        barsRef.current.push(Math.min(1, rmsOf(buf) * 3.2));
        if (barsRef.current.length > capacity) {
          barsRef.current.splice(0, barsRef.current.length - capacity);
        }
      }

      const bars = barsRef.current;
      const mid = cssH / 2;
      ctx.fillStyle = paused ? '#6B7280' : '#EF4444';
      // roundRect is unavailable before Safari 16.4; square bars are a fine
      // degradation and much better than the whole canvas throwing per frame.
      const rounded = typeof ctx.roundRect === 'function';
      bars.forEach((level, i) => {
        // Minimum height so silence still reads as a waveform at rest rather
        // than a gap, matching how messaging apps render a quiet passage.
        const h = Math.max(2, level * (cssH - 4));
        const x = i * (BAR_W + GAP);
        if (rounded) {
          ctx.beginPath();
          ctx.roundRect(x, mid - h / 2, BAR_W, h, BAR_W / 2);
          ctx.fill();
        } else {
          ctx.fillRect(x, mid - h / 2, BAR_W, h);
        }
      });
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      try { source.disconnect(); } catch { /* already torn down with the stream */ }
      // Closing releases the audio hardware graph; leaking contexts eventually
      // exhausts the browser's limit and later recordings silently fail.
      audioCtx.close().catch(() => {});
    };
  }, [stream, paused]);

  return (
    <canvas
      ref={canvasRef}
      className={`w-full h-8 ${className}`}
      data-testid="live-waveform"
      aria-hidden="true"
    />
  );
};

/**
 * A finished clip: real envelope for local blobs, flat bars otherwise.
 * Click or drag anywhere on it to seek.
 */
export const PeaksWaveform = ({
  src,
  progress = 0,
  onSeek,
  tone = 'dark',
  barCount = 56,
  className = '',
}) => {
  const [peaks, setPeaks] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    // Only the in-memory preview. See the module docstring for why a remote
    // clip is not fetched and decoded just to be drawn.
    if (!src || !src.startsWith('blob:')) {
      setPeaks(null);
      return undefined;
    }
    let cancelled = false;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return undefined;

    (async () => {
      try {
        const buf = await (await fetch(src)).arrayBuffer();
        const audioCtx = new Ctx();
        const decoded = await audioCtx.decodeAudioData(buf);
        audioCtx.close().catch(() => {});
        if (cancelled) return;
        const data = decoded.getChannelData(0);
        const per = Math.floor(data.length / barCount) || 1;
        const out = [];
        for (let i = 0; i < barCount; i += 1) {
          let peak = 0;
          for (let j = 0; j < per; j += 1) {
            const v = Math.abs(data[i * per + j] || 0);
            if (v > peak) peak = v;
          }
          out.push(Math.min(1, peak * 1.6));
        }
        setPeaks(out);
      } catch {
        // A partial recording (see useAudioRecorder: Safari writes its moov
        // atom only on stop) cannot be decoded. Fall back to flat bars.
        if (!cancelled) setPeaks(null);
      }
    })();
    return () => { cancelled = true; };
  }, [src, barCount]);

  const bars = useMemo(
    () => peaks || Array.from({ length: barCount }, () => 0.35),
    [peaks, barCount]
  );

  const own = tone === 'own';
  const playedColor = own ? 'bg-white' : 'bg-[#10B981]';
  const restColor = own ? 'bg-white/35' : 'bg-[#A3A3A3]/40';

  const seekTo = (clientX) => {
    const el = wrapRef.current;
    if (!el || !onSeek) return;
    const rect = el.getBoundingClientRect();
    onSeek(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)));
  };

  return (
    <div
      ref={wrapRef}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      onClick={(e) => seekTo(e.clientX)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') onSeek?.(Math.min(1, progress + 0.05));
        if (e.key === 'ArrowLeft') onSeek?.(Math.max(0, progress - 0.05));
      }}
      data-testid="peaks-waveform"
      className={`flex items-center gap-[2px] h-8 cursor-pointer select-none outline-none ${className}`}
    >
      {bars.map((level, i) => (
        <span
          key={i}
          className={`flex-1 rounded-full transition-colors ${
            i / bars.length <= progress ? playedColor : restColor
          }`}
          style={{ height: `${Math.max(3, level * 28)}px`, minWidth: 2 }}
        />
      ))}
    </div>
  );
};

export default LiveWaveform;
