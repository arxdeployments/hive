import {
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
} from 'livekit-client';
import client from '../api/client';
import useCallStore from '../stores/callStore';

// Media layer for calls: the backend mints a scoped room token, this service
// connects to the LiveKit SFU and mirrors room state into callStore so the
// call UI just renders store state. Replaces webrtcManager + meshCallManager.
class LiveKitClient {
  constructor() {
    this.room = null;
    this.callId = null;
    this._screenSharePublication = null;
  }

  async joinCall(callId, { audio = true, video } = {}) {
    if (this.room && this.callId === callId) return;
    await this.leave();

    const callStore = useCallStore.getState();
    const wantVideo = video ?? callStore.callType === 'video';

    const { data } = await client.post(`/api/calls/${callId}/token`);
    const url = import.meta.env.VITE_LIVEKIT_URL || data.url;

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    this.room = room;
    this.callId = callId;

    this._wireRoomEvents(room);

    await room.connect(this._absoluteUrl(url), data.token);

    try {
      const tracks = await createLocalTracks({ audio, video: wantVideo });
      for (const track of tracks) {
        await room.localParticipant.publishTrack(track);
      }
    } catch (err) {
      console.error('[LiveKit] media acquisition failed:', err);
    }

    useCallStore.setState({
      isMuted: !audio,
      isCameraOn: wantVideo,
      localStream: this._localStream(),
    });
    callStore.callConnected();
  }

  _absoluteUrl(url) {
    if (!url) return url;
    if (url.startsWith('ws://') || url.startsWith('wss://')) return url;
    // Path-style URL (e.g. "/livekit" behind Caddy) → same-origin websocket.
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${window.location.host}${url}`;
  }

  _wireRoomEvents(room) {
    room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        this._syncParticipant(participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        this._syncParticipant(participant);
      })
      .on(RoomEvent.TrackMuted, (publication, participant) => {
        if (!participant.isLocal) this._syncParticipant(participant);
      })
      .on(RoomEvent.TrackUnmuted, (publication, participant) => {
        if (!participant.isLocal) this._syncParticipant(participant);
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        this._syncParticipant(participant);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        useCallStore.getState().removeRemoteParticipant(participant.identity);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        useCallStore.setState({
          activeSpeakerIds: speakers.map((s) => s.identity),
        });
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (participant?.isLocal) {
          const map = { excellent: 'excellent', good: 'good', poor: 'poor' };
          useCallStore.setState({ networkQuality: map[quality] || 'good' });
        }
      })
      .on(RoomEvent.Disconnected, () => {
        useCallStore.setState({ localStream: null, activeSpeakerIds: [] });
      })
      .on(RoomEvent.LocalTrackPublished, () => {
        useCallStore.setState({ localStream: this._localStream() });
      })
      .on(RoomEvent.LocalTrackUnpublished, () => {
        useCallStore.setState({ localStream: this._localStream() });
      });
  }

  _localStream() {
    if (!this.room) return null;
    const stream = new MediaStream();
    this.room.localParticipant.trackPublications.forEach((pub) => {
      if (pub.track && pub.source !== Track.Source.ScreenShare && pub.track.mediaStreamTrack) {
        stream.addTrack(pub.track.mediaStreamTrack);
      }
    });
    return stream.getTracks().length ? stream : null;
  }

  _syncParticipant(participant) {
    const stream = new MediaStream();
    let screenStream = null;
    let hasVideo = false;
    let isMuted = true;

    participant.trackPublications.forEach((pub) => {
      if (!pub.track || !pub.track.mediaStreamTrack) return;
      if (pub.source === Track.Source.ScreenShare) {
        screenStream = new MediaStream([pub.track.mediaStreamTrack]);
        return;
      }
      stream.addTrack(pub.track.mediaStreamTrack);
      if (pub.kind === Track.Kind.Video) {
        hasVideo = !pub.isMuted;
      }
      if (pub.kind === Track.Kind.Audio) {
        isMuted = pub.isMuted;
      }
    });

    const callStore = useCallStore.getState();
    const existing = callStore.remoteParticipants.find((p) => p.id === participant.identity);
    const patch = {
      stream: stream.getTracks().length ? stream : null,
      screenStream,
      isMuted,
      isCameraOff: !hasVideo,
      display_name: participant.name || existing?.display_name,
    };
    if (existing) {
      callStore.updateRemoteParticipant(participant.identity, patch);
    } else {
      callStore.addRemoteParticipant({
        id: participant.identity,
        display_name: participant.name || 'Participant',
        avatar_url: null,
        ...patch,
      });
    }
  }

  async setMicEnabled(enabled) {
    if (!this.room) return;
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
    useCallStore.setState({ isMuted: !enabled });
  }

  async setCameraEnabled(enabled) {
    if (!this.room) return;
    await this.room.localParticipant.setCameraEnabled(enabled);
    useCallStore.setState({ isCameraOn: enabled, localStream: this._localStream() });
  }

  async startScreenShare() {
    if (!this.room) return false;
    try {
      await this.room.localParticipant.setScreenShareEnabled(true);
      useCallStore.setState({ isScreenSharing: true });
      return true;
    } catch (err) {
      console.error('[LiveKit] screen share failed:', err);
      return false;
    }
  }

  async stopScreenShare() {
    if (!this.room) return;
    await this.room.localParticipant.setScreenShareEnabled(false);
    useCallStore.setState({ isScreenSharing: false });
  }

  async flipCamera() {
    // Mobile front/back switch; no-op when unsupported.
    if (!this.room) return;
    try {
      const pub = [...this.room.localParticipant.videoTrackPublications.values()][0];
      if (pub?.track?.restartTrack) {
        const current = pub.track.mediaStreamTrack?.getSettings?.().facingMode;
        await pub.track.restartTrack({
          facingMode: current === 'environment' ? 'user' : 'environment',
        });
      }
    } catch (err) {
      console.error('[LiveKit] flipCamera failed:', err);
    }
  }

  async leave() {
    const room = this.room;
    this.room = null;
    this.callId = null;
    this._screenSharePublication = null;
    if (room) {
      try {
        await room.disconnect();
      } catch (err) {
        // already gone
      }
    }
    useCallStore.setState({
      localStream: null,
      isScreenSharing: false,
      activeSpeakerIds: [],
    });
  }
}

const livekitClient = new LiveKitClient();
export default livekitClient;
