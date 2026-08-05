import { useEffect, useRef, useState } from 'react';
import { Play } from 'lucide-react';
import { FullscreenVideoViewer } from './FullscreenVideoViewer';
import { extractVideoPoster, formatVideoDuration } from '../../utils/videoPoster';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';
const resolveUrl = (url) => (!url ? '' : url.startsWith('http') ? url : `${backendUrl}${url}`);

/**
 * A video message.
 *
 * Was an inline `<video controls>` in MessageBubble. Three things changed, and
 * they are why this is its own component now:
 *
 *  1. It OPENS THE VIEWER. FullscreenVideoViewer already existed and was already
 *     wired to the gallery and to starred messages — the chat bubble was the one
 *     caller that never reached it, so a video in the thread was the only medium
 *     with no filename, no download and no jump-to-message. Images and PDFs both
 *     open their viewers from the bubble; this makes video the third.
 *  2. It has a POSTER. The upload service never thumbnails video, so `poster`
 *     was always undefined and the browser painted whatever frame zero happened
 *     to be — very often black on a phone recording. A frame is pulled at 0.5s
 *     client-side instead, cached by URL.
 *  3. It shows a DURATION BADGE, with a play glyph beside it so "0:09" is not
 *     read as a send time — the send time is in the opposite corner.
 *
 * Playback moved to the viewer rather than staying inline: an inline element
 * with `controls` and a click-to-open surface fight each other, and the controls
 * always win the tap. A poster with an explicit play affordance is unambiguous.
 */
export const VideoBubble = ({ message, isOwn, footer, caption }) => {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [poster, setPoster] = useState(null);
  const [duration, setDuration] = useState(
    message.duration ?? message.attachments?.[0]?.duration ?? null
  );

  const src = resolveUrl(message.media_url);
  const serverPoster = message.thumbnail_url ? resolveUrl(message.thumbnail_url) : null;
  const containerRef = useRef(null);

  // Deferred to first visibility, not run on mount. A thread scrolled back
  // through fifty clips would otherwise open fifty decoders at once; this way a
  // video costs nothing until it is actually on screen. The server poster, when
  // one exists, short-circuits the whole thing.
  useEffect(() => {
    if (serverPoster || !src) return undefined;
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return undefined;

    let cancelled = false;
    const io = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      extractVideoPoster(src).then((res) => {
        if (cancelled) return;
        if (res.posterUrl) setPoster(res.posterUrl);
        // Only fills a gap — a server-sent duration is authoritative and stays.
        setDuration((prev) => (prev == null ? res.duration : prev));
      });
    }, { rootMargin: '200px' });

    io.observe(el);
    return () => { cancelled = true; io.disconnect(); };
  }, [src, serverPoster]);

  const shownPoster = serverPoster || poster;
  const durationLabel = formatVideoDuration(duration);

  return (
    <>
      <div data-testid="video-bubble" className="max-w-[330px]">
        <div
          ref={containerRef}
          role="button"
          tabIndex={0}
          onClick={() => setViewerOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewerOpen(true); }
          }}
          aria-label={`Play ${message.filename || 'video'}`}
          className="relative w-full rounded-[6px] overflow-hidden bg-black cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-white/40"
        >
          {shownPoster ? (
            <img
              src={shownPoster}
              alt=""
              className="w-full max-h-[320px] object-cover block"
              data-testid="video-poster"
            />
          ) : (
            // Nothing to show yet — a fixed 16:9 box rather than a collapsing
            // one, so the thread does not reflow when the frame lands.
            <div className="w-full aspect-video bg-[#0F0F0F]" />
          )}

          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 rounded-full bg-black/50 backdrop-blur-[2px] flex items-center justify-center">
              <Play size={22} className="text-white ml-0.5" fill="currentColor" />
            </div>
          </div>

          {durationLabel && (
            // Bottom-LEFT on purpose: the footer's timestamp is bottom-right, and
            // two bare "0:09"-shaped strings in the same corner are unreadable.
            // The glyph is the second half of that separation.
            <div
              data-testid="video-duration-badge"
              className="absolute bottom-1.5 left-1.5 flex items-center gap-1 px-[7px] py-[3px] rounded-full bg-black/45 backdrop-blur-[2px] pointer-events-none"
            >
              <Play size={9} className="text-white/85" fill="currentColor" />
              <span className="text-[11px] text-white/85 whitespace-nowrap">{durationLabel}</span>
            </div>
          )}

          {/* Overlaid only when there is no caption — with one, the footer goes
              below the text, which is where iOS puts it too. */}
          {!caption && footer}
        </div>

        {caption && (
          <p className={`text-sm mt-1 px-1 ${isOwn ? 'text-white' : 'text-[#F5F5F5]'}`}>{caption}</p>
        )}
      </div>

      {viewerOpen && (
        <FullscreenVideoViewer
          src={src}
          filename={message.filename || 'Video'}
          senderName={message.sender_name}
          timestamp={message.created_at}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
};

export default VideoBubble;
