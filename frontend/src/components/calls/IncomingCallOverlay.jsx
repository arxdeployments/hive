import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, Video, PhoneOff } from 'lucide-react';
import useCallStore from '../../stores/callStore';
import wsClient from '../../services/websocket';
import webrtcManager from '../../services/webrtcManager';
import callSounds from '../../services/callSounds';
import client from '../../api/client';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

/**
 * Initializes WebRTC peer connection for 1:1 calls.
 * IMPORTANT: Callbacks are set BEFORE getLocalMedia to prevent race conditions.
 */
async function startWebRTC(callId, callType, remoteUserId, userId, isInitiator) {
  try {
    let iceServers;
    try {
      const { data } = await client.get('/api/calls/ice-servers');
      iceServers = data.iceServers;
    } catch {
      iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ];
    }

    const isPolite = userId < remoteUserId;
    await webrtcManager.initialize(iceServers, isPolite);

    // 1. Set up signaling callbacks FIRST (before adding tracks)
    webrtcManager.onIceCandidate = (candidate) => {
      console.log('[WebRTC] Sending ICE candidate to', remoteUserId.substring(0, 6));
      wsClient.send({
        type: 'webrtc:ice-candidate', call_id: callId,
        target_id: remoteUserId, candidate
      });
    };

    webrtcManager.onNegotiationNeeded = (description) => {
      console.log('[WebRTC] Negotiation needed, sending', description.type);
      wsClient.send({
        type: description.type === 'offer' ? 'webrtc:offer' : 'webrtc:answer',
        call_id: callId, target_id: remoteUserId, sdp: description
      });
    };

    webrtcManager.onRemoteStream = (stream) => {
      console.log('[WebRTC] Remote stream received, tracks:', stream.getTracks().map(t => t.kind).join(', '));
      webrtcManager._latestRemoteStream = stream;
      if (webrtcManager._onRemoteStreamUI) {
        webrtcManager._onRemoteStreamUI(stream);
      }
    };

    webrtcManager.onConnectionStateChange = (state) => {
      console.log('[WebRTC] ICE state:', state);
      if (state === 'connected' || state === 'completed') {
        useCallStore.getState().callConnected();
      } else if (state === 'failed') {
        if (webrtcManager._iceRestartAttempts > 3) {
          wsClient.send({ type: 'call:end', call_id: callId });
          webrtcManager.cleanup();
          useCallStore.getState().endCall();
        }
      }
    };

    // 2. Get local media (this adds tracks → triggers onnegotiationneeded for initiator)
    console.log('[WebRTC] Getting local media, type:', callType);
    await webrtcManager.getLocalMedia(callType);
    console.log('[WebRTC] Local media acquired');

    // onnegotiationneeded auto-creates offer via Perfect Negotiation
    // No manual createOffer() needed
  } catch (err) {
    console.error('[WebRTC] Failed to start:', err);
    useCallStore.getState().endCall();
  }
}

// Expose for websocket.js to call when call:accepted received
window._rxhiveStartWebRTC = startWebRTC;

