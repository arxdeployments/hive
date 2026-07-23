import useCallStore from '../stores/callStore';
/**
 * WebRTCManager - Manages RTCPeerConnection lifecycle for 1:1 P2P calls.
 */
class WebRTCManager {
  constructor() {
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];
    this.isPolite = false;
    this.makingOffer = false;
    this.statsInterval = null;
    this._iceRestartAttempts = 0;
    this._disconnectTimer = null;
    this._savedVideoTrack = null;
    this._wakeLock = null;

    // Callbacks
    this.onIceCandidate = null;
    this.onRemoteStream = null;
    this.onNegotiationNeeded = null;
    this.onConnectionStateChange = null;
    this._onRemoteStreamUI = null;
    this._latestRemoteStream = null;
  }

  async initialize(iceServers, isPolite) {
    this.isPolite = isPolite;
    this._iceRestartAttempts = 0;

    const config = {
      iceServers: iceServers || [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
      iceCandidatePoolSize: 10,
    };

    this.peerConnection = new RTCPeerConnection(config);
    this._setupEventListeners();
    await this._requestWakeLock();
  }

  async getLocalMedia(callType) {
    const constraints = {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: callType === 'video' ? {
        facingMode: 'user',
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 30 },
      } : false,
    };

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (callType === 'video' && (err.name === 'NotAllowedError' || err.name === 'NotFoundError')) {
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({ audio: constraints.audio });
          console.warn('Camera unavailable, audio-only fallback');
        } catch (audioErr) {
          throw new Error('Microphone access required for calls');
        }
      } else {
        throw err;
      }
    }

    this.localStream.getTracks().forEach(track => {
      this.peerConnection.addTrack(track, this.localStream);
    });

    this._preferH264();
    return this.localStream;
  }

  _preferH264() {
    try {
      const transceivers = this.peerConnection.getTransceivers();
      transceivers.forEach(t => {
        if (t.sender.track?.kind === 'video') {
          const caps = RTCRtpSender.getCapabilities?.('video');
          if (caps) {
            const preferred = caps.codecs.slice().sort((a, b) => {
              if (a.mimeType.includes('H264')) return -1;
              if (b.mimeType.includes('H264')) return 1;
              return 0;
            });
            try { t.setCodecPreferences(preferred); } catch {}
          }
        }
      });
    } catch {}
  }

  _setupEventListeners() {
    const pc = this.peerConnection;

    pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(event.candidate);
      }
    };

    pc.ontrack = (event) => {
      this.remoteStream = event.streams[0];
      if (this.onRemoteStream) this.onRemoteStream(this.remoteStream);
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log('[WebRTC] ICE state:', state);
      if (this.onConnectionStateChange) this.onConnectionStateChange(state);

      if (state === 'connected' || state === 'completed') {
        this._iceRestartAttempts = 0;
        if (this._disconnectTimer) { clearTimeout(this._disconnectTimer); this._disconnectTimer = null; }
        this._startStatsMonitoring();
      } else if (state === 'disconnected') {
        this._disconnectTimer = setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') {
            console.log('[WebRTC] ICE restart after disconnect');
            pc.restartIce();
          }
        }, 3000);
      } else if (state === 'failed') {
        this._iceRestartAttempts++;
        if (this._iceRestartAttempts <= 3) {
          pc.restartIce();
        }
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        if (this.onNegotiationNeeded) this.onNegotiationNeeded(pc.localDescription);
      } catch (err) {
        console.error('[WebRTC] Negotiation error:', err);
      } finally {
        this.makingOffer = false;
      }
    };
  }

  async createOffer() {
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return this.peerConnection.localDescription;
  }

  async handleRemoteOffer(sdp) {
    const pc = this.peerConnection;
    const offerCollision = sdp.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    if (!this.isPolite && offerCollision) return null;
    if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    if (sdp.type === 'offer') {
      await pc.setLocalDescription();
      return pc.localDescription;
    }
    return null;
  }

  async handleRemoteAnswer(sdp) {
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    for (const c of this.pendingCandidates) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(c));
    }
    this.pendingCandidates = [];
  }

  async handleRemoteIceCandidate(candidate) {
    if (this.peerConnection?.remoteDescription) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      this.pendingCandidates.push(candidate);
    }
  }

  toggleAudio(enabled) {
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }

  toggleVideo(enabled) {
    this.localStream?.getVideoTracks().forEach(t => { t.enabled = enabled; });
  }

  async toggleScreenShare(enabled) {
    const sender = this.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
    if (!sender) return;
    if (enabled) {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = screen.getVideoTracks()[0];
        this._savedVideoTrack = this.localStream?.getVideoTracks()[0];
        await sender.replaceTrack(screenTrack);
        screenTrack.onended = () => this.toggleScreenShare(false);
      } catch {}
    } else if (this._savedVideoTrack) {
      await sender.replaceTrack(this._savedVideoTrack);
      this._savedVideoTrack = null;
    }
  }

  async flipCamera() {
    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (!videoTrack) return null;
    const current = videoTrack.getSettings().facingMode;
    const newFacing = current === 'user' ? 'environment' : 'user';
    try {
      const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newFacing } });
      const newTrack = newStream.getVideoTracks()[0];
      const sender = this.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
      videoTrack.stop();
      return newStream;
    } catch { return null; }
  }

  _startStatsMonitoring() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    this.statsInterval = setInterval(async () => {
      if (!this.peerConnection) return;
      try {
        const stats = await this.peerConnection.getStats();
        let lost = 0, received = 0, rtt = 0;
        stats.forEach(r => {
          if (r.type === 'inbound-rtp') { lost += r.packetsLost || 0; received += r.packetsReceived || 0; }
          if (r.type === 'candidate-pair' && r.state === 'succeeded') { rtt = r.currentRoundTripTime || 0; }
        });
        const lossRate = received > 0 ? (lost / (lost + received)) * 100 : 0;
        let quality = 'excellent';
        if (rtt > 0.3 || lossRate > 5) quality = 'poor';
        else if (rtt > 0.15 || lossRate > 2) quality = 'good';
        // Update store if available
        try { useCallStore.setState({ networkQuality: quality }); } catch {}
      } catch {}
    }, 2000);
  }

  async _requestWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this._wakeLock = await navigator.wakeLock.request('screen');
      }
    } catch {}
  }

  cleanup() {
    if (this.statsInterval) clearInterval(this.statsInterval);
    if (this._disconnectTimer) clearTimeout(this._disconnectTimer);
    this.localStream?.getTracks().forEach(t => t.stop());
    this.peerConnection?.close();
    this._wakeLock?.release();
    this.peerConnection = null;
    this.localStream = null;
    this.remoteStream = null;
    this.pendingCandidates = [];
    this._iceRestartAttempts = 0;
    this._wakeLock = null;
    this._latestRemoteStream = null;
    this._onRemoteStreamUI = null;
  }
}

const webrtcManager = new WebRTCManager();
export default webrtcManager;
