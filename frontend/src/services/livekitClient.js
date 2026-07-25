import {
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
} from 'livekit-client';
import client from '../api/client';
import useCallStore from '../stores/callStore';

/**
 * Why a join failed, so the UI can say something actionable instead of
 * "Could not connect the call". The two causes that account for nearly every
 * real report of "calls don't work" are a stopped SFU (`sfu_unreachable`) and a
 * blocked microphone (`permission_denied`) — telling them apart is the whole
 * point of this class.
 */
export class CallJoinError extends Error {
  constructor(reason, message, cause) {
    super(message);
    this.name = 'CallJoinError';
    this.reason = reason;
    this.cause = cause;
  }
}

// getUserMedia / LiveKit device failures → our reason vocabulary.
const MEDIA_ERROR_REASONS = {
  NotAllowedError: 'permission_denied',
  PermissionDeniedError: 'permission_denied',
  SecurityError: 'permission_denied',
  NotFoundError: 'device_missing',
  DevicesNotFoundError: 'device_missing',
  OverconstrainedError: 'device_missing',
  NotReadableError: 'device_busy',
  TrackStartError: 'device_busy',
};

const mediaErrorReason = (err) => MEDIA_ERROR_REASONS[err?.name] || 'media_failed';

/**
 * LiveKit's ConnectionError carries a `reasonName`; anything we can't place is
 * treated as the SFU being unreachable, because that is what it looks like from
 * the user's seat and it points at the right thing to check first.
 */
const connectErrorReason = (err) => {
  if (err?.name !== 'ConnectionError') return 'sfu_unreachable';
  switch (err.reasonName) {
    case 'NotAllowed':
      return 'sfu_rejected';
    case 'ServerUnreachable':
    case 'WebSocket':
    case 'ServiceNotFound':
    case 'Timeout':
      return 'sfu_unreachable';
    default:
      return 'sfu_error';
  }
};

// Media layer for calls: the backend mints a scoped room token, this service
// connects to the LiveKit SFU and mirrors room state into callStore so the
// call UI just renders store state. Replaces webrtcManager + meshCallManager.
class LiveKitClient {
  constructor() {
    this.room = null;
    this.callId = null;
    this._screenSharePublication = null;
  }

  /**
   * Join the SFU room for `callId` and publish local media.
   *
   * A voice call must never touch the camera: `wantVideo` is false for
   * callType 'voice', so getUserMedia is asked for audio only and no camera
   * permission prompt appears.
   *
   * Throws {@link CallJoinError} when the call cannot carry media at all
   * (SFU down, token refused, microphone blocked). A camera that fails while
   * the microphone works is *not* fatal — the call degrades to audio and
   * reports `cameraUnavailable` so the UI can say so.
   *
   * @returns {Promise<{cameraUnavailable: boolean, reason?: string}>}
   */
  async joinCall(callId, { audio = true, video } = {}) {
    if (this.room && this.callId === callId) return { cameraUnavailable: false };
    await this.leave();

    const callStore = useCallStore.getState();
    const wantVideo = video ?? callStore.callType === 'video';

    let data;
    try {
      ({ data } = await client.post(`/api/calls/${callId}/token`));
    } catch (err) {
      const status = err?.response?.status;
      throw new CallJoinError(
        status === 404 || status === 400 ? 'call_unavailable' : 'token_failed',
        `token request failed (${status ?? 'network error'})`,
        err
      );
    }
    const url = import.meta.env.VITE_LIVEKIT_URL || data.url;

    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
    });
    this.room = room;
    this.callId = callId;

    this._wireRoomEvents(room);

    try {
      await room.connect(this._absoluteUrl(url), data.token);
    } catch (err) {
      await this.leave();
      throw new CallJoinError(
        connectErrorReason(err),
        `could not reach the SFU at ${this._absoluteUrl(url)}`,
        err
      );
    }

    const { cameraUnavailable, reason } = await this._publishLocalMedia(room, {
      audio,
      wantVideo,
    });

    useCallStore.setState({
      isMuted: !audio,
      isCameraOn: wantVideo && !cameraUnavailable,
      localStream: this._localStream(),
    });
    callStore.callConnected();
    return { cameraUnavailable, reason };
  }

  /**
   * Acquire and publish the local tracks. Failing to open the camera on a video
   * call falls back to audio; failing to open the microphone is fatal, because
   * a call nobody can hear you on is not a call — and silently swallowing that
   * (as this used to) is exactly what makes a blocked mic look like "the call
   * won't connect".
   */
  async _publishLocalMedia(room, { audio, wantVideo }) {
    const publish = async (tracks) => {
      for (const track of tracks) {
        await room.localParticipant.publishTrack(track);
      }
    };

    try {
      await publish(await createLocalTracks({ audio, video: wantVideo }));
      return { cameraUnavailable: false };
    } catch (err) {
      const reason = mediaErrorReason(err);
      if (!wantVideo || !audio) {
        console.error('[LiveKit] microphone unavailable:', err);
        await this.leave();
        throw new CallJoinError(reason, `could not acquire local media (${err?.name})`, err);
      }
      // Video call, media failed — retry without the camera before giving up.
      console.warn('[LiveKit] camera+mic failed, retrying audio-only:', err);
      try {
        await publish(await createLocalTracks({ audio, video: false }));
        return { cameraUnavailable: true, reason };
      } catch (audioErr) {
        console.error('[LiveKit] microphone unavailable:', audioErr);
        await this.leave();
        throw new CallJoinError(
          mediaErrorReason(audioErr),
          `could not acquire local media (${audioErr?.name})`,
          audioErr
        );
      }
    }
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
