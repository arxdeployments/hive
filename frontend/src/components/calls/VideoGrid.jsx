import { useRef, useEffect } from 'react';
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

/**
 * Somebody who has been invited but has not answered yet.
 *
 * A distinct tile rather than an ordinary one with no media: an avatar sitting in the
 * grid is indistinguishable from a participant whose camera is off, so without the
 * label the grid claims somebody is on the call when their phone is still ringing.
 */
const PendingTile = ({ name, avatarUrl }) => (
  <div
    className="relative bg-[#141414] rounded-[8px] overflow-hidden w-full h-full"
    data-testid="video-grid-pending"
  >
    <div className="w-full h-full bg-[#1A1A1A] flex items-center justify-center">
      {avatarUrl ? (
        <img src={avatarUrl} alt="" className="w-16 h-16 rounded-full object-cover opacity-50" />
      ) : (
        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center text-white/40 text-2xl font-bold">
          {name?.charAt(0)?.toUpperCase() || '?'}
        </div>
      )}
    </div>
    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 py-2">
      <p className="text-xs text-white/70 truncate">{name}</p>
      <p className="text-[11px] text-[#10B981]">Ringing…</p>
    </div>
  </div>
);

export const VideoGrid = ({
  remoteParticipants = [],
  pendingInvitees = [],
  localStream,
  localScreenStream = null,
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
      // The real share, not the camera aliased as one.
      screenStream: localScreenStream,
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

  // Beyond this many tiles the grid stops being a grid and starts being a contact
  // sheet: at 32 participants a 3-column layout is 11 rows of stamps too small to
  // recognise anybody in, and every one of them is a decoded video stream. So the
  // visible set is capped and the rest are represented by a count.
  //
  // This is a rendering cap, not a subscription cap — but it is most of the win either
  // way, because both clients run LiveKit with `adaptiveStream: true`. Adaptive stream
  // sizes each subscription from the element actually displaying it and pauses tracks
  // with no element at all, so a participant who is not on screen costs no decode and
  // almost no bandwidth. Capping the tiles is therefore what makes the subscription
  // load bounded too.
  const VISIBLE_LIMIT = 9;

  // Who earns a tile when there are more people than places: whoever is talking, then
  // whoever has their camera on, then the rest. The local tile is pinned first — a
  // call where you cannot see yourself reads as broken — and beyond that this keeps
  // the people currently contributing on screen instead of whoever happened to join
  // earliest.
  const ranked = [
    allTiles[0],
    ...allTiles.slice(1).sort((a, b) => {
      if (a.isActiveSpeaker !== b.isActiveSpeaker) return a.isActiveSpeaker ? -1 : 1;
      const aLive = !!a.screenStream || (!!a.stream && !a.isCameraOff);
      const bLive = !!b.screenStream || (!!b.stream && !b.isCameraOff);
      if (aLive !== bLive) return aLive ? -1 : 1;
      return 0;
    }),
  ];

  const visible = ranked.slice(0, VISIBLE_LIMIT);
  const overflow = ranked.length - visible.length;
  // Ringing invitees fill whatever room is left after the people actually on the call.
  // They rank below everyone: a placeholder must never push a live participant off the
  // grid, and there is nothing to see in one.
  const pending = Array.isArray(pendingInvitees) ? pendingInvitees : [];
  const visiblePending = overflow > 0 ? [] : pending.slice(0, VISIBLE_LIMIT - visible.length);
  const count = visible.length + visiblePending.length + (overflow > 0 ? 1 : 0);

  // Columns from the tile count, so tiles stay as square as the container allows.
  // `auto-rows-fr` splits the height evenly, which is what keeps a 5-person call from
  // giving row one twice the height of row two.
  let gridClass;
  if (count <= 1) gridClass = 'grid-cols-1 grid-rows-1';
  else if (count === 2) gridClass = 'grid-cols-1 sm:grid-cols-2 auto-rows-fr';
  else if (count <= 4) gridClass = 'grid-cols-2 auto-rows-fr';
  else if (count <= 6) gridClass = 'grid-cols-2 sm:grid-cols-3 auto-rows-fr';
  else gridClass = 'grid-cols-3 auto-rows-fr';

  return (
    <div
      className={`flex-1 min-h-0 grid ${gridClass} gap-1 p-1`}
      data-testid="video-grid"
      data-tile-count={count}
      data-participant-count={allTiles.length}
      data-pending-count={pending.length}
    >
      {visible.map((tile) => (
        <VideoTile key={tile.id} {...tile} />
      ))}
      {visiblePending.map((p) => (
        <PendingTile key={`pending-${p.id}`} name={p.display_name || 'Invited'} avatarUrl={p.avatar_url} />
      ))}
      {overflow > 0 && (
        <div
          className="relative bg-[#141414] rounded-[8px] overflow-hidden w-full h-full flex flex-col items-center justify-center gap-1"
          data-testid="video-grid-overflow"
        >
          <span className="text-[#F5F5F5] text-lg font-semibold">{`+${overflow}`}</span>
          <span className="text-[11px] text-[#A3A3A3]">
            {overflow === 1 ? 'other participant' : 'other participants'}
          </span>
        </div>
      )}
    </div>
  );
};

export default VideoGrid;
