import React, { useRef, useEffect } from 'react';
import { MicOff, CameraOff } from 'lucide-react';

const VideoTile = ({ stream, name, isMuted, isCameraOff, isLocal, isActiveSpeaker }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className={`relative bg-[#141414] rounded-[8px] overflow-hidden w-full h-full ${
      isActiveSpeaker ? 'ring-2 ring-[#10B981] ring-opacity-80' : ''
    }`}>
      {stream && !isCameraOff ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full bg-[#1A1A1A] flex items-center justify-center">
          <div className="w-16 h-16 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-2xl font-bold">
            {name?.charAt(0)?.toUpperCase() || '?'}
          </div>
        </div>
      )}

      {/* Name label */}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
        <p className="text-xs text-white truncate">{isLocal ? 'You' : name}</p>
      </div>

      {/* Mute indicator */}
      {isMuted && (
        <div className="absolute bottom-2 right-2 w-6 h-6 rounded-full bg-[#EF4444] flex items-center justify-center">
          <MicOff size={12} className="text-white" />
        </div>
      )}
    </div>
  );
};

export const VideoGrid = ({ participants, localStream, localName, isMuted, isCameraOn, activeSpeakerId }) => {
  // participants: [{ id, name, stream, isMuted, isCameraOff }]
  const allTiles = [
    { id: 'local', name: localName, stream: localStream, isMuted, isCameraOff: !isCameraOn, isLocal: true },
    ...participants.map(p => ({ ...p, isLocal: false }))
  ];

  const count = allTiles.length;

  // Grid class based on count
  let gridClass = '';
  if (count === 1) gridClass = 'grid-cols-1 grid-rows-1';
  else if (count === 2) gridClass = 'grid-cols-2 grid-rows-1';
  else if (count <= 4) gridClass = 'grid-cols-2 grid-rows-2';
  else gridClass = 'grid-cols-3 grid-rows-2';

  return (
    <div className={`flex-1 grid ${gridClass} gap-1 p-1`} data-testid="video-grid">
      {allTiles.map(tile => (
        <VideoTile
          key={tile.id}
          stream={tile.stream}
          name={tile.name}
          isMuted={tile.isMuted}
          isCameraOff={tile.isCameraOff}
          isLocal={tile.isLocal}
          isActiveSpeaker={tile.id === activeSpeakerId}
        />
      ))}
    </div>
  );
};
