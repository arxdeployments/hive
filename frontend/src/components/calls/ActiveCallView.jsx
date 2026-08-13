import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PhoneOff, Mic, MicOff, Video, VideoOff, Volume2,
  MoreHorizontal, ChevronDown, UserPlus, Lock,
  Monitor, MonitorOff, MonitorUp, MessageSquare, SwitchCamera
} from 'lucide-react';
import useCallStore, { isCallStalled, formatCallDuration } from '../../stores/callStore';
import { StreamVideo } from './StreamVideo';
import livekitClient from '../../services/livekitLazy';
import callSounds from '../../services/callSounds';
import wsClient from '../../services/websocket';
import { VideoGrid } from './VideoGrid';
import { AddParticipantsModal } from './AddParticipantsModal';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

const resolveAvatar = (url) => {
  if (!url) return null;
  return url.startsWith('http') ? url : `${backendUrl}${url}`;
};

const localProfile = () => {
  try {
    const u = JSON.parse(localStorage.getItem('user') || '{}');
    return {
      id: u._id || u.id || 'local',
      name: u.display_name || u.name || 'You',
      avatar: resolveAvatar(u.avatar_url),
    };
  } catch {
    return { id: 'local', name: 'You', avatar: null };
  }
};

/* StreamVideo moved to ./StreamVideo so the minimised call window can render the
   remote video without a second copy of the srcObject effect. */

/* RemoteAudio / RemoteAudioSink moved OUT of this file to
   components/calls/CallAudioSink.jsx, mounted at App level.
   They were rendered only inside the three return branches below, all of which
   sit behind `isVisible` — and isVisible requires !isMinimized. So minimising a
   call unmounted every audio element and the remote party went silent while
   LiveKit carried on streaming. Do not add an <audio> back into this view: the
   sink is a singleton and two elements on one stream echo. */

