import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * Calling E2E against a real LiveKit SFU, using Chromium's fake media devices.
 *
 * These tests exist because the call UI was written to spec and never exercised
 * in a browser. They caught two real defects:
 *   1. `call:accepted` was published only to the caller, so the callee never
 *      joined the SFU room — the call looked connected but carried no media.
 *   2. The call layout overflowed a 720px-tall viewport, putting the End Call
 *      control ~186px off-screen and unclickable.
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
