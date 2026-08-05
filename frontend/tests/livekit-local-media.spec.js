import { expect, test } from '@playwright/test';

/**
 * Local media state across a signal reconnect, driven directly against
 * services/livekitClient.js.
 *
 * The regression this pins: recovering a dropped signal connection makes
 * livekit-client call `republishAllTracks()`, which unpublishes every local
 * publication and immediately publishes it again — the screen share included. The
 * store's `isScreenSharing` was cleared on the unpublish and never restored on the
 * publish, so a share that survived the reconnect perfectly (still captured, still
 * on the wire, still visible to the peer) left the local UI insisting nothing was
 * being shared: the Share control read "Share screen" mid-share, pressing it asked
 * the browser for a SECOND share instead of stopping the first, and with the camera
 * off `localCovered` in ActiveCallView drew an avatar over a tile that was actively
 * sharing a screen.
 *
 * Why this is a unit test in a browser rather than a call between two real clients:
 * the failure lives entirely in event-handler bookkeeping, and reproducing it end to
 * end needs a mid-call screen share (Chromium will only grant one with
 * `--auto-select-desktop-capture-source`) plus a *signal* interruption specifically —
 * a resume, which is the cheap kind of reconnect to provoke, does NOT republish
 * anything, so the interesting path would not even be taken. So the room is faked at
 * exactly the seam the handlers read (`localParticipant.trackPublications` plus the
 * two events) and everything else — the service, the store, the derivation — is the
 * real thing.
 *
 * Needs only Vite serving `/src`: no login, no API calls, no SFU.
 */

const BLANK = '/e2e-livekit-local-media';

/**
 * Everything below runs in the page. Returned as one object of observations so a
 * failure names the state that was actually reached rather than just a boolean.
 */
async function observe(page) {
  return page.evaluate(async () => {
    // Resolve `livekit-client` the way the module under test does. Vite rewrites the
    // bare specifier when it serves the file, so reading the rewritten URL back out of
    // the transformed source gives the SDK's own `RoomEvent`/`Track` constants — this
    // test then cannot drift from the names and enum values livekitClient is really
    // matching on, which is the whole point of asserting against them.
    const source = await fetch('/src/services/livekitClient.js').catch((err) => {
      // The one failure mode worth naming: run against a built `dist` (or nothing) and
      // `/src` is not served, which would otherwise surface as a bare "Failed to fetch".
      throw new Error(`this spec needs the Vite dev server serving /src — ${err.message}`);
    });
    if (!source.ok) {
      throw new Error(`/src/services/livekitClient.js came back ${source.status} — dev server not serving source?`);
    }
    const transformed = await source.text();
    const specifier = transformed.match(/from\s*["']([^"']*livekit-client[^"']*)["']/)?.[1];
    if (!specifier) throw new Error('could not resolve livekit-client out of the Vite-transformed source');
    const { RoomEvent, Track } = await import(/* @vite-ignore */ specifier);

    const { default: livekitClient } = await import('/src/services/livekitClient.js');
    const { default: useCallStore } = await import('/src/stores/callStore.js');

    // Real MediaStreamTracks: the store's fields are MediaStreams, and `addTrack`
    // rejects anything else. Chromium's fake devices supply them — see
    // `launchOptions` in playwright.config.js.
    const media = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const mic = media.getAudioTracks()[0];
    const camera = media.getVideoTracks()[0];
    // A distinct second video track to stand in for the share. Which source a
    // publication belongs to is livekitClient's own classification (`pub.source`), not
    // a property of the track, so a cloned camera track is an honest stand-in.
    const shared = camera.clone();

    const pub = (sid, source, mediaStreamTrack) => ({
      trackSid: sid,
      source,
      kind: mediaStreamTrack.kind,
      isMuted: false,
      track: { mediaStreamTrack },
    });

    // A room real enough for the handlers under test: the two events they listen for,
    // and the publication map they read back. `on` returns `this` because
    // `_wireRoomEvents` chains.
    const listeners = new Map();
    const publications = new Map();
    const room = {
      state: 'connected',
      remoteParticipants: new Map(),
      localParticipant: { trackPublications: publications },
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event).push(handler);
        return this;
      },
      emit(event, ...args) {
        (listeners.get(event) || []).forEach((handler) => handler(...args));
      },
    };

    livekitClient.room = room;
    livekitClient._wireRoomEvents(room);

    const KEYS = { mic: 'mic-sid', camera: 'camera-sid', shared: 'share-sid' };
    publications.set(KEYS.mic, pub(KEYS.mic, Track.Source.Microphone, mic));
    publications.set(KEYS.camera, pub(KEYS.camera, Track.Source.Camera, camera));
    publications.set(KEYS.shared, pub(KEYS.shared, Track.Source.ScreenShare, shared));

    // The starting state a successful `startScreenShare()` leaves behind. Set
    // explicitly rather than by emitting a publish, so that the "before" of this test
    // does not itself depend on the derivation being under test.
    useCallStore.setState({
      isScreenSharing: true,
      localScreenStream: livekitClient._localScreenStream(),
      localStream: livekitClient._localStream(),
    });
    const before = useCallStore.getState();
    const snapshot = (s) => ({
      isScreenSharing: s.isScreenSharing,
      screenTracks: s.localScreenStream?.getTracks().length ?? null,
      localTracks: s.localStream?.getTracks().length ?? null,
    });
    const started = snapshot(before);

    // ---- What `republishAllTracks()` actually does ------------------------------
    //
    // Per publication: `unpublishTrack(track, false)` (which emits
    // LocalTrackUnpublished regardless of whether the track is stopped) and then
    // `publishOrRepublishTrack`. It runs those cycles under `Promise.all`, so the
    // events interleave rather than pairing up. The share is republished BEFORE the
    // other tracks here on purpose: that is the ordering under which a handler that
    // wrote the flag from anything other than the whole publication set would clobber
    // a correctly-restored `true` on the next unrelated publish.
    const republishOrder = [KEYS.shared, KEYS.mic, KEYS.camera];
    const held = new Map(publications);
    for (const key of republishOrder) {
      publications.delete(key);
      room.emit(RoomEvent.LocalTrackUnpublished, held.get(key), room.localParticipant);
    }
    const midRepublish = snapshot(useCallStore.getState());
    for (const key of republishOrder) {
      publications.set(key, held.get(key));
      room.emit(RoomEvent.LocalTrackPublished, held.get(key), room.localParticipant);
    }
    const afterRepublish = snapshot(useCallStore.getState());

    // ---- The Reconnected path ---------------------------------------------------
    //
    // `_resyncAll()` is the belt to the publish handler's braces: Room emits
    // RoomEvent.Reconnected only after `republishAllTracks()` has resolved, so it is
    // the authoritative correction point. Forced stale first so this measures
    // `_resyncAll` restoring the flag and not the republish above having left it right.
    useCallStore.setState({ isScreenSharing: false, localScreenStream: null });
    livekitClient._resyncAll();
    const afterResync = snapshot(useCallStore.getState());

    // ---- Not over-corrected -----------------------------------------------------
    //
    // A share that genuinely ends must still clear the flag, which is the bug the
    // unpublish handler was written for in the first place. Deriving on publish must
    // not resurrect it.
    publications.delete(KEYS.shared);
    room.emit(RoomEvent.LocalTrackUnpublished, held.get(KEYS.shared), room.localParticipant);
    const afterStop = snapshot(useCallStore.getState());
    // A later unrelated publish (the camera coming back on) must not resurrect it either.
    room.emit(RoomEvent.LocalTrackPublished, held.get(KEYS.camera), room.localParticipant);
    const afterStopThenPublish = snapshot(useCallStore.getState());

    livekitClient.room = null;
    [mic, camera, shared].forEach((t) => t.stop());

    return {
      // Named so a livekit-client rename that silently unhooks these handlers fails
      // here with something readable instead of as an inexplicably unchanged store.
      subscribed: [...listeners.keys()],
      eventNames: {
        published: RoomEvent.LocalTrackPublished,
        unpublished: RoomEvent.LocalTrackUnpublished,
      },
      started,
      midRepublish,
      afterRepublish,
      afterResync,
      afterStop,
      afterStopThenPublish,
    };
  });
}

