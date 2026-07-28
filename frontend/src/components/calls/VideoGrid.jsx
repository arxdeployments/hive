import React, { useRef, useEffect } from 'react';
import { MicOff, MonitorUp } from 'lucide-react';

/*
 * Renders ONLY the video tracks of a stream. Remote audio is played by the
 * dedicated hidden <audio> elements in CallAudioSink (mounted at App level, so
 * it survives minimise and navigation), so every tile video is effectively
 * silent here (muted for the local tile, audio-less stream for the rest) — this
 * guarantees we never double-play a participant's voice.
 */
const TileVideo = ({ stream, muted, className }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    el.srcObject = stream ? new MediaStream(stream.getVideoTracks()) : null;
  }, [stream]);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className={className}
    />
  );
};

const VideoTile = ({
  stream,
  screenStream,
  name,
  avatarUrl,
  isMuted,
  isCameraOff,
  isLocal,
  isActiveSpeaker,
}) => {
  // A screen share always wins the tile; otherwise fall back to the camera.
  const mainStream = screenStream || stream;
  const isSharingScreen = !!screenStream;
  const showVideo = !!mainStream && (isSharingScreen || !isCameraOff);

  return (
    <div
      className={`relative bg-[#141414] rounded-[8px] overflow-hidden w-full h-full ${
        isActiveSpeaker ? 'ring-2 ring-[#10B981] ring-opacity-80' : ''
      }`}
    >
      {showVideo ? (
        <TileVideo
          stream={mainStream}
          muted={isLocal}
          className={`w-full h-full ${isSharingScreen ? 'object-contain bg-black' : 'object-cover'}`}
        />
      ) : (
        <div className="w-full h-full bg-[#1A1A1A] flex items-center justify-center">
          {avatarUrl ? (
            <img src={avatarUrl} alt="" className="w-16 h-16 rounded-full object-cover" />
          ) : (
            <div className="w-16 h-16 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-2xl font-bold">
              {name?.charAt(0)?.toUpperCase() || '?'}
            </div>
          )}
        </div>
      )}

      {/* Name label */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2 flex items-center gap-1.5">
        {isSharingScreen && <MonitorUp size={12} className="text-[#10B981] flex-shrink-0" />}
        <p className="text-xs text-white truncate">{isLocal ? 'You' : name}</p>
      </div>

      {/* Muted-mic indicator */}
      {isMuted && (
        <div className="absolute bottom-2 right-2 w-6 h-6 rounded-full bg-[#EF4444] flex items-center justify-center">
          <MicOff size={12} className="text-white" />
        </div>
      )}
    </div>
  );
};

export const VideoGrid = ({
  remoteParticipants = [],
  localStream,
  localName = 'You',
  localAvatarUrl = null,
  localId = 'local',
  isMuted = false,
  isCameraOn = true,
  isScreenSharing = false,
  activeSpeakerIds = [],
}) => {
  const speakers = Array.isArray(activeSpeakerIds) ? activeSpeakerIds : [];

  const allTiles = [
    {
      id: 'local',
      name: localName,
      avatarUrl: localAvatarUrl,
      stream: localStream,
      screenStream: isScreenSharing ? localStream : null,
      isMuted,
      isCameraOff: !isCameraOn,
      isLocal: true,
      isActiveSpeaker: speakers.includes(localId),
    },
    ...remoteParticipants.map((p) => ({
      id: p.id,
      name: p.display_name || p.id,
      avatarUrl: p.avatar_url,
      stream: p.stream,
      screenStream: p.screenStream,
      isMuted: p.isMuted,
      isCameraOff: p.isCameraOff,
      isLocal: false,
      isActiveSpeaker: speakers.includes(p.id),
    })),
  ];

  const count = allTiles.length;

  // Responsive grid, capped at ~3 columns.
  let gridClass;
  if (count <= 1) gridClass = 'grid-cols-1 grid-rows-1';
  else if (count === 2) gridClass = 'grid-cols-2 grid-rows-1';
  else if (count <= 4) gridClass = 'grid-cols-2 auto-rows-fr';
  else gridClass = 'grid-cols-3 auto-rows-fr';

  return (
    <div className={`flex-1 min-h-0 grid ${gridClass} gap-1 p-1`} data-testid="video-grid">
      {allTiles.map((tile) => (
        <VideoTile key={tile.id} {...tile} />
      ))}
    </div>
  );
};

export default VideoGrid;
