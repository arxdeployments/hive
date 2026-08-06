import { expect, test } from '@playwright/test';

/**
 * What the call layer does when the media operations underneath it FAIL —
 * driven directly against services/livekitClient.js.
 *
 * Three defects, one theme: every one of these paths used to fail invisibly.
 *
 * 1. `_publishLocalMedia` acquires real hardware with `createLocalTracks` and
 *    then publishes it. A track whose `publishTrack` rejects never reaches
 *    `trackPublications` — and `leave()` only calls `room.disconnect()`, which
 *    walks publications, while `setCameraEnabled` reads publications too. So a
 *    failed publish left the camera capturing with no control able to stop it,
 *    for the rest of the call. The audio-only retry then opened a SECOND
 *    microphone, and `setMicEnabled` resolves a source to the FIRST matching
 *    publication, so Mute silently half-worked.
 *
 * 2. `setMicEnabled` had no try/catch, and all three of its call sites are
 *    fire-and-forget. A rejecting `setMicrophoneEnabled` was an unhandled
 *    rejection, the store never moved, and ActiveCallView had already told the
 *    peer over the socket that the mic reached the state it never did.
 *
 * 3. `startScreenShare` swallowed its error and returned false with nothing on
 *    screen; `stopScreenShare` had no catch at all, so a rejection there was
 *    unhandled while the user's screen stayed shared.
 *
 * Why this is a unit test in a browser rather than a call between two clients:
 * the inputs are a rejecting SFU publish, a seized microphone and a refused
 * screen capture. Chromium's fake devices never fail, `getDisplayMedia` cannot
 * be denied on demand, and a real SFU cannot be told to accept a WebSocket and
 * then not answer AddTrack. So the room is faked at exactly the seam the code
 * calls — `publishTrack`, `unpublishTrack`, `setMicrophoneEnabled`,
 * `setScreenShareEnabled` — and everything else is the real thing: the real
 * service, the real store, the real `createLocalTracks` opening real (fake-
 * device) hardware, and the real toast calls.
 *
 * Needs only Vite serving `/src`: no login, no API calls, no SFU.
 */

const BLANK = '/e2e-livekit-media-failures';