test.describe('livekitClient local media', () => {
  test.beforeEach(async ({ page }) => {
    // A bare page on the dev server's origin. The app is deliberately not booted —
    // this drives the service and the store directly — but the origin has to be Vite's
    // so `import('/src/...')` resolves through its module graph.
    await page.route(`**${BLANK}`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>livekitClient local media</title>',
      })
    );
    await page.goto(BLANK);
  });

  test('a screen share survives the republish a signal reconnect performs', async ({ page }) => {
    const seen = await observe(page);

    // The handlers are actually wired to the events being emitted below. Without this,
    // every assertion that follows could pass by never having run any of our code.
    expect(seen.subscribed).toContain(seen.eventNames.published);
    expect(seen.subscribed).toContain(seen.eventNames.unpublished);

    expect(seen.started, 'sharing, camera and mic live').toEqual({
      isScreenSharing: true,
      screenTracks: 1,
      localTracks: 2,
    });

    // Mid-republish there is genuinely nothing published, and the store should say so
    // rather than hold a MediaStream around tracks the SFU no longer has.
    expect(seen.midRepublish).toEqual({
      isScreenSharing: false,
      screenTracks: null,
      localTracks: null,
    });

    // The regression. Everything is back on the wire, so the flag must be back too.
    expect(seen.afterRepublish, 'isScreenSharing stale after republish').toEqual({
      isScreenSharing: true,
      screenTracks: 1,
      localTracks: 2,
    });

    // ...and the Reconnected resync agrees, from a deliberately stale flag.
    expect(seen.afterResync, '_resyncAll left isScreenSharing stale').toEqual({
      isScreenSharing: true,
      screenTracks: 1,
      localTracks: 2,
    });

    // A share that really ended still clears, and stays cleared.
    expect(seen.afterStop).toEqual({
      isScreenSharing: false,
      screenTracks: null,
      localTracks: 2,
    });
    expect(seen.afterStopThenPublish).toEqual({
      isScreenSharing: false,
      screenTracks: null,
      localTracks: 2,
    });
  });
});