const NetworkDot = ({ quality, reconnecting }) => {
  const color = reconnecting
    ? '#F59E0B'
    : quality === 'excellent' ? '#10B981' : quality === 'poor' ? '#EF4444' : '#F59E0B';
  const label = reconnecting
    ? 'Reconnecting'
    : quality === 'excellent' ? 'Excellent connection'
      : quality === 'poor' ? 'Poor connection'
        : 'Good connection';
  return (
    <span className="inline-flex items-center" title={label} aria-label={label}>
      <span
        className={`w-2 h-2 rounded-full ${reconnecting ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: color }}
      />
    </span>
  );
};

/**
 * The reconnect banner.
 *
 * Deliberately an overlay on the live call rather than a replacement for it: the
 * call has NOT ended, the SFU is very often still carrying audio, and swapping the
 * screen out would tell the user the opposite. It sits over whatever was already
 * there — video keeps its last frame, the controls stay reachable so they can still
 * hang up — and disappears the moment the link is back.
 */
const ReconnectingBanner = ({ visible }) => {
  if (!visible) return null;
  return (
    // Fixed, and pointer-events-none, so one definition works identically over the
    // 1:1 video, group grid and voice layouts without any of them reserving space
    // for it — and so it can never swallow a tap meant for the hang-up button
    // underneath, which is the one control that must stay reachable while the call
    // is struggling.
    <div className="fixed top-0 left-0 right-0 z-[9999] flex justify-center pt-16 pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 px-4 py-2 rounded-full bg-black/70 backdrop-blur-md border border-[#F59E0B]/40"
      >
        <span className="w-2 h-2 rounded-full bg-[#F59E0B] animate-pulse" />
        <span className="text-[13px] text-white/90">Connecting…</span>
      </div>
    </div>
  );
};

/* WhatsApp-style control button (rounded pill) */
const CallControl = ({ icon: Icon, active, onClick, label, disabled, testId }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    data-testid={testId}
    className="flex flex-col items-center gap-1.5"
  >
    <div
      className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-200 active:scale-90 ${
        active ? 'bg-white' : 'bg-white/10 backdrop-blur-sm'
      } ${disabled ? 'opacity-40' : ''}`}
    >
      <Icon size={24} className={active ? 'text-[#0A0A0A]' : 'text-white'} />
    </div>
    {label && <span className="text-[11px] text-white/70">{label}</span>}
  </button>
);

/**
 * "Add people", for group calls only.
 *
 * Hidden on a 1:1 rather than disabled: the server refuses to add a third party to a
 * direct call by design (it would silently change what two people agreed to be in), so
 * there is nothing this could do there. It used to be rendered on every call screen and
 * wired to nothing at all.
 */
const AddPeopleButton = ({ onClick }) => (
  <button
    onClick={onClick}
    data-testid="call-add-people-btn"
    aria-label="Add people to call"
    className="p-2 text-white/70 hover:text-white active:scale-90 transition-transform"
  >
    <UserPlus size={22} />
  </button>
);

export const ActiveCallView = () => {
  const {
    callState, callId, callType, callDuration, isMuted, isCameraOn,
    showCallUI, incomingCaller, isMinimized, isGroupCall, remoteParticipants,
    localStream, localScreenStream, isScreenSharing, activeSpeakerIds, networkQuality,
  } = useCallStore();
  const pendingInvitees = useCallStore((s) => s.pendingInvitees);

  const [showMore, setShowMore] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  /**
   * Whether this machine has a second camera to switch to.
   *
   * `livekitClient.flipCamera()` has existed the whole time with **no caller
   * anywhere in the app**, so on a phone browser the back camera was unreachable:
   * `getUserMedia` defaults to the front one and nothing could change it. Gated on an
   * actual device count rather than on a user-agent guess — a laptop with one webcam
   * gets no button, and a phone or a desk with two gets one that works.
   */
  const [canFlipCamera, setCanFlipCamera] = useState(false);
  // Speaker lives in the store now: as local state it was destroyed on every
  // minimise, and it was purely cosmetic — nothing acted on the flag. CallAudioSink
  // mutes its elements from it, so the button now does something real.
  const speakerOn = useCallStore((s) => s.speakerOn);
  // Our media link, our signalling link, or a peer's — any of the three means the
  // call is not currently carrying, and all three read as "Connecting…" to the user.
  const reconnecting = useCallStore(isCallStalled);

  const isConnecting = callState === 'connecting';
  const isConnected = callState === 'connected';
  const isEnded = callState === 'ended';
  const isVideo = callType === 'video';

  // outgoing_ringing is owned by OutgoingCallScreen and incoming_ringing by
  // IncomingCallOverlay — this view covers the live call and its teardown only.
  const isVisible =
    (isConnecting || isConnected || isEnded) && showCallUI && !isMinimized;

  // Count the cameras once the call is up.
  //
  // Deliberately after the call starts: `enumerateDevices` only reveals labels and a
  // full device list once a capture permission has been granted, so counting before
  // the camera is open under-reports on some browsers.
  useEffect(() => {
    if (!isVideo || callState !== 'connected') return;
    let cancelled = false;
    navigator.mediaDevices?.enumerateDevices?.()
      .then((devices) => {
        if (cancelled) return;
        setCanFlipCamera(devices.filter((d) => d.kind === 'videoinput').length > 1);
      })
      .catch(() => { /* no permission, no list — leave the control hidden */ });
    return () => { cancelled = true; };
  }, [isVideo, callState]);

  // Call lifecycle sounds.
  useEffect(() => {
    if (callState === 'connected') {
      callSounds.stopAll();
      callSounds.playConnected();
    } else if (callState === 'ended') {
      callSounds.stopAll();
      callSounds.playEnded();
    }
  }, [callState]);

  if (!isVisible) return null;

  const me = localProfile();
  const speakers = Array.isArray(activeSpeakerIds) ? activeSpeakerIds : [];
  const localSpeaking = speakers.includes(me.id);

  const name = incomingCaller?.display_name || (isGroupCall ? 'Group Call' : 'Call');
  const initial = name.charAt(0).toUpperCase();
  const callerAvatar = resolveAvatar(incomingCaller?.avatar_url);

  // Reconnecting outranks the duration. A clock ticking over dead audio is the most
  // misleading thing a call UI can show, and it is exactly what happened before: the
  // SFU had dropped us and the timer carried on regardless.
  let statusText = '';
  if (isEnded) statusText = 'Call ended';
  else if (reconnecting) statusText = 'Connecting…';
  else if (isConnecting) statusText = 'Connecting';
  else if (isConnected) statusText = formatCallDuration(callDuration);

  // ---- Handlers ----
  const handleEnd = () => {
    livekitClient.leave();
    if (callState === 'outgoing_ringing') {
      wsClient.send({ type: 'call:cancel', call_id: callId });
    } else {
      wsClient.send({ type: 'call:end', call_id: callId });
    }
    callSounds.stopAll();
    useCallStore.getState().endCall();
  };

  /**
   * Mic on/off. The same two rules as `handleToggleCamera` below, for the same reasons.
   *
   * Awaited so the peer is told the state actually REACHED. Sending the requested
   * state left the roster showing an unmuted participant whose microphone had
   * refused to open, and nobody on the call could tell that from someone who had
   * stopped talking.
   *
   * The target is read from the STORE, not from this render's `isMuted`: two taps
   * inside one frame both see the same stale flag, so both ask for the same state
   * and the second appears to do nothing. `livekitClient` moves the flag
   * optimistically and serialises the operations, so tap N always asks for the
   * opposite of tap N-1.
   */
  const handleToggleMute = async () => {
    // The new mic-enabled state is the current mute flag: we are flipping it.
    const reached = await livekitClient.setMicEnabled(useCallStore.getState().isMuted);
    // `callId` is this render's, and the await is long enough to outlive the call —
    // unmuting reopens the device. Ending one call and answering another inside that
    // window would otherwise report a microphone state against the call just left,
    // told to peers who have moved on, about a device now serving someone else.
    if (useCallStore.getState().callId !== callId) return;
    wsClient.send({
      type: 'call:toggle_media', call_id: callId, media_type: 'audio', enabled: reached,
    });
  };

  /**
   * Camera on/off.
   *
   * The target is read from the STORE, not from this render's `isCameraOn`: two taps
   * inside one frame both see the same stale prop, so both would ask for the same
   * state and the second tap would appear to do nothing. `livekitClient` updates the
   * store optimistically and serialises the operations, so reading it here means tap N
   * always asks for the opposite of what tap N-1 asked for.
   *
   * The peer is told the state actually REACHED, once the operation settles — telling
   * them the requested state would leave them showing a camera that failed to open.
   * LiveKit also relays the mute natively (`TrackMuted`/`TrackUnmuted`), so this frame
   * is the belt to that braces: it is what gets a correct roster to a client whose SFU
   * subscription is lagging, and it is the only channel that reaches someone who has
   * not subscribed to this track at all.
   */
  const handleToggleCamera = async () => {
    const target = !useCallStore.getState().isCameraOn;
    const reached = await livekitClient.setCameraEnabled(target);
    // Same guard as the mic above, and the window here is wider: re-acquiring a
    // camera is the slow case this method's own comment is written around.
    if (useCallStore.getState().callId !== callId) return;
    wsClient.send({
      type: 'call:toggle_media', call_id: callId, media_type: 'video', enabled: reached,
    });
  };

  const handleToggleScreenShare = () => {
    if (isScreenSharing) livekitClient.stopScreenShare();
    else livekitClient.startScreenShare();
  };

  const handleFlipCamera = () => livekitClient.flipCamera();

  const handleMinimize = () => useCallStore.getState().toggleMinimize();

  // ==================== 1:1 VIDEO CALL ====================
  if (isVideo && isConnected && !isGroupCall) {
    const remote = remoteParticipants[0];
    const remoteMain = remote?.screenStream || remote?.stream;
    const remoteSharing = !!remote?.screenStream;
    const remoteName = remote?.display_name || name;
    const remoteAvatar = resolveAvatar(remote?.avatar_url) || callerAvatar;
    const showRemoteVideo = !!remoteMain && (remoteSharing || !remote?.isCameraOff);
    const remoteSpeaking = remote && speakers.includes(remote.id);
    const localCovered = !isCameraOn && !isScreenSharing;

    return (
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9998] bg-black flex flex-col"
      >

        <div className="flex-1 min-h-0 relative overflow-hidden">
          {/* Remote full-bleed */}
          {showRemoteVideo ? (
            <StreamVideo
              stream={remoteMain}
              className={`w-full h-full ${remoteSharing ? 'object-contain' : 'object-cover'} ${
                remoteSpeaking ? 'ring-2 ring-inset ring-[#10B981]' : ''
              }`}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#1a3a2a] to-[#0A0A0A]">
              <div className="w-32 h-32 rounded-full overflow-hidden border-[3px] border-white/10">
                {remoteAvatar ? (
                  <img src={remoteAvatar} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[#10B981]/30 to-[#10B981]/10 flex items-center justify-center text-[#10B981] text-5xl font-semibold">
                    {remoteName.charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Local PiP */}
          <div
            className={`absolute top-4 right-4 w-[120px] h-[160px] sm:w-[150px] sm:h-[200px] rounded-xl overflow-hidden border-2 bg-[#1A1A1A] shadow-2xl ${
              localSpeaking ? 'border-[#10B981]' : 'border-white/20'
            }`}
          >
            {!localCovered ? (
              <StreamVideo stream={localStream} muted className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[#10B981] text-2xl font-semibold bg-[#141414]">
                {me.name.charAt(0).toUpperCase()}
              </div>
            )}
          </div>

          <ReconnectingBanner visible={reconnecting} />

          {/* Top overlay */}
          <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-4 flex items-center justify-between">
            <button onClick={handleMinimize} className="p-2 text-white/70 hover:text-white">
              <ChevronDown size={24} />
            </button>
            <div className="text-center">
              <p className="text-sm text-white font-medium">{remoteName}</p>
              <p className="text-xs text-white/60 flex items-center justify-center gap-1.5">
                <NetworkDot quality={networkQuality} reconnecting={reconnecting} />
                {statusText}
              </p>
            </div>
            <div className="w-10" />
          </div>
        </div>

        {/* Controls */}
        <div className="bg-black/80 backdrop-blur-xl px-6 py-6 safe-bottom">
          <div className="flex items-center justify-center gap-4 sm:gap-5 mb-5">
            <CallControl icon={isMuted ? MicOff : Mic} active={isMuted} onClick={handleToggleMute} label={isMuted ? 'Unmute' : 'Mute'} testId="call-mute-btn" />
            <CallControl icon={isCameraOn ? Video : VideoOff} active={!isCameraOn} onClick={handleToggleCamera} label="Camera" testId="call-camera-btn" />
            {canFlipCamera && isCameraOn && (
              <CallControl icon={SwitchCamera} onClick={handleFlipCamera} label="Flip" testId="call-flip-camera-btn" />
            )}
            <CallControl icon={isScreenSharing ? MonitorOff : Monitor} active={isScreenSharing} onClick={handleToggleScreenShare} label="Share" testId="call-screenshare-btn" />
            <CallControl icon={Volume2} active={speakerOn} onClick={() => useCallStore.getState().toggleSpeaker()} label="Speaker" />
          </div>
          <div className="flex justify-center">
            <button onClick={handleEnd} data-testid="call-end-btn" aria-label="End call" className="w-16 h-16 rounded-full bg-[#EF4444] flex items-center justify-center active:scale-90 transition-transform">
              <PhoneOff size={28} className="text-white" />
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  // ==================== GROUP CALL ====================
  if (isGroupCall && isConnected) {
    return (
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        className="fixed inset-0 z-[9998] bg-[#0A0A0A] flex flex-col"
      >
        <ReconnectingBanner visible={reconnecting} />

        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0">
          <button onClick={handleMinimize} className="p-2 text-white/70"><ChevronDown size={20} /></button>
          <div className="text-center">
            <p className="text-sm text-white font-medium">Group Call</p>
            <p className="text-xs text-white/50 flex items-center justify-center gap-1.5">
              <NetworkDot quality={networkQuality} reconnecting={reconnecting} />
              {remoteParticipants.length + 1} participants
              {pendingInvitees.length > 0 && ` · ${pendingInvitees.length} ringing`}
              {' · '}{statusText}
            </p>
          </div>
          <AddPeopleButton onClick={() => setShowAddPeople(true)} />
        </div>

        <VideoGrid
          remoteParticipants={remoteParticipants}
          pendingInvitees={pendingInvitees}
          localStream={localStream}
          localScreenStream={localScreenStream}
          localName={me.name}
          localAvatarUrl={me.avatar}
          localId={me.id}
          isMuted={isMuted}
          isCameraOn={isCameraOn}
          activeSpeakerIds={speakers}
        />

        <AddParticipantsModal
          isOpen={showAddPeople}
          onClose={() => setShowAddPeople(false)}
          callId={callId}
        />

        <div className="bg-[#0A0A0A]/80 backdrop-blur-xl px-6 py-5 safe-bottom flex-shrink-0">
          <div className="flex items-center justify-center gap-4 sm:gap-5 mb-5">
            <CallControl icon={isMuted ? MicOff : Mic} active={isMuted} onClick={handleToggleMute} label={isMuted ? 'Unmute' : 'Mute'} testId="call-mute-btn" />
            {isVideo && <CallControl icon={isCameraOn ? Video : VideoOff} active={!isCameraOn} onClick={handleToggleCamera} label="Camera" testId="call-camera-btn" />}
            {canFlipCamera && isCameraOn && (
              <CallControl icon={SwitchCamera} onClick={handleFlipCamera} label="Flip" testId="call-flip-camera-btn" />
            )}
            <CallControl icon={isScreenSharing ? MonitorOff : Monitor} active={isScreenSharing} onClick={handleToggleScreenShare} label="Share" testId="call-screenshare-btn" />
            <CallControl icon={Volume2} active={speakerOn} onClick={() => useCallStore.getState().toggleSpeaker()} label="Speaker" />
          </div>
          <div className="flex justify-center">
            <button onClick={handleEnd} data-testid="call-end-btn" aria-label="End call" className="w-16 h-16 rounded-full bg-[#EF4444] flex items-center justify-center active:scale-90 transition-transform">
              <PhoneOff size={28} className="text-white" />
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  // ==================== VOICE / CONNECTING / ENDED (avatar view) ====================
  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9998] flex flex-col"
      style={{ background: 'linear-gradient(180deg, #1a3a2a 0%, #0A0A0A 40%, #0A0A0A 100%)' }}
    >
      <ReconnectingBanner visible={reconnecting && !isEnded} />

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-12 pb-2 flex-shrink-0">
        <button onClick={handleMinimize} className="p-2 text-white/70 hover:text-white active:scale-90 transition-transform" aria-label="Minimize call">
          <ChevronDown size={24} />
        </button>
        <div className="w-10" />
        {isGroupCall ? <AddPeopleButton onClick={() => setShowAddPeople(true)} /> : <div className="w-10" />}
      </div>

      <AddParticipantsModal
        isOpen={showAddPeople}
        onClose={() => setShowAddPeople(false)}
        callId={callId}
      />

      {/* Center — avatar + name + status */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col items-center justify-center px-6">
        <motion.div
          animate={isConnecting || (reconnecting && !isEnded) ? { scale: [1, 1.04, 1] } : {}}
          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          className="relative mb-6"
        >
          <div className={`w-32 h-32 rounded-full overflow-hidden border-[3px] shadow-[0_0_60px_rgba(16,185,129,0.15)] ${
            localSpeaking || (remoteParticipants[0] && speakers.includes(remoteParticipants[0].id))
              ? 'border-[#10B981]' : 'border-white/10'
          }`}>
            {callerAvatar ? (
              <img src={callerAvatar} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-[#10B981]/30 to-[#10B981]/10 flex items-center justify-center text-[#10B981] text-5xl font-semibold">
                {initial}
              </div>
            )}
          </div>
        </motion.div>

        <h2 className="text-[22px] font-semibold text-white mb-1.5 text-center">{name}</h2>

        <div className="flex items-center gap-1.5">
          {isConnecting || (reconnecting && !isEnded) ? (
            <span className="text-[15px] text-white/50 flex items-center gap-1">
              {statusText}
              <span className="inline-flex gap-0.5 ml-0.5">
                <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '200ms' }} />
                <span className="w-1 h-1 bg-current rounded-full animate-bounce" style={{ animationDelay: '400ms' }} />
              </span>
            </span>
          ) : isEnded ? (
            <span className="text-[15px] text-white/40">{statusText}</span>
          ) : (
            <span className="text-[15px] text-white/50 font-mono tracking-wide flex items-center gap-1.5">
              <NetworkDot quality={networkQuality} reconnecting={reconnecting} />
              {statusText}
            </span>
          )}
        </div>
      </div>

      {/* Controls */}
      {!isEnded && (
        <div className="px-6 pb-8 safe-bottom">
          <div className="flex items-center justify-evenly mb-8 max-w-sm mx-auto">
            <CallControl icon={MoreHorizontal} onClick={() => setShowMore(true)} label="More" />
            <CallControl icon={isScreenSharing ? MonitorOff : Monitor} active={isScreenSharing} onClick={handleToggleScreenShare} label="Share" testId="call-screenshare-btn" />
            <CallControl icon={Volume2} active={speakerOn} onClick={() => useCallStore.getState().toggleSpeaker()} label="Speaker" />
            <CallControl icon={isMuted ? MicOff : Mic} active={isMuted} onClick={handleToggleMute} label={isMuted ? 'Unmute' : 'Mute'} testId="call-mute-btn" />
          </div>

          <div className="flex justify-center">
            <button onClick={handleEnd} data-testid="call-end-btn" aria-label="End call" className="w-[72px] h-[72px] rounded-full bg-[#EF4444] flex items-center justify-center shadow-lg shadow-red-500/20 active:scale-90 transition-transform">
              <PhoneOff size={32} className="text-white" />
            </button>
          </div>
        </div>
      )}

      {/* E2E encryption badge */}
      <div className="flex items-center justify-center gap-1.5 pb-6 safe-bottom">
        <Lock size={11} className="text-white/20" />
        <span className="text-[11px] text-white/20">End-to-end encrypted</span>
      </div>

      {/* More options bottom sheet */}
      <AnimatePresence>
        {showMore && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999]" onClick={() => setShowMore(false)}
          >
            <div className="absolute inset-0 bg-black/40" />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-0 left-0 right-0 bg-[#1A1A1A] rounded-t-2xl safe-bottom"
            >
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mt-3 mb-4" />
              <div className="px-2 pb-6">
                <p className="text-[11px] text-white/30 text-center mb-4 flex items-center justify-center gap-1">
                  <Lock size={10} /> End-to-end encrypted
                </p>
                <button
                  onClick={() => { handleToggleScreenShare(); setShowMore(false); }}
                  className="w-full flex items-center gap-4 px-5 py-3.5 rounded-xl hover:bg-white/5 transition-colors"
                >
                  {isScreenSharing
                    ? <MonitorUp size={20} className="text-[#10B981]" />
                    : <Monitor size={20} className="text-white/70" />}
                  <span className="text-[15px] text-white">{isScreenSharing ? 'Stop sharing' : 'Share screen'}</span>
                </button>
                <button
                  onClick={() => { setShowMore(false); handleMinimize(); }}
                  className="w-full flex items-center gap-4 px-5 py-3.5 rounded-xl hover:bg-white/5 transition-colors"
                >
                  <MessageSquare size={20} className="text-white/70" />
                  <span className="text-[15px] text-white">Send message</span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};

export default ActiveCallView;
