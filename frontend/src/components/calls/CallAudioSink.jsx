import { useEffect, useRef } from 'react';
import useCallStore from '../../stores/callStore';
import livekitClient from '../../services/livekitClient';

/**
 * The one and only place remote call audio is played.
 *
 * WHY THIS IS ITS OWN TOP-LEVEL COMPONENT
 *
 * These <audio> elements used to live inside ActiveCallView. That view returns
 * null unless `(isConnecting || isConnected || isEnded) && showCallUI &&
 * !isMinimized`, so the moment the user minimised a call every audio element
 * unmounted and the remote party went silent — LiveKit kept streaming and
 * nothing was playing it. Minimise was effectively a one-way mute.
 *
 * Mounted from App.jsx instead, outside every route and every call-UI
 * visibility gate, so audio survives minimise, restore and navigation between
 * routes. It self-gates on there being remote participants with streams, so it
 * renders nothing at all when no call is up.
 *
 * INVARIANT: exactly one element plays any given participant's audio. Video
 * elsewhere (ActiveCallView's StreamVideo, VideoGrid's TileVideo) is built from
 * `new MediaStream(stream.getVideoTracks())` and the local tile is muted, so no
 * video element ever carries voice. Do NOT reintroduce an <audio> inside the
 * call views: two elements on one stream produce echo and comb filtering.
 */

const RemoteAudio = ({ stream, muted }) => {
  const audioRef = useRef(null);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.srcObject = stream || null;
    if (!stream) return;
    // autoPlay covers the normal case. Explicitly calling play() surfaces the
    // rejection when the browser blocks playback, which matters now: this sink
    // can mount before the user has interacted with the page (a call accepted
    // in another tab, or a reload mid-call), whereas the old in-view sink only
    // ever mounted during the accept/answer gesture. The rejection is handled by
    // the document-level gesture listener in CallAudioSink, so swallow it here.
    const played = el.play?.();
    if (played && typeof played.catch === 'function') played.catch(() => {});
  }, [stream]);

  // `muted` is the speaker toggle. Muting the sink is the honest web equivalent
  // of a speaker button: setSinkId needs a concrete output device id and is
  // unsupported on Safari/iOS, so routing was never an option here — and the
  // previous implementation did nothing at all.
  return (
    <audio
      ref={audioRef}
      autoPlay
      playsInline
      muted={muted}
      style={{ display: 'none' }}
      data-testid="call-audio-sink-el"
    />
  );
};

export const CallAudioSink = () => {
  const remoteParticipants = useCallStore((s) => s.remoteParticipants);
  const speakerOn = useCallStore((s) => s.speakerOn);
  const containerRef = useRef(null);

  const audible = Array.isArray(remoteParticipants)
    ? remoteParticipants.filter((p) => p && p.stream)
    : [];
  const hasAudio = audible.length > 0;

  // Autoplay recovery. If the browser refused playback because there had been no
  // user gesture, the next gesture anywhere in the document retries — both
  // through LiveKit's own startAudio() (which is designed to be called from a
  // gesture) and by replaying the elements directly, since an element whose
  // play() was rejected stays paused even after the room unblocks.
  useEffect(() => {
    if (!hasAudio) return undefined;

    const retry = () => {
      livekitClient.startAudio();
      containerRef.current?.querySelectorAll('audio').forEach((el) => {
        if (!el.paused) return;
        const played = el.play?.();
        if (played && typeof played.catch === 'function') played.catch(() => {});
      });
    };

    // Passive + capture so this never interferes with the app's own handlers,
    // and not { once: true }: the first gesture may land before the track
    // arrives, so keep retrying until this sink unmounts with the call.
    const opts = { capture: true, passive: true };
    document.addEventListener('pointerdown', retry, opts);
    document.addEventListener('keydown', retry, opts);
    return () => {
      document.removeEventListener('pointerdown', retry, opts);
      document.removeEventListener('keydown', retry, opts);
    };
  }, [hasAudio]);

  if (!hasAudio) return null;

  return (
    <span ref={containerRef} data-testid="call-audio-sink" style={{ display: 'none' }}>
      {audible.map((p) => (
        <RemoteAudio key={p.id} stream={p.stream} muted={!speakerOn} />
      ))}
    </span>
  );
};

export default CallAudioSink;
