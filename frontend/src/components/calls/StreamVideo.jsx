import { useEffect, useRef } from 'react';

/**
 * Renders ONLY the video tracks of a MediaStream.
 *
 * Extracted from ActiveCallView so the minimised call window can show the remote
 * video without duplicating the srcObject effect — two copies would be two places
 * to get the audio-exclusion wrong.
 *
 * The stream is rebuilt from `getVideoTracks()` so this element can never carry
 * voice: remote audio is played by exactly one hidden <audio> per participant in
 * CallAudioSink. Two elements on one audio track echo.
 *
 * No cleanup that stops tracks, deliberately. Unmounting (minimise, navigation)
 * must not touch the underlying MediaStream — it lives in callStore and the same
 * tracks are re-attached when a view remounts.
 */
export const StreamVideo = ({ stream, muted = false, className }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream ? new MediaStream(stream.getVideoTracks()) : null;
  }, [stream]);

  return <video ref={videoRef} autoPlay playsInline muted={muted} className={className} />;
};

export default StreamVideo;