export const IncomingCallOverlay = () => {
  const { callState, callId, callType, incomingCaller, showCallUI, isGroupCall } = useCallStore();

  const isVisible = callState === 'incoming_ringing' && showCallUI;

  // Play ringtone
  useEffect(() => {
    if (isVisible) callSounds.playRingtone();
    return () => callSounds.stopAll();
  }, [isVisible]);

  if (!isVisible) return null;

  const name = incomingCaller?.display_name || 'Unknown';
  const initial = name.charAt(0).toUpperCase();
  const avatarUrl = incomingCaller?.avatar_url;
  const typeLabel = callType === 'video' ? 'Incoming video call' : 'Incoming voice call';

  const handleAccept = async () => {
    callSounds.stopAll();
    const userId = JSON.parse(localStorage.getItem('user') || '{}').id;

    if (isGroupCall) {
      wsClient.send({ type: 'call:join', call_id: callId });
      useCallStore.getState().acceptCall();
      useCallStore.getState().callConnected();

      const meshMgr = (await import('../../services/meshCallManager')).default;
      let iceServers;
      try { const { data } = await client.get('/api/calls/ice-servers'); iceServers = data.iceServers; }
      catch { iceServers = [{ urls: 'stun:stun.l.google.com:19302' }]; }

      const constraints = {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: callType === 'video' ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false
      };
      try {
        const localStream = await navigator.mediaDevices.getUserMedia(constraints);
        await meshMgr.initialize(localStream, iceServers, userId);
        meshMgr.onIceCandidate = (targetId, candidate) => {
          wsClient.send({ type: 'webrtc:ice-candidate', call_id: callId, target_id: targetId, candidate });
        };
        meshMgr.onNegotiationNeeded = (targetId, description) => {
          wsClient.send({
            type: description.type === 'offer' ? 'webrtc:offer' : 'webrtc:answer',
            call_id: callId, target_id: targetId, sdp: description
          });
        };
      } catch (err) {
        console.error('[Mesh] Failed:', err);
        useCallStore.getState().endCall();
      }
    } else {
      wsClient.send({ type: 'call:accept', call_id: callId });
      useCallStore.getState().acceptCall();
      await startWebRTC(callId, callType, incomingCaller?.id, userId, false);
    }
  };

  const handleDecline = () => {
    callSounds.stopAll();
    wsClient.send({ type: 'call:decline', call_id: callId });
    webrtcManager.cleanup();
    useCallStore.getState().resetCall();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="fixed inset-0 z-[9999] flex flex-col items-center justify-center"
        style={{ background: 'linear-gradient(180deg, #1a3a2a 0%, #0A0A0A 40%, #0A0A0A 100%)' }}
      >
        {/* Avatar with pulse */}
        <motion.div
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ repeat: Infinity, duration: 2, ease: 'easeInOut' }}
          className="w-32 h-32 rounded-full overflow-hidden border-[3px] border-white/10 shadow-[0_0_60px_rgba(16,185,129,0.2)] mb-6"
        >
          {avatarUrl ? (
            <img src={avatarUrl.startsWith('http') ? avatarUrl : `${backendUrl}${avatarUrl}`}
              alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full bg-gradient-to-br from-[#10B981]/30 to-[#10B981]/10 flex items-center justify-center text-[#10B981] text-5xl font-semibold">
              {initial}
            </div>
          )}
        </motion.div>

        <h2 className="text-[22px] font-semibold text-white mb-1.5">{name}</h2>
        <p className="text-[15px] text-white/50 mb-20 flex items-center gap-1">
          {typeLabel}
          <span className="inline-flex gap-0.5 ml-0.5">
            <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '200ms' }} />
            <span className="w-1 h-1 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '400ms' }} />
          </span>
        </p>

        {/* Accept / Decline */}
        <div className="flex items-center gap-20">
          <div className="flex flex-col items-center gap-2">
            <button onClick={handleDecline} data-testid="call-decline-btn"
              aria-label={`Decline ${callType} call from ${name}`}
              className="w-[72px] h-[72px] rounded-full bg-[#EF4444] flex items-center justify-center shadow-lg shadow-red-500/20 active:scale-90 transition-transform">
              <PhoneOff size={32} className="text-white" />
            </button>
            <span className="text-xs text-white/50">Decline</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <button onClick={handleAccept} data-testid="call-accept-btn"
              aria-label={`Accept ${callType} call from ${name}`}
              className="w-[72px] h-[72px] rounded-full bg-[#10B981] flex items-center justify-center shadow-lg shadow-emerald-500/20 active:scale-90 transition-transform">
              {callType === 'video' ? <Video size={32} className="text-white" /> : <Phone size={32} className="text-white" />}
            </button>
            <span className="text-xs text-white/50">Accept</span>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