test.describe('livekitClient media failures', () => {
  test.beforeEach(async ({ page }) => {
    // A bare page on the dev server's origin. The app is deliberately not booted
    // — this drives the service and the store directly — but the origin has to
    // be Vite's so `import('/src/...')` resolves through its module graph.
    await page.route(`**${BLANK}`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>livekitClient media failures</title>',
      })
    );
    await page.goto(BLANK);
  });

  test('a failed publish releases the hardware it acquired', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const { default: livekitClient } = await import('/src/services/livekitClient.js');

      // Every track handed to publishTrack, in order, with the underlying
      // MediaStreamTrack kept so its readyState can be read afterwards. The
      // camera track of attempt 1 never becomes a publication, so this is the
      // only handle on it that exists anywhere.
      const attempted = [];
      const published = new Set();
      const unpublishCalls = [];
      const room = {
        localParticipant: {
          async publishTrack(track) {
            attempted.push(track);
            if (track.kind === 'video') {
              // What an SFU that accepts the WebSocket and then never answers
              // AddTrack actually produces (livekit-client's 10s addTrack deadline).
              throw Object.assign(
                new Error('publication of local track timed out, no response from server'),
                { name: 'ConnectionError' }
              );
            }
            published.add(track);
          },
          unpublishTrack(track, stopOnUnpublish) {
            unpublishCalls.push({ kind: track.kind, stopOnUnpublish });
            if (!published.has(track)) return Promise.resolve(undefined);
            published.delete(track);
            return Promise.resolve({ trackSid: 'sid' });
          },
        },
      };

      // A video call whose camera publish is refused. The real code falls back to
      // audio-only, which is the common case and the one that must not leak.
      const result = await livekitClient._publishLocalMedia(room, { audio: true, wantVideo: true });

      const states = attempted.map((t) => ({
        kind: t.kind,
        readyState: t.mediaStreamTrack?.readyState ?? null,
      }));
      // Leave nothing of our own behind.
      attempted.forEach((t) => { try { t.stop(); } catch { /* already ended */ } });

      return {
        result,
        states,
        unpublishCalls,
        micPublications: [...published].filter((t) => t.kind === 'audio').length,
      };
    });

    // The fake was actually exercised: a video track really was offered, so the
    // assertions below are not passing because nothing ran.
    expect(seen.states.map((s) => s.kind), 'no video track was ever published — the fake did not run')
      .toContain('video');
    expect(seen.states.length, 'the audio-only retry never happened').toBe(3);

    // The contract callers depend on is unchanged.
    expect(seen.result).toEqual({ cameraUnavailable: true, reason: 'media_failed' });

    // The defect. Both tracks of the failed attempt are released — including the
    // camera, which no other teardown path in the app can reach.
    expect(seen.states.slice(0, 2), 'the failed attempt left hardware capturing').toEqual([
      { kind: 'audio', readyState: 'ended' },
      { kind: 'video', readyState: 'ended' },
    ]);
    // ...and the retry's microphone is of course still live.
    expect(seen.states[2]).toEqual({ kind: 'audio', readyState: 'live' });

    // Exactly one microphone survives. Before the fix the first attempt's mic
    // stayed published and the retry added a second, so `setMicEnabled` muted
    // one of two live microphones and the far side still heard us.
    expect(seen.micPublications, 'the audio-only retry published a second microphone').toBe(1);

    // The rollback unpublishes without asking the SDK to stop the track, because
    // it has already been stopped synchronously above.
    expect(seen.unpublishCalls.length, 'nothing was rolled back').toBeGreaterThan(0);
    expect(seen.unpublishCalls.every((u) => u.stopOnUnpublish === false)).toBe(true);
  });

  test('the camera is released without waiting for the SFU', async ({ page }) => {
    // The trap in the obvious version of this fix: `await unpublishTrack(...)`
    // blocks on `engine.negotiate()`, whose deadline is 15s — against the very
    // SFU that has just demonstrated it will not answer. The camera light would
    // stay on for those 15s and the audio-only fallback would start that much
    // later, which is a behaviour change on the common path.
    const seen = await page.evaluate(async () => {
      const { default: livekitClient } = await import('/src/services/livekitClient.js');

      const attempted = [];
      const room = {
        localParticipant: {
          async publishTrack(track) {
            attempted.push(track);
            if (track.kind === 'video') {
              throw Object.assign(new Error('no response from server'), { name: 'ConnectionError' });
            }
          },
          // Never settles, standing in for that renegotiation deadline.
          unpublishTrack: () => new Promise(() => {}),
        },
      };

      const result = await Promise.race([
        livekitClient._publishLocalMedia(room, { audio: true, wantVideo: true }),
        new Promise((resolve) => { setTimeout(() => resolve('TIMED_OUT'), 5000); }),
      ]);
      const states = attempted.map((t) => ({
        kind: t.kind,
        readyState: t.mediaStreamTrack?.readyState ?? null,
      }));
      attempted.forEach((t) => { try { t.stop(); } catch { /* already ended */ } });
      return { result, states };
    });

    expect(seen.result, 'the release waited on an unpublish the SFU will never answer')
      .not.toBe('TIMED_OUT');
    expect(seen.result).toEqual({ cameraUnavailable: true, reason: 'media_failed' });
    expect(seen.states.slice(0, 2).every((s) => s.readyState === 'ended'),
      'the camera was still capturing while we waited on the SFU').toBe(true);
  });

  test('a failed mic toggle is reported instead of thrown, and never lies about the state reached', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const { default: livekitClient } = await import('/src/services/livekitClient.js');
      const { default: useCallStore } = await import('/src/stores/callStore.js');

      // Resolve `sonner` the way the module under test does. Vite rewrites the
      // bare specifier when it serves the file, so reading the rewritten URL back
      // out of the transformed source gives the SAME module instance
      // utils/callErrors.js imported — the only way to observe what the
      // production code emits without booting the app for its <Toaster />.
      const source = await fetch('/src/utils/callErrors.js');
      if (!source.ok) throw new Error(`/src/utils/callErrors.js came back ${source.status}`);
      const specifier = (await source.text()).match(/from\s*["']([^"']*sonner[^"']*)["']/)?.[1];
      if (!specifier) throw new Error('could not resolve sonner out of the Vite-transformed source');
      const { toast } = await import(/* @vite-ignore */ specifier);
      const toasts = [];
      const realError = toast.error;
      toast.error = (message, opts) => { toasts.push(message); return realError(message, opts); };

      const rejections = [];
      const onRejection = (e) => { rejections.push(e.reason?.name || String(e.reason)); e.preventDefault(); };
      window.addEventListener('unhandledrejection', onRejection);

      livekitClient.room = {
        localParticipant: {
          setMicrophoneEnabled: async () => {
            throw Object.assign(new Error('Could not start audio source'), { name: 'NotReadableError' });
          },
        },
      };

      try {
        // Live and unmuted — the state a failed mute must leave untouched.
        useCallStore.setState({ isMuted: false });

        // Invoked exactly as production does: fire-and-forget, no await, no
        // catch. That is what made the rejection unhandled.
        livekitClient.setMicEnabled(false);
        await new Promise((r) => { setTimeout(r, 50); });
        const afterFireAndForget = {
          isMuted: useCallStore.getState().isMuted,
          rejections: [...rejections],
        };

        // And awaited, for the value ActiveCallView now puts on the wire.
        let reached;
        let threw = null;
        try {
          reached = await livekitClient.setMicEnabled(false);
        } catch (err) {
          threw = err?.name || String(err);
        }

        // Positive control: the success path still writes the store, so the
        // assertions above are not passing merely because nothing writes it.
        livekitClient.room = { localParticipant: { setMicrophoneEnabled: async () => {} } };
        const okReached = await livekitClient.setMicEnabled(false);

        return {
          afterFireAndForget,
          reached,
          threw,
          okReached,
          okMuted: useCallStore.getState().isMuted,
          toasts,
        };
      } finally {
        toast.error = realError;
        window.removeEventListener('unhandledrejection', onRejection);
        livekitClient.room = null;
        useCallStore.setState({ isMuted: false });
      }
    });

    // The defect itself.
    expect(seen.afterFireAndForget.rejections, 'the mic toggle rejected into nothing').toEqual([]);
    expect(seen.threw, 'setMicEnabled still throws at its callers').toBeNull();

    // The mute never took, so that is what the peer must be told — not the state
    // that was asked for. `true` here is "the mic is still enabled".
    expect(seen.reached, 'a failed mute reported itself as having muted').toBe(true);
    expect(seen.afterFireAndForget.isMuted, 'the store moved on a toggle that failed').toBe(false);

    // And it says so out loud.
    expect(seen.toasts.join('\n')).toMatch(/could not be muted/i);

    // Success is untouched: asked to disable, reached disabled, store agrees.
    expect(seen.okReached).toBe(false);
    expect(seen.okMuted).toBe(true);
  });

  test('screen share failures are reported, and a cancelled picker is not', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const { default: livekitClient } = await import('/src/services/livekitClient.js');

      const source = await fetch('/src/utils/callErrors.js');
      if (!source.ok) throw new Error(`/src/utils/callErrors.js came back ${source.status}`);
      const specifier = (await source.text()).match(/from\s*["']([^"']*sonner[^"']*)["']/)?.[1];
      if (!specifier) throw new Error('could not resolve sonner out of the Vite-transformed source');
      const { toast } = await import(/* @vite-ignore */ specifier);
      let toasts = [];
      const realError = toast.error;
      toast.error = (message, opts) => { toasts.push(message); return realError(message, opts); };
      const drain = () => { const out = toasts; toasts = []; return out; };

      const rejections = [];
      const onRejection = (e) => { rejections.push(String(e.reason)); e.preventDefault(); };
      window.addEventListener('unhandledrejection', onRejection);

      const withStartError = (error) => {
        livekitClient.room = {
          localParticipant: { setScreenShareEnabled: async () => { throw error; } },
        };
      };

      try {
        // Backing out of Chromium's picker. A normal thing to do; must stay silent.
        withStartError(new DOMException('Permission denied', 'NotAllowedError'));
        const cancelled = { returned: await livekitClient.startScreenShare(), toasts: drain() };

        // macOS Screen Recording not granted to the browser — the case that has
        // an action attached, which Chromium distinguishes only by this wording.
        withStartError(new DOMException('Permission denied by system', 'NotAllowedError'));
        const blocked = { returned: await livekitClient.startScreenShare(), toasts: drain() };

        // iOS Safari, or any insecure context: no getDisplayMedia at all.
        withStartError(Object.assign(new Error('getDisplayMedia not supported'), {
          name: 'DeviceUnsupportedError',
        }));
        const unsupported = { returned: await livekitClient.startScreenShare(), toasts: drain() };

        // Stopping a share and being refused. Fire-and-forget at its only call
        // site, so this was an unhandled rejection with the screen still up.
        livekitClient.room = {
          localParticipant: {
            setScreenShareEnabled: async () => { throw new Error('negotiation timed out'); },
          },
        };
        let stopThrew = null;
        try {
          await livekitClient.stopScreenShare();
        } catch (err) {
          stopThrew = String(err);
        }
        await new Promise((r) => { setTimeout(r, 50); });

        return {
          cancelled,
          blocked,
          unsupported,
          stopThrew,
          stopToasts: drain(),
          rejections: [...rejections],
        };
      } finally {
        toast.error = realError;
        window.removeEventListener('unhandledrejection', onRejection);
        livekitClient.room = null;
      }
    });

    // Deliberate silence. Checked against a drained buffer rather than against a
    // toast that merely expired, so this genuinely fails a later "always toast" edit.
    expect(seen.cancelled.toasts, 'a cancelled share picker put an error on screen').toEqual([]);
    expect(seen.cancelled.returned).toBe(false);

    // The two that must speak.
    expect(seen.blocked.toasts.join('\n')).toMatch(/screen recording is blocked/i);
    expect(seen.unsupported.toasts.join('\n')).toMatch(/isn't supported/i);

    // Stopping: resolves rather than rejects, and says the screen may still be up.
    expect(seen.stopThrew, 'stopScreenShare still rejects at its caller').toBeNull();
    expect(seen.rejections, 'the stop rejection reached nothing').toEqual([]);
    expect(seen.stopToasts.join('\n')).toMatch(/may still be shared/i);
  });
});
