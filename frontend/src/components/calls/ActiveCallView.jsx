import React, { useRef, useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PhoneOff, Mic, MicOff, Video, Volume2, VolumeX,
  MoreHorizontal, ChevronDown, UserPlus, Lock, X,
  Monitor, Share2, MessageSquare
} from 'lucide-react';
import useCallStore from '../../stores/callStore';
import webrtcManager from '../../services/webrtcManager';
import meshCallManager from '../../services/meshCallManager';
import callSounds from '../../services/callSounds';
import wsClient from '../../services/websocket';
import { VideoGrid } from './VideoGrid';

const formatDuration = (s) => {
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
};

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

/* WhatsApp-style control button (rounded pill) */
const CallControl = ({ icon: Icon, active, onClick, label, disabled }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    className="flex flex-col items-center gap-1.5"
  >
    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center transition-all duration-200 active:scale-90 ${
      active ? 'bg-white' : 'bg-white/10 backdrop-blur-sm'
    } ${disabled ? 'opacity-40' : ''}`}>
      <Icon size={24} className={active ? 'text-[#0A0A0A]' : 'text-white'} />
    </div>
    {label && <span className="text-[11px] text-white/70">{label}</span>}
  </button>
);

export const ActiveCallView = () => {
  const {
    callState, callId, callType, callDuration, isMuted, isCameraOn,
    showCallUI, incomingCaller, isMinimized, isGroupCall, remoteParticipants
  } = useCallStore();

  const remoteAudioRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localVideoRef = useRef(null);
  const [speakerOn, setSpeakerOn] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [remoteStream, setRemoteStream] = useState(null);
  const [groupStreams, setGroupStreams] = useState(new Map());

  // Set up remote stream
  useEffect(() => {
    const handleStream = (stream) => {
      setRemoteStream(stream);
      if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
      if (callType === 'video' && remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
    };
    webrtcManager._onRemoteStreamUI = handleStream;
    if (webrtcManager._latestRemoteStream) handleStream(webrtcManager._latestRemoteStream);
    return () => { webrtcManager._onRemoteStreamUI = null; };
  }, [callType]);

  // Group streams
  useEffect(() => {
    meshCallManager.onRemoteStreamAdded = (uid, stream) => setGroupStreams(p => new Map(p).set(uid, stream));
    meshCallManager.onRemoteStreamRemoved = (uid) => setGroupStreams(p => { const m = new Map(p); m.delete(uid); return m; });
    return () => { meshCallManager.onRemoteStreamAdded = null; meshCallManager.onRemoteStreamRemoved = null; };
  }, []);

  // Local video
  useEffect(() => {
    const s = isGroupCall ? meshCallManager.localStream : webrtcManager.localStream;
    if (localVideoRef.current && s) localVideoRef.current.srcObject = s;
  }, [callState, isGroupCall]);

  // Play sounds based on state
  useEffect(() => {
    if (callState === 'connected') {
      callSounds.stopAll();
      callSounds.playConnected();
    } else if (callState === 'ended') {
      callSounds.stopAll();
      callSounds.playEnded();
    }
  }, [callState]);

  const isRinging = callState === 'outgoing_ringing';
  const isConnecting = callState === 'connecting';
  const isConnected = callState === 'connected';
  const isEnded = callState === 'ended';
  const isReconnecting = callState === 'reconnecting';
  const isVideo = callType === 'video';
  const isVisible = (isRinging || isConnecting || isConnected || isEnded) && showCallUI && !isMinimized;

  if (!isVisible) return null;

  const name = incomingCaller?.display_name || 'Call';
  const initial = name.charAt(0).toUpperCase();
  const avatarUrl = incomingCaller?.avatar_url;

  const handleEnd = () => {
    if (isRinging) {
      wsClient.send({ type: 'call:cancel', call_id: callId });
    } else {
      wsClient.send({ type: 'call:end', call_id: callId });
    }
    if (isGroupCall) meshCallManager.cleanup(); else webrtcManager.cleanup();
    callSounds.stopAll();
    useCallStore.getState().endCall();
  };

  const handleToggleMute = () => {
    const newMuted = !isMuted;
    useCallStore.getState().toggleMute();
    if (isGroupCall) meshCallManager.toggleAudio(!newMuted);
    else webrtcManager.toggleAudio(!newMuted);
    wsClient.send({ type: 'call:toggle_media', call_id: callId, media_type: 'audio', enabled: !newMuted });
  };

  const handleToggleCamera = () => {
    const newCam = !isCameraOn;
    useCallStore.getState().toggleCamera();
    if (isGroupCall) meshCallManager.toggleVideo(newCam);
    else webrtcManager.toggleVideo(newCam);
    wsClient.send({ type: 'call:toggle_media', call_id: callId, media_type: 'video', enabled: newCam });
  };

  const handleMinimize = () => {
    useCallStore.getState().toggleMinimize();
  };

  // Status text
  let statusText = '';
  if (isRinging) statusText = 'Ringing';
  else if (isConnecting) statusText = 'Connecting';
  else if (isConnected) statusText = formatDuration(callDuration);
  else if (isReconnecting) statusText = 'Reconnecting';
  else if (isEnded) statusText = 'Call ended';

  // ==================== VIDEO CALL ====================
  if (isVideo && isConnected && !isGroupCall) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9998] bg-black flex flex-col">
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
        <div className="flex-1 relative">
          <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          <div className="absolute top-4 right-4 w-[120px] h-[160px] sm:w-[150px] sm:h-[200px] rounded-xl overflow-hidden border-2 border-white/20 bg-[#1A1A1A] shadow-2xl">
            <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
          </div>
          <div className="absolute top-0 left-0 right-0 bg-gradient-to-b from-black/70 to-transparent p-4 flex items-center justify-between">
            <button onClick={handleMinimize} className="p-2 text-white/70 hover:text-white"><ChevronDown size={24} /></button>
            <div className="text-center">
              <p className="text-sm text-white font-medium">{name}</p>
              <p className="text-xs text-white/60">{statusText}</p>
            </div>
            <div className="w-10" />
          </div>
        </div>
        <div className="bg-black/80 backdrop-blur-xl px-6 py-6 safe-bottom">
          <div className="flex items-center justify-center gap-5 mb-5">
            <CallControl icon={isMuted ? MicOff : Mic} active={isMuted} onClick={handleToggleMute} label={isMuted ? 'Unmute' : 'Mute'} />
            <CallControl icon={isCameraOn ? Video : Video} active={!isCameraOn} onClick={handleToggleCamera} label="Camera" />
            <CallControl icon={Volume2} active={speakerOn} onClick={() => setSpeakerOn(!speakerOn)} label="Speaker" />
          </div>
          <div className="flex justify-center">
            <button onClick={handleEnd} className="w-16 h-16 rounded-full bg-[#EF4444] flex items-center justify-center active:scale-90 transition-transform">
              <PhoneOff size={28} className="text-white" />
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  // ==================== GROUP CALL ====================
  if (isGroupCall && isConnected) {
    const gridParticipants = remoteParticipants.map(p => ({
      id: p.id, name: p.display_name || p.id,
      stream: groupStreams.get(p.id), isMuted: p.isMuted, isCameraOff: p.isCameraOff,
    }));
    const user = JSON.parse(localStorage.getItem('user') || '{}');
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
        className="fixed inset-0 z-[9998] bg-[#0A0A0A] flex flex-col">
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0">
          <button onClick={handleMinimize} className="p-2 text-white/70"><ChevronDown size={20} /></button>
          <div className="text-center">
            <p className="text-sm text-white font-medium">Group Call</p>
            <p className="text-xs text-white/50">{remoteParticipants.length + 1} participants · {statusText}</p>
          </div>
          <div className="w-10" />
        </div>
        <VideoGrid participants={gridParticipants} localStream={meshCallManager.localStream} localName={user.name || 'You'} isMuted={isMuted} isCameraOn={isCameraOn} />
        <div className="bg-[#0A0A0A]/80 backdrop-blur-xl px-6 py-5 safe-bottom flex-shrink-0">
          <div className="flex items-center justify-center gap-5 mb-5">
            <CallControl icon={isMuted ? MicOff : Mic} active={isMuted} onClick={handleToggleMute} label={isMuted ? 'Unmute' : 'Mute'} />
            {isVideo && <CallControl icon={Video} active={!isCameraOn} onClick={handleToggleCamera} label="Camera" />}
            <CallControl icon={Volume2} active={speakerOn} onClick={() => setSpeakerOn(!speakerOn)} label="Speaker" />
          </div>
          <div className="flex justify-center">
            <button onClick={handleEnd} className="w-16 h-16 rounded-full bg-[#EF4444] flex items-center justify-center active:scale-90 transition-transform">
              <PhoneOff size={28} className="text-white" />
            </button>
          </div>
        </div>
      </motion.div>
    );
  }

  // ==================== VOICE CALL (WhatsApp Style) ====================
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[9998] flex flex-col"
      style={{ background: 'linear-gradient(180deg, #1a3a2a 0%, #0A0A0A 40%, #0A0A0A 100%)' }}
    >
      {/* Hidden audio for remote stream */}
      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />

      {/* Top bar */}
      <div className="flex items-center justify-between px-4 pt-12 pb-2 flex-shrink-0">
        <button onClick={handleMinimize} className="p-2 text-white/70 hover:text-white active:scale-90 transition-transform"
          aria-label="Minimize call">
          <ChevronDown size={24} />
        </button>
        <div className="w-10" />
        <button className="p-2 text-white/70 hover:text-white active:scale-90 transition-transform"
          aria-label="Add people">
          <UserPlus size={22} />
        </button>
      </div>

      {/* Center section - Avatar + Name + Status */}
      <div className="flex-1 flex flex-col items-center justify-center px-6">
        {/* Avatar with glow effect */}
        <motion.div
          animate={isRinging || isConnecting ? { scale: [1, 1.04, 1] } : {}}
          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          className="relative mb-6"
        >
          <div className="w-32 h-32 rounded-full overflow-hidden border-[3px] border-white/10 shadow-[0_0_60px_rgba(16,185,129,0.15)]">
            {avatarUrl ? (
              <img src={avatarUrl.startsWith('http') ? avatarUrl : `${backendUrl}${avatarUrl}`}
                alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full bg-gradient-to-br from-[#10B981]/30 to-[#10B981]/10 flex items-center justify-center text-[#10B981] text-5xl font-semibold">
                {initial}
              </div>
            )}
          </div>
        </motion.div>

        {/* Name */}
        <h2 className="text-[22px] font-semibold text-white mb-1.5 text-center">{name}</h2>

        {/* Status */}
        <div className="flex items-center gap-1.5">
          {(isRinging || isConnecting || isReconnecting) ? (
            <span className={`text-[15px] ${isReconnecting ? 'text-[#F59E0B]' : 'text-white/50'} flex items-center gap-1`}>
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
            <span className="text-[15px] text-white/50 font-mono tracking-wide">{statusText}</span>
          )}
        </div>
      </div>

      {/* Controls - WhatsApp style */}
      {!isEnded && (
        <div className="px-6 pb-8 safe-bottom">
          {/* Control buttons row */}
          <div className="flex items-center justify-evenly mb-8 max-w-sm mx-auto">
            <CallControl
              icon={MoreHorizontal}
              onClick={() => setShowMore(true)}
              label="More"
            />
            <CallControl
              icon={Video}
              onClick={handleToggleCamera}
              label="Video"
            />
            <CallControl
              icon={speakerOn ? Volume2 : Volume2}
              active={speakerOn}
              onClick={() => setSpeakerOn(!speakerOn)}
              label="Speaker"
            />
            <CallControl
              icon={isMuted ? MicOff : Mic}
              active={isMuted}
              onClick={handleToggleMute}
              label={isMuted ? 'Unmute' : 'Mute'}
            />
          </div>

          {/* End call button */}
          <div className="flex justify-center">
            <button
              onClick={handleEnd}
              aria-label="End call"
              className="w-[72px] h-[72px] rounded-full bg-[#EF4444] flex items-center justify-center shadow-lg shadow-red-500/20 active:scale-90 transition-transform"
            >
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
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999]"
            onClick={() => setShowMore(false)}
          >
            <div className="absolute inset-0 bg-black/40" />
            <motion.div
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className="absolute bottom-0 left-0 right-0 bg-[#1A1A1A] rounded-t-2xl safe-bottom"
            >
              <div className="w-10 h-1 bg-white/20 rounded-full mx-auto mt-3 mb-4" />
              <div className="px-2 pb-6">
                <p className="text-[11px] text-white/30 text-center mb-4 flex items-center justify-center gap-1">
                  <Lock size={10} /> End-to-end encrypted
                </p>
                <button className="w-full flex items-center gap-4 px-5 py-3.5 rounded-xl hover:bg-white/5 transition-colors">
                  <Monitor size={20} className="text-white/70" />
                  <span className="text-[15px] text-white">Share screen</span>
                </button>
                <button className="w-full flex items-center gap-4 px-5 py-3.5 rounded-xl hover:bg-white/5 transition-colors">
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
