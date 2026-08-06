import {
  Room,
  RoomEvent,
  Track,
  ConnectionState,
  DisconnectReason,
  createLocalTracks,
} from 'livekit-client';
import client from '../api/client';
import {
  notifyCameraToggleFailed,
  notifyMicToggleFailed,
  notifyScreenShareFailed,
  notifyScreenShareStopFailed,
} from '../utils/callErrors';
import useCallStore, { deviceId, LINK_OK, LINK_RECONNECTING } from '../stores/callStore';

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

/**
 * Disconnect reasons that mean the server has decided, so re-joining would only
 * be refused again — or worse, loop. Everything else (a network partition, an SFU
 * restart, a signal timeout) is worth retrying, because the call row is still
 * `connected` on the API and the peer is still sitting there waiting.
 */
const TERMINAL_DISCONNECT_REASONS = new Set([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.ROOM_DELETED,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_CLOSED,
].filter((r) => r !== undefined));

/**
 * Microphone constraints, stated explicitly rather than left to `audio: true`.
 *
 * These match LiveKit's own defaults today, so this changes no behaviour — it makes
 * the behaviour legible and pins it. Echo cancellation is the one setting whose
 * silent regression is most expensive to diagnose: a dependency bump that flipped a
 * default would present as "the call echoes" with nothing in the diff to point at,
 * and echo is the symptom users report most confidently and least precisely.
 *
 * `false` (mic off) is passed straight through — constraints on a track we are not
 * asking for would make getUserMedia open the microphone anyway.
 */
const audioCaptureOptions = (audio) =>
  audio
    ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    : false;

// How hard to try to get back into a room we were dropped from, and how long to
// wait between attempts. Sized to sit inside the server's reconnect grace window
// (services/calls.RECONNECT_GRACE_SECONDS = 40s) so the call row is still live
// when the last attempt runs: ~1 + 2 + 4 + 8 + 8 = 23s of retrying plus the
// connect attempts themselves.
const REJOIN_ATTEMPTS = 5;
const REJOIN_DELAYS_MS = [1000, 2000, 4000, 8000, 8000];

