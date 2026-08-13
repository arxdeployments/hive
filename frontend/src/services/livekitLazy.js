import useCallStore from '../stores/callStore';

/**
 * Lazy façade over `services/livekitClient`, so that `livekit-client` is not
 * downloaded by people who are not on a call.
 *
 * WHY THIS EXISTS
 *
 * `livekit-client` is 527 kB of the 1,078 kB entry chunk — half of everything the
 * login screen fetches before it can draw a password field, on a product whose
 * users open it on hospital wifi. Nothing about it is needed until somebody places
 * or answers a call, but it was reachable from a static `import` in websocket.js,
 * which the app constructs at module-eval time, so every session paid for it and
 * the sessions that never called anyone paid for it twice over (parse and compile
 * as well as transfer).
 *
 * Splitting it out is only safe if the seam is invisible, and this file is that
 * seam: every method the app ever called on `livekitClient` is here with the same
 * name, the same arguments and the same return type. Consumers changed one import
 * specifier and nothing else. `services/livekitClient.js` is untouched — it is
 * still the module the two LiveKit Playwright specs fetch off the dev server, and
 * still the only thing that writes the call's media state into the store.
 *
 * THE THREE METHODS THAT MUST NOT WAIT FOR THE IMPORT
 *
 * `startAudio`, `leave` and `isEngaged` are deliberately NOT promise-chained
 * through `load()`. Each one is a case where deferring the work by the width of a
 * 138 kB download is not a slower version of the right behaviour, it is the wrong
 * behaviour — see the comment on each.
 */

/** The real client, once its chunk has arrived. Null until the first join. */
let sdk = null;

/** The in-flight import, so concurrent callers share one request. */
let pending = null;

/**
 * Handlers the signalling layer assigns. They cannot be forwarded when they are
 * set, because websocket.js assigns them in its constructor — which runs at
 * module-eval time, before any call and therefore long before `sdk` exists. Held
 * here and applied in `load()`; see the accessors at the bottom of the file for
 * why they are accessors and not plain properties.
 */
let onUnexpectedDisconnect = null;
let onLocalLinkState = null;

/**
 * Join generation, so a hang-up can cancel a join that has not started yet.
 *
 * The window this closes: `call:accepted` arrives, `isEngaged()` is false because
 * the SDK is not loaded, so `joinCall` is called and waits on the import — and
 * then the other side hangs up. `call:ended` calls `leave()`, which has no room to
 * disconnect and no client to disconnect it with, so it is a no-op; the import
 * resolves a moment later and `joinCall` runs to completion against a call that is
 * over. That is a token POST, a `room.connect`, a LIVE MICROPHONE, and a
 * `callStore.callConnected()` that puts the call UI and a running clock back on
 * screen after the user has been told the call ended (`callConnected` sets
 * `callState: 'connected'` unconditionally, which also stops `endCall`'s two-second
 * teardown timer from ever firing, because that timer only resets a call still in
 * `'ended'`).
 *
 * So `leave()` bumps the counter and a join whose import has not resolved yet
 * checks it and stands down. This restores the status quo — it does not improve on
 * it: once `sdk.joinCall()` has actually started, this counter is behind it and
 * cancellation is `sdk.leave()`'s job, exactly as today. livekitClient has no join
 * generation of its own, so a `leave()` that lands during the token POST is lost
 * today and is still lost after this change. That race is real but it is not this
 * change's to fix; what matters here is that lazy-loading does not WIDEN it.
 */
let joinSeq = 0;

/**
 * A load failure, shaped like the `CallJoinError` that `utils/callErrors` reads.
 *
 * `handleCallJoinError` branches on `error.reason`, and a failed dynamic import
 * rejects with a TypeError, which has none — so without this a user whose chunk
 * request failed got the generic "Could not connect the call", the one message
 * that names nothing to check. The class is defined here rather than imported from
 * livekitClient because importing anything from that module statically is the
 * whole thing this file exists to avoid.
 */
