/**
 * MeshCallManager - Manages multiple RTCPeerConnections for group calls (up to 6 participants).
 * Each remote participant gets their own RTCPeerConnection.
 */
class MeshCallManager {
  constructor() {
    this.peers = new Map(); // Map<userId, { pc, makingOffer, pendingCandidates }>
    this.localStream = null;
    this.remoteStreams = new Map(); // Map<userId, MediaStream>
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    this.localUserId = null;

    // Callbacks
    this.onRemoteStreamAdded = null;   // (userId, stream) => void
    this.onRemoteStreamRemoved = null; // (userId) => void
    this.onIceCandidate = null;        // (targetUserId, candidate) => void
    this.onNegotiationNeeded = null;   // (targetUserId, description) => void
    this.onConnectionStateChange = null; // (userId, state) => void
  }

  async initialize(localStream, iceServers, localUserId) {
    this.localStream = localStream;
    this.iceServers = iceServers || this.iceServers;
    this.localUserId = localUserId;
  }

  async addPeer(userId) {
    if (this.peers.has(userId)) return this.peers.get(userId).pc;

    const isPolite = this.localUserId < userId;
    const config = { iceServers: this.iceServers, iceCandidatePoolSize: 10 };
    const pc = new RTCPeerConnection(config);
    const peerState = { pc, makingOffer: false, pendingCandidates: [], isPolite };

    // Add local tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && this.onIceCandidate) {
        this.onIceCandidate(userId, event.candidate);
      }
    };

    // Remote tracks
    pc.ontrack = (event) => {
      const stream = event.streams[0];
      this.remoteStreams.set(userId, stream);
      if (this.onRemoteStreamAdded) this.onRemoteStreamAdded(userId, stream);
    };

    // Connection state
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`[Mesh] Peer ${userId.substring(0, 6)} ICE: ${state}`);
      if (this.onConnectionStateChange) this.onConnectionStateChange(userId, state);

      if (state === 'disconnected') {
        setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') pc.restartIce();
        }, 3000);
      } else if (state === 'failed') {
        pc.restartIce();
      }
    };

    // Negotiation needed
    pc.onnegotiationneeded = async () => {
      try {
        peerState.makingOffer = true;
        await pc.setLocalDescription();
        if (this.onNegotiationNeeded) this.onNegotiationNeeded(userId, pc.localDescription);
      } catch (err) {
        console.error(`[Mesh] Negotiation error for ${userId}:`, err);
      } finally {
        peerState.makingOffer = false;
      }
    };

    this.peers.set(userId, peerState);
    return pc;
  }

  removePeer(userId) {
    const peer = this.peers.get(userId);
    if (peer) {
      peer.pc.close();
      this.peers.delete(userId);
    }
    this.remoteStreams.delete(userId);
    if (this.onRemoteStreamRemoved) this.onRemoteStreamRemoved(userId);
  }

  async createOfferForPeer(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return null;
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    return peer.pc.localDescription;
  }

  async handleOfferFromPeer(userId, sdp) {
    let peer = this.peers.get(userId);
    if (!peer) {
      await this.addPeer(userId);
      peer = this.peers.get(userId);
    }
    if (!peer) return null;

    const pc = peer.pc;
    const offerCollision = sdp.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');

    if (!peer.isPolite && offerCollision) return null;
    if (offerCollision) {
      try { await pc.setLocalDescription({ type: 'rollback' }); } catch {}
    }

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    // Flush pending candidates
    for (const c of peer.pendingCandidates) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    peer.pendingCandidates = [];

    if (sdp.type === 'offer') {
      await pc.setLocalDescription();
      return pc.localDescription;
    }
    return null;
  }

  async handleAnswerFromPeer(userId, sdp) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    for (const c of peer.pendingCandidates) {
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(c)); } catch {}
    }
    peer.pendingCandidates = [];
  }

  async handleIceCandidateFromPeer(userId, candidate) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    if (peer.pc.remoteDescription) {
      try { await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    } else {
      peer.pendingCandidates.push(candidate);
    }
  }

  toggleAudio(enabled) {
    this.localStream?.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }

  toggleVideo(enabled) {
    this.localStream?.getVideoTracks().forEach(t => { t.enabled = enabled; });
  }

  getParticipantCount() {
    return this.peers.size + 1; // +1 for self
  }

  cleanup() {
    this.peers.forEach(p => p.pc.close());
    this.peers.clear();
    this.remoteStreams.clear();
    this.localStream?.getTracks().forEach(t => t.stop());
    this.localStream = null;
  }
}

const meshCallManager = new MeshCallManager();
export default meshCallManager;
