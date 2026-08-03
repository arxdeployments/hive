import React, { useEffect, useRef, useState } from 'react';

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
 * PeaksWaveform draws a clip's REAL envelope, decoded from the audio itself —
 * for the local pre-send preview and for a sent note in a bubble alike.
 *
 * It used to refuse anything that was not a blob: URL, on two grounds. One was
 * sound and still holds: a FABRICATED envelope would be a lie, and showing
 * invented amplitude for a clinical recording invites a listener to scrub to a
 * peak that is not there. Decoding the actual file is the opposite of that — it
 * is the honest version, and it is what makes the seek surface usable, since a
 * flat row is scrubbable but gives nothing to aim at.
 *
 * The other ground was cost, and that one is answered rather than ignored:
 *   - decoding is deferred to first PLAY, not done on mount, so a thread
 *     scrolled past fifty notes decodes none of them;
 *   - results are cached by URL, so scrolling back is free;
 *   - one in-flight decode per URL, so two bubbles of the same clip cost one;
 *   - the bytes are already being fetched to play the note, so on the play path
 *     this is a cache hit at the HTTP layer rather than a second download.
 *
 * Failure still lands on the flat row, which matters: the .ogg/.weba fallbacks
 * from pickAudioFormat do not decode in every browser, and a partial recording
 * (Safari and Chrome both write MP4, whose moov atom is only finalised on stop)
 * cannot be decoded at all.
 */