class MediaLoadError extends Error {
  constructor(cause) {
    super('the call media chunk could not be loaded');
    this.name = 'MediaLoadError';
    this.reason = 'media_unavailable';
    this.cause = cause;
  }
}

/**
 * Fetch the real client, once.
 *
 * `pending` is cleared when the import fails so a later call can try again: a
 * chunk request lost to a dead spot must not poison calling for the rest of the
 * session, which is what caching the rejection (React.lazy's behaviour) would do.
 */
const load = () => {
  if (sdk) return Promise.resolve(sdk);
  if (!pending) {
    pending = import('./livekitClient')
      .then((module) => {
        sdk = module.default;
        // Apply whatever was assigned while the chunk was in flight. Without this
        // the SFU-drop handler and the link-state relay would sit on this object
        // and never be called — silently, because livekitClient invokes both
        // optionally (`this.onUnexpectedDisconnect?.(...)`), so the failure mode is
        // a call that dies with the UI still showing it as connected.
        sdk.onUnexpectedDisconnect = onUnexpectedDisconnect;
        sdk.onLocalLinkState = onLocalLinkState;
        return sdk;
      })
      .catch((err) => {
        pending = null;
        throw new MediaLoadError(err);
      });
  }
  return pending;
};

/**
 * Rejection handler for the methods that are called fire-and-forget or awaited
 * for their result. They must not turn a failed download into an unhandled
 * rejection: `setMicEnabled` in particular is awaited by ActiveCallView and its
 * result goes on the wire to the peer, and livekitClient's own version of this
 * method never rejects for exactly that reason.
 *
 * `answer` is a thunk, not a value, so the state it reports is read at the moment
 * the failure is known rather than at the moment the call was made.
 */
const unavailable = (answer) => (err) => {
  console.error('[call] the media layer could not be loaded:', err?.cause || err);
  return answer();
};