// Media layer for calls: the backend mints a scoped room token, this service
// connects to the LiveKit SFU and mirrors room state into callStore so the
// call UI just renders store state. Replaced the earlier webrtcManager +
// meshCallManager, both now deleted.
class LiveKitClient {
  constructor() {
    this.room = null;
    this.callId = null;
    /** The room identity the server minted for this device: `{userId}#{deviceId}`. */
    this.identity = null;
    this._joinOptions = null;
    this._rejoinTimer = null;
    this._rejoining = false;
    this._watchdog = null;
    /**
     * The camera the user last chose, as getUserMedia constraints.
     *
     * Needed because turning the camera off and on again does not always reuse the
     * same track. `setCameraEnabled(false)` mutes the publication, and `unmute()`
     * restarts it from the track's own remembered constraints — that path keeps the
     * selection on its own. But when there is NO publication to unmute (a call joined
     * as voice, or a track the SDK dropped and the room re-published), the SDK falls
     * back to `createTracks({video: true})`, which means the platform default: the
     * front camera. So a user who switched to the back camera, turned it off and
     * turned it on again could silently get the front camera pointed at their face.
     * Remembered here and passed explicitly so both paths agree.
     */
    this._cameraOptions = null;
    /**
     * Serialises camera on/off so rapid taps cannot interleave.
     *
     * The SDK locks internally (`muteLock`, and `setTrackEnabled` awaits
     * `republishPromise`), which stops two operations corrupting a publication — but
     * it does not stop *ours* finishing out of order, and the last one to finish is
     * what writes the store and tells the peers. Two taps inside one animation frame
     * would then leave the button, the room and the far side disagreeing. A chain
     * gives a well-defined last writer: the last tap.
     */
    this._cameraQueue = Promise.resolve();
    /** The same, for the microphone. See `_cameraQueue` above for why. */
    this._micQueue = Promise.resolve();
    /** Last quality grade relayed to the peer, so only changes go on the wire. */
    this._lastReportedQuality = null;
    /**
     * Called when the SFU drops us for good — after every re-join attempt has
     * failed, or for a reason that cannot be retried. Set by the signalling layer,
     * which is the only part that can tell the server the call is over; wiring it
     * the other way round would make this module import websocket.js and close an
     * import cycle.
     */
    this.onUnexpectedDisconnect = null;
    /**
     * Report our own link state / quality so the OTHER side can show it. The SFU
     * tells nobody but us that we are struggling, which is why a peer with a
     * failing network used to look perfectly healthy from across the call.
     */
    this.onLocalLinkState = null;
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
    this._cancelRejoin();
    await this.leave();

    const callStore = useCallStore.getState();
    const wantVideo = video ?? callStore.callType === 'video';
    // Remembered so a re-join after a drop reproduces the same call exactly,
    // including whether it was a voice call (asking for the camera on the way back
    // into a voice call would pop a permission prompt mid-conversation).
    this._joinOptions = { callId, audio, wantVideo };

    let data;
    try {
      ({ data } = await client.post(`/api/calls/${callId}/token`, { device_id: deviceId }));
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
    this.identity = data.identity || null;
    this._lastReportedQuality = null;

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
      localScreenStream: this._localScreenStream(),
      mediaLinkState: LINK_OK,
    });
    this._startStateWatchdog();
    callStore.callConnected();
    return { cameraUnavailable, reason };
  }

  /**
   * Poll `room.state` once a second, alongside the room events.
   *
   * Not redundancy for its own sake — the events cannot be relied on as the only
   * source, for the same reason iOS has always polled `room.connectionState`:
   *
   *  - A WebSocket closed while the network is gone parks in `CLOSING` and never
   *    fires its close event (measured: readyState 2 for a whole 70-second outage).
   *    An SDK waiting on that event emits no `Disconnected`, so an event-only client
   *    never learns the room is gone.
   *  - `RoomEvent` names drift between SDK minor versions, and a listener for a
   *    renamed event fails silently rather than at build time.
   *
   * A one-second poll over a single enum makes either of those cost a second of
   * latency instead of a call that hangs forever showing a running timer.
   */
  _startStateWatchdog() {
    this._stopStateWatchdog();
    this._watchdog = setInterval(() => {
      const room = this.room;
      if (!room) return;
      const state = room.state;
      if (state === ConnectionState.Reconnecting || state === ConnectionState.SignalReconnecting) {
        if (useCallStore.getState().mediaLinkState !== LINK_RECONNECTING) {
          console.warn('[call] watchdog: SFU link is reconnecting', { callId: this.callId });
          useCallStore.getState().setMediaLinkState(LINK_RECONNECTING);
          this.onLocalLinkState?.(this.callId, { state: LINK_RECONNECTING });
        }
        return;
      }
      if (state === ConnectionState.Disconnected) {
        // The room is gone and no `Disconnected` event arrived. Route it through the
        // same recovery the event would have, rather than inventing a second path.
        console.warn('[call] watchdog: room is disconnected with no event', {
          callId: this.callId,
        });
        this._handleUnexpectedDisconnect(DisconnectReason.UNKNOWN_REASON);
        return;
      }
      if (state === ConnectionState.Connected
        && useCallStore.getState().mediaLinkState === LINK_RECONNECTING) {
        useCallStore.getState().setMediaLinkState(LINK_OK);
        this.onLocalLinkState?.(this.callId, { state: LINK_OK });
        this._resyncAll();
      }
    }, 1000);
  }

  _stopStateWatchdog() {
    if (this._watchdog) {
      clearInterval(this._watchdog);
      this._watchdog = null;
    }
  }

  /**
   * Acquire and publish the local tracks. Failing to open the camera on a video
   * call falls back to audio; failing to open the microphone is fatal, because
   * a call nobody can hear you on is not a call — and silently swallowing that
   * (as this used to) is exactly what makes a blocked mic look like "the call
   * won't connect".
   */
  async _publishLocalMedia(room, { audio, wantVideo }) {
    /**
     * Acquire the tracks for one attempt and publish them, releasing everything
     * that attempt acquired if any part of it fails.
     *
     * `createLocalTracks` hands back live hardware, and a track whose
     * `publishTrack` rejects never reaches `trackPublications` — so nothing
     * downstream can ever stop it. `leave()` only calls `room.disconnect()`, and
     * disconnect walks publications; `setCameraEnabled` reads publications too.
     * The camera light therefore stayed on for the rest of the call with no
     * control able to turn it off, and a flapping SFU could strand one per
     * rejoin attempt.
     *
     * Tracks published BEFORE the failure are rolled back as well, not just the
     * one that threw: the loop is sequential over a getUserMedia-ordered array,
     * so the mic can already be live when the camera fails, and both callers
     * below start over from a fresh `createLocalTracks`. Leaving the first one
     * published meant the audio-only retry published a SECOND microphone — which
     * `setMicEnabled` then only half-muted.
     */
    const acquireAndPublish = async (video) => {
      const tracks = await createLocalTracks({ audio: audioCaptureOptions(audio), video });
      try {
        for (const track of tracks) {
          await room.localParticipant.publishTrack(track);
        }
      } catch (err) {
        // Release the hardware FIRST, synchronously, before anything that can
        // block. `LocalTrack.stop()` chains to `Track.stop()`, which is
        // `mediaStreamTrack.stop()`, so the camera indicator goes out here
        // rather than behind a network round trip.
        for (const track of tracks) {
          try {
            track.stop();
          } catch {
            /* already ended */
          }
        }
        // Then drop the bookkeeping for whatever DID publish before the failure,
        // so the audio-only retry cannot add a SECOND microphone publication —
        // `setMicEnabled` resolves the source to the FIRST matching publication,
        // so Mute would silently half-work and the far side would still hear us.
        //
        // `stopOnUnpublish` is false because the track is already stopped, and
        // this is deliberately NOT awaited: in livekit-client 2.20.2
        // `unpublishTrack` deletes from `trackPublications` and emits
        // `LocalTrackUnpublished` BEFORE its only `yield engine.negotiate()`, so
        // the property we need is established synchronously — while awaiting the
        // negotiate would block for `peerConnectionTimeout` (15s) against the
        // very SFU that just failed to answer, delaying both the camera release
        // above and the audio-only fallback below.
        tracks.forEach((track) => {
          try {
            const p = room.localParticipant.unpublishTrack(track, false);
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {
            /* nothing left to unpublish */
          }
        });
        throw err;
      }
    };

    try {
      // `video: wantVideo` is `true` on the first join and the remembered constraints
      // on a re-join, so coming back from a network drop reopens the camera the user
      // was actually using rather than the platform default.
      const video = wantVideo ? (this._cameraOptions || true) : false;
      await acquireAndPublish(video);
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
        await acquireAndPublish(false);
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

  /** The user half of a LiveKit identity (`{userId}#{device}`). */
  static userIdOf(identity) {
    return String(identity || '').split('#')[0];
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
        useCallStore.getState().removeRemoteParticipantByIdentity(
          participant.identity,
          LiveKitClient.userIdOf(participant.identity)
        );
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        useCallStore.setState({
          activeSpeakerIds: speakers.map((s) => LiveKitClient.userIdOf(s.identity)),
        });
      })
      .on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
        if (!participant?.isLocal) return;
        const map = { excellent: 'excellent', good: 'good', poor: 'poor' };
        const mapped = map[quality] || 'good';
        // Relay only on an actual change of grade.
        //
        // The socket accepts 120 frames a minute (hub.RATE_LIMIT_PER_MINUTE) and then
        // starts refusing them — including `call:end`. A flapping connection is exactly
        // when this event fires most and exactly when the user is most likely to reach
        // for the hang-up button, so an unthrottled telemetry frame could spend the
        // budget that the controls need.
        if (this._lastReportedQuality === mapped) return;
        this._lastReportedQuality = mapped;
        useCallStore.setState({ networkQuality: mapped });
        // Tell the peer. Their UI has no other way to learn our uplink is bad,
        // and a frozen picture with no explanation reads as a broken app.
        this.onLocalLinkState?.(this.callId, { quality: mapped });
      })

      // ---- Reconnection ------------------------------------------------------
      //
      // These three were not wired at all, and their absence was the difference
      // between a call that survives a dead spot and one that dies in it. LiveKit
      // re-establishes the session by itself; all that was missing was saying so.
      .on(RoomEvent.Reconnecting, () => {
        console.warn('[call] SFU link lost, reconnecting', { callId: this.callId });
        useCallStore.getState().setMediaLinkState(LINK_RECONNECTING);
        this.onLocalLinkState?.(this.callId, { state: LINK_RECONNECTING });
      })
      // Signal-only interruption. Usually invisible to the user and usually
      // recovered without media ever stopping, so it is reported but not shouted
      // about — `Reconnected` clears it either way.
      .on(RoomEvent.SignalReconnecting, () => {
        console.info('[call] SFU signal link reconnecting', { callId: this.callId });
        this.onLocalLinkState?.(this.callId, { quality: 'poor' });
      })
      .on(RoomEvent.Reconnected, () => {
        console.info('[call] SFU link restored', { callId: this.callId });
        useCallStore.getState().setMediaLinkState(LINK_OK);
        this.onLocalLinkState?.(this.callId, { state: LINK_OK });
        // The roster can have moved on while we were away — someone left, someone
        // joined, tracks were republished. Rebuild it from the room rather than
        // trusting the deltas we did not receive.
        this._resyncAll();
      })

      .on(RoomEvent.Disconnected, (reason) => {
        useCallStore.setState({ localStream: null, localScreenStream: null, activeSpeakerIds: [] });

        // An unexpected disconnect has to reach call state, not just clear media.
        //
        // This handler used to stop at the two setState fields, so when the SFU
        // dropped us the UI carried on showing "Connecting" — or a running duration
        // timer over dead audio — with no error and no way out.
        //
        // `leave()` nulls `this.room` before it calls `room.disconnect()`, so a
        // disconnect we asked for arrives here with no room and is ignored. Only a
        // drop we did not initiate gets through.
        if (!this.room) return;
        console.warn('[call] SFU disconnected', { reason, callId: this.callId });
        this._handleUnexpectedDisconnect(reason);
      })
      // Both directions go through the same derivation. A publish that only ever
      // wrote the streams, paired with an unpublish that also cleared
      // `isScreenSharing`, is a one-way ratchet: see `_syncLocalMedia`.
      .on(RoomEvent.LocalTrackPublished, () => {
        this._syncLocalMedia();
      })
      .on(RoomEvent.LocalTrackUnpublished, () => {
        this._syncLocalMedia();
      });
  }

  /**
   * A drop we did not ask for. Try to get back in before giving up on the call.
   *
   * Previously this ended the call immediately, which meant the only recovery from
   * *any* SFU-level interruption — an SFU restart during a deploy, a laptop waking
   * from sleep, a WebSocket killed by a captive portal — was for the user to
   * redial. LiveKit's own reconnection covers the short cases; this covers the ones
   * where the session is genuinely gone but the CALL is not: the row is still
   * `connected`, the peer is still in the room, and a fresh token gets us back.
   */
  _handleUnexpectedDisconnect(reason) {
    this._stopStateWatchdog();
    const lostCallId = this.callId;
    const options = this._joinOptions;
    const terminal = TERMINAL_DISCONNECT_REASONS.has(reason);

    // Drop the room object but keep the intent, so a re-join is a clean connect.
    const room = this.room;
    this.room = null;
    this.callId = null;
    this.identity = null;
    // Not awaited (this runs from an event handler) and explicitly caught: it rejects
    // when the transport is already gone, which is the normal case here, and an
    // unhandled rejection would surface as a spurious error in the console during
    // every recovery.
    if (room) {
      try {
        const p = room.disconnect();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch { /* already gone */ }
    }

    const store = useCallStore.getState();
    const callIsOver = store.callState === 'idle' || store.callState === 'ended';
    if (terminal || callIsOver || !options || store.callId !== lostCallId) {
      this._finalizeDisconnect(lostCallId, reason);
      return;
    }

    store.setMediaLinkState(LINK_RECONNECTING);
    this.onLocalLinkState?.(lostCallId, { state: LINK_RECONNECTING });
    this._attemptRejoin(options, 0, reason);
  }

  _attemptRejoin(options, attempt, reason) {
    if (attempt >= REJOIN_ATTEMPTS) {
      console.error('[call] gave up rejoining the SFU', { callId: options.callId, reason });
      this._finalizeDisconnect(options.callId, reason);
      return;
    }
    const delay = REJOIN_DELAYS_MS[Math.min(attempt, REJOIN_DELAYS_MS.length - 1)];
    this._rejoinTimer = setTimeout(async () => {
      this._rejoinTimer = null;
      const store = useCallStore.getState();
      // The user hung up, or moved to another call, while we were waiting.
      if (store.callId !== options.callId
        || store.callState === 'idle' || store.callState === 'ended') {
        return;
      }
      this._rejoining = true;
      try {
        console.info('[call] rejoining the SFU', { callId: options.callId, attempt: attempt + 1 });
        // Come back as the user LEFT it, not as they started.
        //
        // `options` is the original join intent, captured once. Re-joining from it
        // undid every media choice made since: a camera turned off before a tunnel
        // came back on by itself on the other side, and a muted microphone came back
        // live — which is the worse of the two. `wantVideo` still gates the camera, so
        // a voice call never opens one on the way back in.
        const wasMuted = store.isMuted;
        await this.joinCall(options.callId, {
          audio: true,
          video: options.wantVideo && store.isCameraOn,
        });
        // The microphone is always re-PUBLISHED and then re-muted, rather than not
        // published at all. "Muted" in LiveKit is a live publication with a muted
        // track: the peers see a mic that is off, and unmuting later is a local
        // operation on a track that already exists. Joining with `audio: false` would
        // instead leave the far side seeing no microphone whatsoever.
        if (wasMuted) await this.setMicEnabled(false);
        console.info('[call] rejoined', options.callId);
      } catch (err) {
        // `call_unavailable` means the API says this call is finished — retrying
        // cannot help and would only delay telling the user.
        if (err?.reason === 'call_unavailable') {
          this._finalizeDisconnect(options.callId, reason);
          return;
        }
        console.warn('[call] rejoin attempt failed', err?.reason || err);
        this._attemptRejoin(options, attempt + 1, reason);
      } finally {
        this._rejoining = false;
      }
    }, delay);
  }

  _cancelRejoin() {
    if (this._rejoinTimer) {
      clearTimeout(this._rejoinTimer);
      this._rejoinTimer = null;
    }
  }

  _finalizeDisconnect(callId, reason) {
    this._joinOptions = null;
    this._cancelRejoin();
    useCallStore.setState({
      localStream: null,
      localScreenStream: null,
      isScreenSharing: false,
      activeSpeakerIds: [],
      mediaLinkState: LINK_OK,
    });
    this.onUnexpectedDisconnect?.(callId, reason);
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

  /**
   * The local SCREEN SHARE, kept separate from `_localStream`.
   *
   * `_localStream` deliberately excludes the screen-share source — it feeds the camera
   * tile, and a self-view of your own shared screen is a hall of mirrors. But nothing
   * exposed the share itself, so the grid fell back to
   * `screenStream: isScreenSharing ? localStream : null`, which handed it the CAMERA
   * track and rendered it with the share's icon and letterboxing. Sharing your screen
   * showed you your own face, labelled as your screen, and never showed what the other
   * side was actually seeing.
   */
  _localScreenStream() {
    if (!this.room) return null;
    const stream = new MediaStream();
    this.room.localParticipant.trackPublications.forEach((pub) => {
      if (pub.source === Track.Source.ScreenShare && pub.track?.mediaStreamTrack) {
        stream.addTrack(pub.track.mediaStreamTrack);
      }
    });
    return stream.getTracks().length ? stream : null;
  }

  /**
   * Write the local media state — both streams AND `isScreenSharing` — from the room's
   * own publications, rather than trusting whoever last called start/stop.
   *
   * The flag has to be derived because publications change without anyone asking, in
   * both directions:
   *
   *  - A share can END on its own. The browser's "Stop sharing" bar, or closing the
   *    shared tab or window, ends the MediaStreamTrack, and livekit-client's
   *    `handleTrackEnded` unpublishes the ScreenShare source itself — no call to
   *    `stopScreenShare()`. So `localScreenStream` correctly went null while the flag
   *    stayed true, leaving the store claiming a share with no publication behind it.
   *    The Share button kept reading "Stop sharing", and because its click handler
   *    branches on the flag, the next press called `stopScreenShare()` on an
   *    already-stopped share: it looked dead, and sharing only resumed on a second press.
   *  - A share can be REPUBLISHED on its own. Recovering a dropped signal connection
   *    runs `republishAllTracks()`, which unpublishes every publication and immediately
   *    publishes it again — screen share included (it is exempt from the track *restart*
   *    inside that loop, not from the republish). That is an unpublished event followed
   *    by a published event, so clearing the flag on unpublish without restoring it on
   *    publish left it false with the share still running and still on the wire: the
   *    button read "Share screen" mid-share, pressing it asked the browser for a SECOND
   *    share instead of stopping the first, and `localCovered` in ActiveCallView put an
   *    avatar over the local tile of a call that was actively sharing a screen.
   *
   * Deriving on every publish and unpublish also makes this order-independent, which
   * matters because `republishAllTracks` runs its per-publication cycles under
   * `Promise.all` — the events interleave. Each one re-reads the whole publication set,
   * so whichever fires last leaves the flag right.
   */
  _syncLocalMedia() {
    const screenStream = this._localScreenStream();
    useCallStore.setState({
      localStream: this._localStream(),
      localScreenStream: screenStream,
      isScreenSharing: !!screenStream,
    });
  }

  /** Rebuild every remote tile from the room. Used after a reconnect, when the
   *  deltas we would normally apply were delivered to nobody. */
  _resyncAll() {
    if (!this.room) return;
    const present = new Set();
    this.room.remoteParticipants.forEach((participant) => {
      present.add(LiveKitClient.userIdOf(participant.identity));
      this._syncParticipant(participant);
    });
    // Anyone the room no longer knows about but who still has media attached here
    // left while we were disconnected. Signalled-only participants (no stream) are
    // kept: they are people the server says are on the call but who have not
    // published yet, and they belong on screen as placeholders.
    const store = useCallStore.getState();
    store.remoteParticipants
      .filter((p) => p.stream && !present.has(p.id))
      .forEach((p) => store.removeRemoteParticipant(p.id));
    // Local media too, not just the roster. `Reconnected` is emitted *after*
    // `republishAllTracks()` has resolved (Room.handleSignalRestarted awaits it), so
    // this is the authoritative correction point for a screen share that was
    // unpublished and republished while we were away.
    this._syncLocalMedia();
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

    // Tiles are keyed by USER id, not by LiveKit identity, so the socket's
    // `participant_joined` (which carries the avatar) and the room's roster (which
    // carries the media) describe the same tile. The identity is kept alongside so
    // a disconnect can be matched to the connection it belongs to.
    const userId = LiveKitClient.userIdOf(participant.identity);
    const callStore = useCallStore.getState();
    const existing = callStore.remoteParticipants.find((p) => p.id === userId);
    callStore.addRemoteParticipant({
      id: userId,
      identity: participant.identity,
      display_name: participant.name || existing?.display_name || 'Participant',
      avatar_url: existing?.avatar_url ?? null,
      stream: stream.getTracks().length ? stream : null,
      screenStream,
      isMuted,
      isCameraOff: !hasVideo,
      hasMedia: true,
    });
  }

  /**
   * Unblock audio playback after the browser refused it for want of a user
   * gesture. LiveKit requires this be called from within a gesture handler —
   * CallAudioSink drives it from a document-level pointerdown/keydown.
   *
   * Deliberately swallows everything: it is called speculatively on gestures
   * that may have nothing to do with a call, and there is no room (or no
   * blocked audio) most of the time.
   */
  startAudio() {
    if (!this.room || typeof this.room.startAudio !== 'function') return;
    try {
      const p = this.room.startAudio();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* nothing actionable — the retry loop in CallAudioSink covers it */
    }
  }

  /**
   * Mute or unmute the local microphone.
   *
   * Returns the state actually REACHED, which is not always the state asked for:
   * unmuting reopens the device when the browser has ended the track underneath
   * us — permission revoked mid-call, a headset dropped, another app seizing the
   * input — and that is exactly where it throws. It used to throw straight past
   * every caller (all of them fire-and-forget) into an unhandled rejection,
   * while the socket frame had already told the peer the state it never got to.
   *
   * Optimistic and serialised, exactly as `setCameraEnabled` is and for the same
   * reasons — callers (ActiveCallView, MinimizedCallBanner) read their target back
   * out of the store, so the flag has to move before the next tap reads it, and the
   * operations have to finish in tap order for the last tap to own the final state.
   * It is rolled back if the mic refuses, so the button cannot claim a state the
   * hardware is not in for longer than the attempt itself.
   */
  async setMicEnabled(enabled) {
    // Optimistic, and first — this is what makes a second tap inside the same
    // animation frame ask for the OPPOSITE state. While the flag only moved once
    // the SDK settled, two taps in a frame both computed the same target and the
    // second silently did nothing. Rolled back below if the operation fails.
    const previous = useCallStore.getState().isMuted;
    useCallStore.setState({ isMuted: !enabled });

    const run = async () => {
      // The mute button is live throughout "Connecting", when there is no room to
      // mute. Reporting the state we are still in — rather than the one that was
      // asked for — is the same rule as the failure path below: `joinCall` brings
      // the microphone up LIVE moments later, so answering `enabled` here would
      // put exactly the lie this method exists to stop back on the wire.
      if (!this.room) {
        useCallStore.setState({ isMuted: previous });
        return !previous;
      }
      try {
        await this.room.localParticipant.setMicrophoneEnabled(enabled);
        useCallStore.setState({ isMuted: !enabled });
        return enabled;
      } catch (err) {
        console.error('[LiveKit] mic toggle failed:', err);
        // Put the button back where it was rather than leaving it claiming a mic
        // state the hardware never reached.
        useCallStore.setState({ isMuted: previous });
        notifyMicToggleFailed(enabled, mediaErrorReason(err));
        // `previous` is a MUTE flag and the return is an ENABLED flag — the two are
        // opposite, unlike the camera's, where both sides of this are `isCameraOn`.
        return !previous;
      }
    };

    // Chained, so N taps produce N operations in tap order and the LAST one owns the
    // final state. Errors are swallowed into the chain so one failure cannot poison
    // every later toggle.
    this._micQueue = this._micQueue.then(run, run);
    return this._micQueue;
  }

  /**
   * Turn the local camera on or off, without touching anything else in the call.
   *
   * The audio publication, the screen share and the room connection are all
   * untouched: this mutes or unmutes exactly one publication (LiveKit's
   * `setCameraEnabled` → `LocalVideoTrack.mute()`, which also stops the underlying
   * `MediaStreamTrack` so the camera indicator light goes out) and renegotiates
   * nothing else. Remote participants learn about it twice over — natively from the
   * SFU as `TrackMuted`/`TrackUnmuted`, and over our own socket as
   * `call:media_toggle` — so a client with a wedged socket still sees it.
   *
   * Returns the state actually reached, which is not always the state asked for: the
   * camera can be held by another app, or revoked between calls.
   */
  async setCameraEnabled(enabled) {
    // Optimistic, and first: re-acquiring a camera takes long enough to feel broken
    // (`unmute()` reopens the device), and a button that does nothing for 400ms gets
    // tapped again. Rolled back below if the operation fails.
    const previous = useCallStore.getState().isCameraOn;
    useCallStore.setState({ isCameraOn: enabled });

    const run = async () => {
      if (!this.room) return enabled;
      try {
        // Pass the remembered camera when one has to be created from scratch. Ignored
        // by the SDK on the ordinary unmute path, which already has a track.
        await this.room.localParticipant.setCameraEnabled(
          enabled,
          enabled ? (this._cameraOptions || undefined) : undefined
        );
        useCallStore.setState({ isCameraOn: enabled, localStream: this._localStream() });
        return enabled;
      } catch (err) {
        console.error('[LiveKit] camera toggle failed:', err);
        // Put the button back where it was rather than leaving it lying about the
        // state of the hardware. `_localStream()` is re-read too: a failed enable can
        // still have replaced the publication.
        useCallStore.setState({ isCameraOn: previous, localStream: this._localStream() });
        if (enabled) notifyCameraToggleFailed(mediaErrorReason(err));
        return previous;
      }
    };

    // Chained, so N taps produce N operations in tap order and the LAST one owns the
    // final state. Errors are swallowed into the chain so one failure cannot poison
    // every later toggle.
    this._cameraQueue = this._cameraQueue.then(run, run);
    return this._cameraQueue;
  }

  async startScreenShare() {
    if (!this.room) return false;
    try {
      await this.room.localParticipant.setScreenShareEnabled(true);
      useCallStore.setState({ isScreenSharing: true, localScreenStream: this._localScreenStream() });
      return true;
    } catch (err) {
      console.error('[LiveKit] screen share failed:', err);
      notifyScreenShareFailed(err);
      return false;
    }
  }

  async stopScreenShare() {
    if (!this.room) return;
    try {
      await this.room.localParticipant.setScreenShareEnabled(false);
      useCallStore.setState({ isScreenSharing: false, localScreenStream: null });
    } catch (err) {
      // Called fire-and-forget from the Share control, so a rejection here was an
      // unhandled rejection with nothing on screen. The share is still published
      // when this throws, so the flag is deliberately left alone — the setState
      // stays inside the try, and `_syncLocalMedia` corrects it if the
      // publication does go away.
      console.error('[LiveKit] stop screen share failed:', err);
      notifyScreenShareStopFailed();
    }
  }

  /**
   * Switch between the front and back camera.
   *
   * Two things this gets right that the previous version did not:
   *
   * **It picks the camera publication, not `videoTrackPublications[0]`.** That map
   * holds the screen share too, so mid-share the flip could land on the shared
   * screen and restart it with a `facingMode` constraint — replacing what the other
   * side was watching with a camera.
   *
   * **It falls back to cycling device ids when `facingMode` is unknown.** Only mobile
   * browsers report `facingMode`; a desktop with two cameras reports nothing, so
   * asking for `facingMode: 'environment'` there either throws
   * `OverconstrainedError` or is quietly ignored, and the button appears to do
   * nothing. Ids always work, and are what a laptop actually has.
   *
   * Nothing here mirrors anything. A mirrored self-view is a rendering choice, and on
   * web the local tile is drawn untransformed for both cameras — so the back camera
   * shows the scene as captured, and what is published is the capture buffer either
   * way.
   */
  async flipCamera() {
    if (!this.room) return;
    try {
      const pub = [...this.room.localParticipant.videoTrackPublications.values()]
        .find((p) => p.source === Track.Source.Camera);
      const track = pub?.track;
      if (!track?.restartTrack) return;

      const settings = track.mediaStreamTrack?.getSettings?.() || {};
      if (settings.facingMode) {
        const next = { facingMode: settings.facingMode === 'environment' ? 'user' : 'environment' };
        await track.restartTrack(next);
        // Remembered so turning the camera off and on again comes back on THIS camera.
        // The track keeps its own constraints for the ordinary unmute, but a track that
        // has to be created from scratch would otherwise default to the front camera.
        this._cameraOptions = next;
      } else {
        // No facingMode to go on: step to the next video input.
        const cameras = (await navigator.mediaDevices.enumerateDevices())
          .filter((d) => d.kind === 'videoinput');
        if (cameras.length < 2) return;
        const index = cameras.findIndex((d) => d.deviceId === settings.deviceId);
        const next = cameras[(index + 1) % cameras.length];
        const constraints = { deviceId: { exact: next.deviceId } };
        await track.restartTrack(constraints);
        this._cameraOptions = constraints;
      }

      // Re-publish the stream into the store, because nothing else will.
      //
      // `restartTrack` swaps the underlying `MediaStreamTrack` **in place** — the
      // publication is not torn down, so neither `LocalTrackPublished` nor
      // `LocalTrackUnpublished` fires, and those two events are the only things that
      // refresh `localStream`. Without this the store keeps the MediaStream built
      // around the track that was just stopped, and the self-view goes black on the
      // first flip while the far side sees the new camera perfectly.
      useCallStore.setState({ localStream: this._localStream() });
    } catch (err) {
      console.error('[LiveKit] flipCamera failed:', err);
    }
  }

  /** True while we hold, or are trying to hold, a room for this call. */
  isEngaged(callId) {
    return (this.callId === callId && !!this.room)
      || (this._joinOptions?.callId === callId && (this._rejoining || !!this._rejoinTimer));
  }

  async leave() {
    this._cancelRejoin();
    this._stopStateWatchdog();
    this._joinOptions = null;
    const room = this.room;
    this.room = null;
    this.callId = null;
    this.identity = null;
    this._lastReportedQuality = null;
    if (room) {
      try {
        await room.disconnect();
      } catch {
        // already gone
      }
    }
    useCallStore.setState({
      localStream: null,
      localScreenStream: null,
      isScreenSharing: false,
      activeSpeakerIds: [],
      mediaLinkState: LINK_OK,
    });
  }
}

const livekitClient = new LiveKitClient();
export default livekitClient;