// Bar geometry, in CSS pixels. The pitch (BAR_W + GAP) is what sets density:
// at 2.5px a 98px bubble waveform draws ~39 bars where a 4px pitch drew 24.
// Fractional widths are fine because both canvases scale by devicePixelRatio —
// 1.5 CSS px is a crisp 3 device px on a retina screen, and softens slightly on
// a 1x display, which is the right trade for matching the reference's density.
// These are the two numbers to change if the look needs tuning.
const BAR_W = 1.5;
const GAP = 1;

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
      //
      // 38ms, tightened from 55ms when the bars got narrower: the cadence sets
      // scroll speed in pixels per second, so a 2.5px pitch at the old rate
      // crawled compared with the 4px pitch it replaced. It also samples the
      // microphone more finely, which is what thinner bars are for.
      if (!paused && now - lastPush > 38) {
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
/** Decoded envelopes, keyed by source URL. */
const peaksCache = new Map();
const peaksInflight = new Map();

/**
 * Decode a clip into `barCount` peaks, once per URL.
 *
 * NORMALISED to the clip's own loudest bar rather than scaled by a fixed gain.
 * A fixed 1.6x renders a quietly-recorded note as a near-flat line, which is
 * exactly the uninformative row this replaces — and quiet is common, because a
 * phone held at arm's length in a noisy ward records low. iOS normalises for the
 * same reason (Waveform.swift). The floor keeps a genuinely silent clip from
 * dividing by ~0 and exploding into full-height noise.
 */
async function decodePeaks(src, barCount) {
  const key = `${src}#${barCount}`;
  if (peaksCache.has(key)) return peaksCache.get(key);
  if (peaksInflight.has(key)) return peaksInflight.get(key);

  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;

  const run = (async () => {
    let audioCtx = null;
    try {
      // credentials: same-origin so /api/media/{id} authenticates. Its redirect
      // to storage is deliberately kept same-origin, so this does not leak.
      const buf = await (await fetch(src, { credentials: 'same-origin' })).arrayBuffer();
      audioCtx = new Ctx();
      const decoded = await audioCtx.decodeAudioData(buf);
      const data = decoded.getChannelData(0);
      const per = Math.floor(data.length / barCount) || 1;
      const raw = [];
      let loudest = 0;
      for (let i = 0; i < barCount; i += 1) {
        let peak = 0;
        for (let j = 0; j < per; j += 1) {
          const v = Math.abs(data[i * per + j] || 0);
          if (v > peak) peak = v;
        }
        raw.push(peak);
        if (peak > loudest) loudest = peak;
      }
      const scale = loudest > 0.01 ? 1 / loudest : 0;
      const out = raw.map((v) => Math.min(1, v * scale));
      peaksCache.set(key, out);
      return out;
    } catch {
      // Undecodable: an .ogg/.weba fallback in a browser that cannot read it, or
      // a partial recording whose container was never finalised. Cache the null
      // so a bubble does not retry the same doomed decode on every play.
      peaksCache.set(key, null);
      return null;
    } finally {
      audioCtx?.close().catch(() => {});
      peaksInflight.delete(key);
    }
  })();

  peaksInflight.set(key, run);
  return run;
}

export const PeaksWaveform = ({
  src,
  progress = 0,
  onSeek,
  tone = 'dark',
  barCount = 56,
  /* Gate for the decode. A bubble passes false until the note is first played,
     so a thread of fifty voice notes fetches none of them; the pre-send preview
     passes true, because its bytes are already in memory. */
  decode = true,
  className = '',
}) => {
  const [peaks, setPeaks] = useState(null);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!src || !decode) return undefined;
    let cancelled = false;
    decodePeaks(src, barCount).then((p) => { if (!cancelled) setPeaks(p); });
    return () => { cancelled = true; };
  }, [src, barCount, decode]);

  const canvasRef = useRef(null);

  /**
   * Canvas, not a row of flex divs.
   *
   * The DOM version gave every bar a 2px min-width, so 56 bars plus their gaps
   * floored the component's min-content at ~222px. Inside a 260px bubble — which
   * after the mic badge, play button, speed badge and duration leaves roughly
   * 92px — flex could not shrink below that floor, so the waveform drew straight
   * through the duration and out past the bubble's right edge.
   *
   * A canvas cannot do that: it paints inside its own box, and its box is
   * whatever CSS gives it. Overflow becomes structurally impossible rather than
   * something to keep tuning. Bar COUNT is then derived from the measured width,
   * so the same component is dense in a wide preview and sparse in a narrow
   * bubble without either overflowing or leaving a gap.
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return undefined;

    const own = tone === 'own';
    const played = own ? '#FFFFFF' : '#10B981';
    const rest = own ? 'rgba(255,255,255,0.38)' : 'rgba(163,163,163,0.45)';

    const draw = () => {
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW <= 0 || cssH <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== cssW * dpr || canvas.height !== cssH * dpr) {
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const count = Math.max(1, Math.floor(cssW / (BAR_W + GAP)));
      // Centre the row in whatever space is left over, so the bars never touch
      // the elements either side of them.
      const used = count * BAR_W + (count - 1) * GAP;
      const originX = Math.max(0, (cssW - used) / 2);
      const mid = cssH / 2;
      const rounded = typeof ctx.roundRect === 'function';

      for (let i = 0; i < count; i += 1) {
        // Resample whatever peak data we have onto the bars that actually fit.
        const level = peaks && peaks.length
          ? peaks[Math.floor((i / count) * peaks.length)] ?? 0.35
          : 0.35;
        const h = Math.max(2, Math.min(cssH - 2, level * (cssH - 4)));
        const x = originX + i * (BAR_W + GAP);
        ctx.fillStyle = (i + 0.5) / count <= progress ? played : rest;
        if (rounded) {
          ctx.beginPath();
          ctx.roundRect(x, mid - h / 2, BAR_W, h, BAR_W / 2);
          ctx.fill();
        } else {
          ctx.fillRect(x, mid - h / 2, BAR_W, h);
        }
      }
    };

    draw();
    // Redraw on resize: the bubble is a fixed width today, but the pre-send
    // preview stretches with the composer and the bar count is width-derived.
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(draw) : null;
    ro?.observe(wrap);
    return () => ro?.disconnect();
  }, [peaks, progress, tone]);

  const seekTo = (clientX) => {
    const el = wrapRef.current;
    if (!el || !onSeek) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
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
      // min-w-0 lets flex shrink this below its content, and overflow-hidden is
      // the belt to the canvas's braces.
      className={`relative h-8 min-w-0 overflow-hidden cursor-pointer select-none outline-none ${className}`}
    >
      <canvas ref={canvasRef} className="block w-full h-full" aria-hidden="true" />
    </div>
  );
};

export default LiveWaveform;