const livekitClient = {
  /**
   * Join, unless a hang-up overtook the import. See `joinSeq`.
   *
   * Resolves to `undefined` when it stands down, which is what `joinLiveKit` in
   * websocket.js already tolerates (`result?.cameraUnavailable`), and is the same
   * shape as a join that was never made.
   */
  joinCall: (callId, options) => {
    const seq = ++joinSeq;
    return load().then((s) => (seq === joinSeq ? s.joinCall(callId, options) : undefined));
  },

  /**
   * Hang up. Never loads the SDK, and never waits for one that is loading.
   *
   * Every caller is a teardown path — `call:ended`, `call:declined`,
   * `call:cancelled`, `call:missed`, `call:error`, the Hang up button — and making
   * teardown wait on a 138 kB download is how the join it is supposed to cancel
   * gets in first. With no SDK there is also nothing to tear down: the store fields
   * `leave()` clears (`localStream`, `localScreenStream`, `isScreenSharing`,
   * `activeSpeakerIds`, `mediaLinkState`) are written by livekitClient and by
   * nothing else in the app, so if it has never loaded they are all still at the
   * defaults `resetCall` would restore anyway.
   */
  leave: () => {
    joinSeq += 1;
    return sdk ? sdk.leave() : Promise.resolve();
  },

  /**
   * Synchronous by necessity: three call sites in websocket.js branch on it inside
   * a message handler and cannot await. Reporting `false` while the SDK loads is
   * correct — we hold no room — and the join that a `false` triggers is made safe
   * by `joinSeq`, which lets the last one win instead of stacking.
   */
  isEngaged: (callId) => (sdk ? sdk.isEngaged(callId) : false),

  /**
   * Unblock audio the browser refused for want of a gesture. NOT promise-chained,
   * and that is load-bearing rather than an optimisation.
   *
   * CallAudioSink calls this synchronously from a capture-phase pointerdown /
   * keydown handler, because LiveKit's `startAudio()` has to run inside the
   * gesture's own task to count as user activation. `load().then((s) =>
   * s.startAudio())` would move it into a microtask on the far side of a network
   * fetch, by which time the activation is spent and the browser refuses again —
   * so the one thing this method exists to fix would silently stop working.
   *
   * Nothing is lost by not loading: `livekitClient.startAudio()` returns
   * immediately when there is no room, and with no SDK there is by definition no
   * room. CallAudioSink only installs the listener while a remote participant has
   * a stream, which cannot happen before livekitClient has published one, so in
   * practice `sdk` is always set by the time this can run at all.
   */
  startAudio: () => {
    if (sdk) sdk.startAudio();
  },

  /**
   * The mid-call controls. These do load, because they are reachable before the
   * first join resolves — a group call's initiator is put into `callState:
   * 'connected'` by the socket handler before `joinCall` is even called, so the
   * mute button is live while the chunk is still in flight. Queueing behind the
   * same `load()` promise the join is already waiting on costs nothing and lands
   * them in livekitClient's own no-room path, which is where they landed before.
   *
   * Their fallbacks report the state we are still IN, not the state that was
   * asked for, because the caller relays the result to the peer with
   * `call:toggle_media` — the same rule livekitClient follows when there is no
   * room, and for the same reason: a microphone that never moved must not be
   * announced as muted.
   */
  //
  // BOTH TOGGLES GO STRAIGHT THROUGH WHEN THE SDK IS ALREADY HERE, and that is
  // not an optimisation — deferring them is a correctness bug.
  //
  // livekitClient writes the store OPTIMISTICALLY AND SYNCHRONOUSLY as the first
  // thing each toggle does, before it awaits the SDK, and that write is what
  // makes tap N read the opposite of tap N-1: both callers compute their target
  // from `useCallStore.getState()` at tap time. Routing the call through
  // `load().then(...)` moves that write behind a microtask, so four taps inside
  // one frame all read the same value, all ask for the same state, and the
  // camera never settles back — which is exactly what group-calling.spec's
  // rapid-tap case caught.
  //
  // The `load()` path is kept for the window before the first join resolves: a
  // group call's initiator is put into `callState: 'connected'` by the socket
  // handler before `joinCall` is called, so the mute button is live while the
  // chunk is still in flight. There the deferral is harmless — there is no room
  // yet, so livekitClient's own no-room path is where the call lands either way.
  setMicEnabled: (enabled) => (
    sdk
      ? sdk.setMicEnabled(enabled)
      : load().then(
        (s) => s.setMicEnabled(enabled),
        unavailable(() => !useCallStore.getState().isMuted)
      )
  ),

  setCameraEnabled: (enabled) => (
    sdk
      ? sdk.setCameraEnabled(enabled)
      : load().then(
        (s) => s.setCameraEnabled(enabled),
        unavailable(() => useCallStore.getState().isCameraOn)
      )
  ),

  startScreenShare: () => load().then(
    (s) => s.startScreenShare(),
    unavailable(() => false)
  ),

  stopScreenShare: () => load().then(
    (s) => s.stopScreenShare(),
    unavailable(() => undefined)
  ),

  flipCamera: () => load().then(
    (s) => s.flipCamera(),
    unavailable(() => undefined)
  ),

  /**
   * The two callbacks livekitClient calls back OUT on, exposed as accessors so
   * that `livekitClient.onUnexpectedDisconnect = fn` keeps working verbatim.
   *
   * A plain property would take the assignment and keep it: websocket.js sets both
   * in its constructor, at import time, when this façade is all there is — the
   * function would live here, livekitClient's `this.onUnexpectedDisconnect` would
   * stay null, and an unrecoverable SFU drop would end no call and tell no peer.
   * Nothing would throw, because both are invoked with `?.`, so the first sign
   * would be a call that stays on screen after the media is gone.
   */
  get onUnexpectedDisconnect() {
    return onUnexpectedDisconnect;
  },
  set onUnexpectedDisconnect(fn) {
    onUnexpectedDisconnect = fn;
    if (sdk) sdk.onUnexpectedDisconnect = fn;
  },

  get onLocalLinkState() {
    return onLocalLinkState;
  },
  set onLocalLinkState(fn) {
    onLocalLinkState = fn;
    if (sdk) sdk.onLocalLinkState = fn;
  },
};

export default livekitClient;
