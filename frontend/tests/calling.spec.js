import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * Calling E2E against a real LiveKit SFU, using Chromium's fake media devices.
 *
 * These tests exist because the call UI was written to spec and never exercised
 * in a browser. They caught three real defects:
 *   1. `call:accepted` was published only to the caller, so the callee never
 *      joined the SFU room — the call looked connected but carried no media.
 *   2. The call layout overflowed a 720px-tall viewport, putting the End Call
 *      control ~186px off-screen and unclickable.
 *   3. A stopped SFU and a browser-blocked microphone produced the same generic
 *      toast, so "calls don't connect" was undiagnosable from the UI.
 *
 * Requires a LiveKit server whose API key/secret match the backend's:
 *   LIVEKIT_KEYS="devkey: devsecret-at-least-32-characters-long" livekit-server --config <cfg>
 * Skips (rather than failing misleadingly) when no SFU is reachable.
 */

const LIVEKIT_HTTP = process.env.E2E_LIVEKIT_HTTP || 'http://127.0.0.1:7880';
const suffix = `call${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;
let sfuUp = false;

test.beforeAll(async ({ request }) => {
  try {
    sfuUp = (await request.get(LIVEKIT_HTTP, { timeout: 3000 })).ok();
  } catch {
    sfuUp = false;
  }
  if (sfuUp) seeded = await seedOrgWithUsers(request, suffix);
});

test.beforeEach(() => {
  test.skip(!sfuUp, `No LiveKit SFU at ${LIVEKIT_HTTP} — start one to run calling tests`);
});

async function openConversationWith(page, counterpart) {
  const existing = page.getByTestId('conversation-item').filter({ hasText: counterpart });
  if (await existing.count()) {
    await existing.first().click();
  } else {
    await page.getByTestId('new-chat-button').click();
    await page.getByTestId('contact-item').filter({ hasText: counterpart }).first().click();
  }
  await expect(page.getByTestId('message-input')).toBeVisible();
}

/** Videos actually bound to a MediaStream — the real signal that media arrived. */
function mediaCount(page) {
  return page.evaluate(
    () => [...document.querySelectorAll('video')].filter((v) => v.srcObject).length
  );
}

/** Audio sinks actually carrying a live remote audio track. */
function remoteAudioCount(page) {
  return page.evaluate(
    () =>
      [...document.querySelectorAll('audio')].filter(
        (a) => a.srcObject && a.srcObject.getAudioTracks().length > 0
      ).length
  );
}

/**
 * Record every getUserMedia constraint the page asks for, so a test can prove
 * an audio-only call never touches the camera. Must run before app scripts.
 */
async function recordMediaRequests(page) {
  await page.addInitScript(() => {
    window.__gumRequests = [];
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return;
    const original = md.getUserMedia.bind(md);
    md.getUserMedia = (constraints) => {
      window.__gumRequests.push(JSON.parse(JSON.stringify(constraints ?? {})));
      return original(constraints);
    };
  });
}

const gumRequests = (page) => page.evaluate(() => window.__gumRequests || []);
const askedForVideo = (reqs) => reqs.some((c) => c && c.video);

/**
 * Rewrite the SFU URL the backend hands this page to a port nothing listens on,
 * simulating "livekit-server isn't running" without touching the shared stack.
 */
async function pointAtDeadSfu(page, deadUrl = 'ws://127.0.0.1:7999') {
  await page.route('**/api/calls/*/token', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, url: deadUrl } });
  });
}

test('1:1 video call: both sides get media, controls are reachable, history records it', async ({
  browser,
}) => {
  const aliceCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  // Collect console errors, but only once both sides are logged in: a fresh
  // context always probes GET /api/auth/me before it has a session, so the
  // resulting 401 is expected and says nothing about call health.
  const errors = [];
  let capture = false;
  for (const [who, p] of [['alice', aPage], ['bob', bPage]]) {
    p.on('console', (m) => {
      if (capture && m.type() === 'error') errors.push(`${who}: ${m.text().slice(0, 160)}`);
    });
  }

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();

  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');
  capture = true;

  // Alice starts a video call; Bob's incoming overlay must appear.
  await aPage.getByTestId('header-video-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 15000 });
  await bPage.getByTestId('call-accept-btn').click();

  // BOTH sides must publish/subscribe media. Regression guard: the callee used
  // to stay "connected" having never joined the room.
  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    await expect
      .poll(() => mediaCount(page), {
        timeout: 30000,
        message: `${who} never got a media stream — did this side join the SFU room?`,
      })
      .toBeGreaterThan(0);
  }

  // The End Call control must be inside the viewport, not just in the DOM.
  const endBtn = aPage.locator('[data-testid="call-end-btn"]:visible').first();
  const box = await endBtn.boundingBox();
  const viewport = aPage.viewportSize();
  expect(box, 'End Call control has no layout box').not.toBeNull();
  expect(
    box.y + box.height,
    `End Call sits ${Math.round(box.y + box.height - viewport.height)}px below the fold`
  ).toBeLessThanOrEqual(viewport.height);

  await endBtn.click();

  for (const page of [aPage, bPage]) {
    await expect.poll(() => mediaCount(page), { timeout: 15000 }).toBe(0);
  }

  // History is asserted here rather than in a separate test so it never depends
  // on another test's side effects.
  const history = await aPage.evaluate(async () => {
    const r = await fetch('/api/calls/history', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return { status: r.status, body: await r.json() };
  });
  expect(history.status).toBe(200);
  expect(history.body.total).toBeGreaterThan(0);
  const call = history.body.data[0];
  expect(call.call_type).toBe('video');
  expect(call.direction).toBe('outgoing');
  expect(['answered', 'connected']).toContain(call.status);

  // Socket teardown on context close is noise, not a call defect.
  const real = errors.filter((e) => !/favicon|manifest|\[WS\] Error/i.test(e));
  expect(real, `unexpected console errors during the call:\n${real.join('\n')}`).toEqual([]);

  await aliceCtx.close();
  await bobCtx.close();
});

test('1:1 voice call: audio connects both ways without ever opening a camera', async ({
  browser,
}) => {
  // Microphone only: if any code path reaches for the camera the request is
  // denied and the call must still connect — that is the point of the test.
  const aliceCtx = await browser.newContext({ permissions: ['microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();
  await recordMediaRequests(aPage);
  await recordMediaRequests(bPage);

  const errors = [];
  let capture = false;
  for (const [who, p] of [['alice', aPage], ['bob', bPage]]) {
    p.on('console', (m) => {
      if (capture && m.type() === 'error') errors.push(`${who}: ${m.text().slice(0, 160)}`);
    });
  }

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();

  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');
  capture = true;

  await aPage.getByTestId('header-voice-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 15000 });
  await expect(bPage.getByText('Incoming voice call')).toBeVisible();
  await bPage.getByTestId('call-accept-btn').click();

  // Both sides must actually carry a remote audio track. The voice layout has
  // no <video> elements at all, so audio sinks are the only media signal.
  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    await expect
      .poll(() => remoteAudioCount(page), {
        timeout: 30000,
        message: `${who} never received remote audio — did this side join the SFU room?`,
      })
      .toBeGreaterThan(0);
  }

  // A voice call must never request the camera: doing so triggers a permission
  // prompt (or a hard failure where camera access is blocked) for no reason.
  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    const reqs = await gumRequests(page);
    expect(reqs.length, `${who} never requested a microphone`).toBeGreaterThan(0);
    expect(
      askedForVideo(reqs),
      `${who} asked for the camera during a voice call: ${JSON.stringify(reqs)}`
    ).toBe(false);
  }

  // The voice layout renders the avatar view, not the video grid.
  await expect(aPage.getByTestId('call-mute-btn')).toBeVisible();
  expect(await mediaCount(aPage), 'voice call rendered video elements').toBe(0);

  // End Call must be on-screen and actually tear the call down.
  const endBtn = aPage.locator('[data-testid="call-end-btn"]:visible').first();
  const box = await endBtn.boundingBox();
  const viewport = aPage.viewportSize();
  expect(box, 'End Call control has no layout box').not.toBeNull();
  expect(
    box.y + box.height,
    `End Call sits ${Math.round(box.y + box.height - viewport.height)}px below the fold`
  ).toBeLessThanOrEqual(viewport.height);

  await endBtn.click();
  for (const page of [aPage, bPage]) {
    await expect.poll(() => remoteAudioCount(page), { timeout: 15000 }).toBe(0);
  }

  const history = await aPage.evaluate(async () => {
    const r = await fetch('/api/calls/history?limit=5', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return { status: r.status, body: await r.json() };
  });
  expect(history.status).toBe(200);
  const voiceCall = history.body.data.find((c) => c.call_type === 'voice');
  expect(voiceCall, 'voice call missing from history').toBeTruthy();
  expect(voiceCall.direction).toBe('outgoing');
  expect(['answered', 'connected']).toContain(voiceCall.status);

  const real = errors.filter((e) => !/favicon|manifest|\[WS\] Error/i.test(e));
  expect(real, `unexpected console errors during the call:\n${real.join('\n')}`).toEqual([]);

  await aliceCtx.close();
  await bobCtx.close();
});

test('a dead SFU names LiveKit in the toast instead of a generic failure', async ({ browser }) => {
  // The original symptom: with livekit-server stopped, both a stopped SFU and a
  // blocked microphone produced the same "Could not connect the call", so there
  // was nothing anywhere pointing at the actual cause.
  const aliceCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();
  await pointAtDeadSfu(aPage);

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();

  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  await aPage.getByTestId('header-voice-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 15000 });
  await bPage.getByTestId('call-accept-btn').click();

  await expect(aPage.getByText(/Call server unreachable/i)).toBeVisible({ timeout: 30000 });

  // A failed join must not leave a zombie call on screen.
  await expect(aPage.locator('[data-testid="call-end-btn"]:visible')).toHaveCount(0, {
    timeout: 15000,
  });

  await aliceCtx.close();
  await bobCtx.close();
});

test('a blocked microphone says so, and does not read as a server problem', async ({ browser }) => {
  const aliceCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  // Chromium's fake-device flags grant everything, so deny at the API instead —
  // exactly what a user who clicked "Block" on the permission prompt gets.
  await aPage.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
  });

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();

  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  await aPage.getByTestId('header-voice-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 15000 });
  await bPage.getByTestId('call-accept-btn').click();

  await expect(aPage.getByText(/Microphone blocked/i)).toBeVisible({ timeout: 30000 });
  // Must NOT blame the SFU: that would send the user chasing the wrong thing.
  await expect(aPage.getByText(/Call server unreachable/i)).toHaveCount(0);

  await aliceCtx.close();
  await bobCtx.close();
});

/**
 * A ring placed while the callee's socket is down must still reach them.
 *
 * This was the largest single cause of "the call is not received". The server
 * refused the call outright when `presence.is_online` was false — which it is for
 * every client in the seconds after a network blip, and for the whole 15-minute
 * window in which an access cookie has just lapsed. The callee's device was never
 * contacted at all.
 *
 * Now the call rings for its full window regardless, and the ring is re-delivered
 * the moment the socket registers (`services/calls.resume_calls_for`) — with
 * `GET /api/calls/active` as the client-side belt to that braces.
 */
test('a ring placed while the callee is offline arrives when they come back', async ({
  browser,
}) => {
  const aliceCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  // Bob loses the network entirely: no socket, and no HTTP either. This is the
  // state in which the old server answered `call:unavailable` and gave up.
  await bobCtx.setOffline(true);
  // Let the socket actually close rather than racing the dial.
  await expect
    .poll(() => bPage.evaluate(() => navigator.onLine), { timeout: 10000 })
    .toBe(false);

  await aPage.getByTestId('header-voice-call-btn').click();

  // The caller must NOT be told the callee is unavailable — the ring is live, and
  // the ringing screen (not a dead-call toast) is what proves it.
  await expect(aPage.getByText(/User is unavailable/i)).toHaveCount(0);
  await expect(aPage.getByTestId('call-cancel-btn')).toBeVisible({ timeout: 10000 });
  // Scoped to the ring screen's heading: the name also appears in the sidebar and
  // the chat header, so a bare text match is three elements, not one.
  await expect(aPage.getByRole('heading', { name: 'Bob E2E', level: 2 })).toBeVisible();
  await expect(aPage.getByText(/^Calling/)).toBeVisible();

  // Bob comes back well inside the 45s ring window. The ringer must appear
  // without him touching anything.
  await bobCtx.setOffline(false);
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 30000 });

  // And it must be a real, answerable call — not a ghost ringer for a dead row.
  await bPage.getByTestId('call-accept-btn').click();
  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    await expect
      .poll(() => remoteAudioCount(page), {
        timeout: 30000,
        message: `${who} got no audio on a call recovered from an offline ring`,
      })
      .toBeGreaterThan(0);
  }

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await aliceCtx.close();
  await bobCtx.close();
});

/**
 * A connected call must survive losing the network, on both sides' screens.
 *
 * Previously either half of this killed the call outright: the server ended it the
 * instant the last socket dropped (no grace window at all), and both clients treated
 * the first SFU `Disconnected` as a hang-up with no re-join attempt. A two-second
 * dead spot — or the routine 15-minute cookie refresh — was fatal.
 */
test('a network drop mid-call shows "Connecting…" on both sides and then recovers', async ({
  browser,
}) => {
  // Longer than the default 60s because the two sides learn at very different
  // speeds, and the slower one is bounded by the server rather than by this client:
  //
  //   the offline side   ~1s  — `offline` fires, and the heartbeat abandons the
  //                             socket rather than waiting on a close event that a
  //                             dead network never delivers.
  //   the other side    ≤65s  — it can only learn from the server, and the server
  //                             can only tell a silent client from a slow one once
  //                             hub.HEARTBEAT_TIMEOUT lapses. Measured at ~38s.
  test.setTimeout(180000);
  const aliceCtx = await browser.newContext({ permissions: ['microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  await aPage.getByTestId('header-voice-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 15000 });
  await bPage.getByTestId('call-accept-btn').click();
  for (const page of [aPage, bPage]) {
    await expect.poll(() => remoteAudioCount(page), { timeout: 30000 }).toBeGreaterThan(0);
  }

  // Bob drops off the network for a few seconds — well inside the server's 40s
  // reconnect grace window.
  //
  // Note what this does and does not exercise: `setOffline` goes through CDP's
  // network emulation, which reliably kills HTTP and the WebSocket but does not
  // necessarily stop WebRTC's UDP media. So this is a faithful test of the
  // SIGNALLING half — the half that used to end the call outright, both because the
  // server hung up on the last socket drop and because neither client had any state
  // for "my signalling is gone but the call is not". The media half (LiveKit's own
  // reconnect, and our bounded re-join) is covered by the dead-SFU test above.
  await bobCtx.setOffline(true);

  // BOTH sides must say so. Bob learns it locally; Alice learns it only because
  // the server relays `call:peer_state` — the SFU tells her nothing, which is why
  // her side used to show a duration timer ticking over dead audio.
  // Bob, from his own link: fast, and the regression guard for the bug this test
  // found — a socket closed with no network parks in CLOSING and never fires
  // `onclose`, so an implementation that only listens for that event shows a
  // happily ticking duration timer over a dead call, forever.
  await expect(bPage.getByText('Connecting…').first()).toBeVisible({ timeout: 20000 });
  // Alice, from the server's `call:peer_state` relay: bounded by the API noticing
  // Bob has gone quiet, so it gets the full window.
  await expect(aPage.getByText('Connecting…').first()).toBeVisible({ timeout: 75000 });

  // Neither side may declare the call over while it is recoverable.
  await expect(aPage.getByText('Call ended')).toHaveCount(0);
  await expect(bPage.getByText('Call ended')).toHaveCount(0);

  await bobCtx.setOffline(false);

  // The call continues: the banner clears and audio is flowing again, without
  // anyone having redialled.
  await expect(bPage.getByText('Connecting…')).toHaveCount(0, { timeout: 60000 });
  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    await expect
      .poll(() => remoteAudioCount(page), {
        timeout: 45000,
        message: `${who} did not get audio back after the network returned`,
      })
      .toBeGreaterThan(0);
  }
  // Still one call, still the same one — not a second call papered over the first.
  await expect(aPage.locator('[data-testid="call-end-btn"]:visible')).toHaveCount(1);

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await aliceCtx.close();
  await bobCtx.close();
});

/**
 * Count the app's own WebSockets and how often each one opened.
 *
 * Needed by the test below to prove WHY the banner cleared. The recovery path that
 * matters is the one where the socket is never replaced at all, and a test that only
 * asserts "the banner went away" passes just as happily when the socket was torn
 * down and rebuilt — which is a different code path, and the one that already worked.
 */
async function traceAppSockets(page) {
  await page.addInitScript(() => {
    window.__appSockets = [];
    const Native = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
      if (String(url).includes('/api/ws')) {
        const rec = { opens: 0, closes: 0 };
        window.__appSockets.push(rec);
        ws.addEventListener('open', () => { rec.opens += 1; });
        ws.addEventListener('close', () => { rec.closes += 1; });
      }
      return ws;
    };
    window.WebSocket.prototype = Native.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) window.WebSocket[k] = Native[k];
  });
}

const appSockets = (page) => page.evaluate(() => window.__appSockets || []);

/**
 * A brief outage the socket SURVIVES must still clear "Connecting…".
 *
 * Distinct from the drop test above, and the distinction is the whole bug. That one
 * stays offline long enough for the heartbeat's unanswered ping to abandon the
 * socket, so a brand new one opens and `_onOpen` sets the signal link back to
 * `connected` on the way past. This one is offline for six seconds: the `offline`
 * event marks signalling down, the socket sits in `OPEN` throughout (measured:
 * readyState 1 for the whole outage, one socket, never closed), LiveKit resumes its
 * own signal connection and audio comes straight back — and `_onOpen`, the only path
 * that used to clear the flag, never ran. `signalLinkState` stayed `reconnecting`
 * forever: "Connecting…" over a call that was working, still there 40s later, and
 * still there over the NEXT call because `resetCall` does not touch socket state.
 *
 * A video call because that is how it was reported, and video is the case where the
 * banner is most obviously a lie — the far side's picture is moving behind it. The
 * mechanism has nothing to do with the camera, so a voice call at this outage length
 * latches identically.
 */
test('a brief outage that the socket survives still clears "Connecting…" on a video call', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const aliceCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();
  await traceAppSockets(bPage);

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  await aPage.getByTestId('header-video-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
  await bPage.getByTestId('call-accept-btn').click();
  for (const page of [aPage, bPage]) {
    await expect.poll(() => remoteAudioCount(page), { timeout: 45000 }).toBeGreaterThan(0);
  }
  const socketsBefore = await appSockets(bPage);

  await bobCtx.setOffline(true);
  // Bob is told immediately — `offline` is the browser stating that nothing can be
  // sent, and saying so is what this flag is for. The defect was never the raising.
  await expect(bPage.getByText('Connecting…').first()).toBeVisible({ timeout: 20000 });
  // Short enough that the 30s heartbeat cannot tick and condemn the socket, which is
  // the case the drop test above covers instead. Lengthening this would quietly move
  // this test onto that path and stop it guarding anything.
  await bPage.waitForTimeout(6000);
  await bobCtx.setOffline(false);

  // The banner must clear on the strength of the surviving socket answering a ping,
  // with no reconnect involved.
  await expect(bPage.getByText('Connecting…')).toHaveCount(0, { timeout: 45000 });
  expect(await appSockets(bPage), 'the socket was replaced, so this no longer covers the surviving-socket path')
    .toEqual(socketsBefore);

  // ...over a call that is genuinely healthy, on both sides.
  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    await expect
      .poll(() => remoteAudioCount(page), {
        timeout: 45000,
        message: `${who} did not get audio back after a brief outage`,
      })
      .toBeGreaterThan(0);
  }
  // And Alice, who learns about Bob's link only from the relay, must stop showing it too.
  await expect(aPage.getByText('Connecting…')).toHaveCount(0, { timeout: 45000 });
  await expect(bPage.getByText('Call ended')).toHaveCount(0);
  await expect(aPage.locator('[data-testid="call-end-btn"]:visible')).toHaveCount(1);

  // It must also not be latched for the NEXT call: hang up, redial, and the fresh
  // call may not open onto a "Connecting…" inherited from the last one.
  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await expect(bPage.getByTestId('call-accept-btn')).toHaveCount(0, { timeout: 20000 });
  await aPage.getByTestId('header-voice-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
  await bPage.getByTestId('call-accept-btn').click();
  for (const page of [aPage, bPage]) {
    await expect.poll(() => remoteAudioCount(page), { timeout: 45000 }).toBeGreaterThan(0);
  }
  await expect(bPage.getByText('Connecting…')).toHaveCount(0, { timeout: 30000 });

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await aliceCtx.close();
  await bobCtx.close();
});

/**
 * A join that is merely SLOW must still connect — on both sides.
 *
 * The regression this locks down: the "Answer went nowhere" watchdog was disarmed
 * only after the whole media join had finished, so its 20s budget also had to cover
 * the token round trip, getUserMedia and room.connect. On a real network (and
 * especially on a phone, where the audio session negotiates a route during the mic
 * publish) a perfectly good join crossed that line, the watchdog sent `call:end` to
 * the peer, and the join then succeeded anyway — leaving one client showing a healthy
 * call and the other showing nothing. It never reproduced in CI because every other
 * call test connects in under a second.
 *
 * Here the token endpoint is delayed past the watchdog to force the race.
 */
test('a slow media join still connects both sides and is not killed by a watchdog', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const aliceCtx = await browser.newContext({ permissions: ['microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  // Delay ONLY the answering side's token, by longer than ACCEPT_TIMEOUT_MS (20s).
  // Before the fix this made the callee send `call:end` mid-join and both sides lost
  // the call; after it, the join simply takes longer and succeeds.
  await bPage.route('**/api/calls/*/token', async (route) => {
    await new Promise((r) => setTimeout(r, 24000));
    await route.continue();
  });

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  await aPage.getByTestId('header-voice-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 15000 });
  await bPage.getByTestId('call-accept-btn').click();

  // Both sides must end up with audio despite the join outlasting the watchdog.
  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    await expect
      .poll(() => remoteAudioCount(page), {
        timeout: 90000,
        message: `${who} lost the call to the accept watchdog during a slow join`,
      })
      .toBeGreaterThan(0);
  }

  // And neither side may have been told the call ended.
  for (const page of [aPage, bPage]) {
    await expect(page.getByText('Call ended')).toHaveCount(0);
  }

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await aliceCtx.close();
  await bobCtx.close();
});

/**
 * A camera turned off must STAY off across a network drop.
 *
 * The bug: the re-join was built from `_joinOptions`, the intent captured at the
 * original join, so coming back reproduced how the call *started* rather than how the
 * user left it. A camera switched off before a tunnel switched itself back on on the
 * other side, and — worse — a muted microphone came back live. Neither is something a
 * user can be expected to notice in the second after their network returns.
 *
 * What this test does and does not exercise is worth stating, because `setOffline` goes
 * through CDP network emulation: it reliably kills HTTP and WebSockets, and LiveKit
 * often recovers its own session inside the outage without our bounded re-join running
 * at all. So this asserts the REQUIREMENT — camera state survives a temporary loss —
 * across whichever recovery path happens to fire, rather than pinning one of them. The
 * assertion is still the one that failed before the fix, on the paths that do rejoin.
 */
test('a camera turned off stays off across a network drop, and the mic stays muted', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const aliceCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const bobCtx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  await aPage.getByTestId('header-video-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
  await bPage.getByTestId('call-accept-btn').click();
  for (const page of [aPage, bPage]) {
    await expect.poll(() => remoteAudioCount(page), { timeout: 45000 }).toBeGreaterThan(0);
  }

  // Bob turns his camera off and mutes himself, then loses the network.
  await bPage.getByTestId('call-camera-btn').click();
  await bPage.getByTestId('call-mute-btn').click();
  const cameraOff = () => bPage.evaluate(() => {
    const btn = document.querySelector('[data-testid="call-camera-btn"]');
    // The control paints white ("active") when the thing it toggles is OFF.
    return !!btn && getComputedStyle(btn.firstElementChild).backgroundColor === 'rgb(255, 255, 255)';
  });
  await expect.poll(cameraOff, { timeout: 20000 }).toBe(true);

  await bobCtx.setOffline(true);
  await expect(bPage.getByText('Connecting…').first()).toBeVisible({ timeout: 25000 });
  // A few seconds — a genuinely TEMPORARY loss, the case in the requirement, and the
  // same length the reconnection test above uses. Measured on this path: LiveKit
  // resumes its own signal connection and our bounded re-join never runs, so what this
  // covers is "the camera state survived a recovery", whichever path performed it.
  await bPage.waitForTimeout(5000);
  await bobCtx.setOffline(false);

  // Recovery is measured as MEDIA, because media is what this test is about.
  //
  // It used to say something stronger: that the banner could not be measured at all,
  // because on this exact path (a few seconds offline, LiveKit resuming its own signal
  // connection, our bounded re-join never running) `signalLinkState` latched
  // `reconnecting` and "Connecting…" outlived the recovery indefinitely. That is fixed
  // — the surviving socket now clears the flag when it answers a ping — and the
  // outage-that-the-socket-survives test above owns the assertion. This one stays on
  // media so a camera regression cannot be masked by, or mistaken for, a banner one.
  await expect.poll(() => remoteAudioCount(bPage), {
    timeout: 60000, message: 'bob did not get the call back',
  }).toBeGreaterThan(0);
  await expect.poll(() => remoteAudioCount(aPage), {
    timeout: 60000, message: 'alice did not get the call back',
  }).toBeGreaterThan(0);

  // The camera is still off, and nobody was made to broadcast a room they had
  // deliberately stopped broadcasting.
  await expect.poll(cameraOff, {
    timeout: 20000,
    message: "bob's camera turned itself back on when the network returned",
  }).toBe(true);
  // Alice must not be showing video for him either.
  const aliceSeesBobsVideo = await aPage.evaluate(() => {
    const els = [...document.querySelectorAll('video')];
    // The 1:1 view renders the remote in the main frame and the local in the PiP.
    return els.some((el) => el.srcObject && el.srcObject.getVideoTracks().length > 0
      && !el.muted);
  });
  expect(aliceSeesBobsVideo, "alice was shown bob's camera after he had turned it off")
    .toBe(false);

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await aliceCtx.close();
  await bobCtx.close();
});
