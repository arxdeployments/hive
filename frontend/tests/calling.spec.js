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
