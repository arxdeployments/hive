import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * Group calling, three real browsers against a real SFU.
 *
 * The 1:1 suite in `calling.spec.js` never exercised any of this, and the gaps it left
 * uncovered were the ones users hit:
 *
 *  - **Joining a call already in progress.** The server has published
 *    `call:group_active` to every other member since group calls were built, and the
 *    store has recorded it in `activeGroupCalls` — but nothing on the web ever READ that
 *    map. So a call was joinable only for as long as its ringing screen was up: arrive
 *    late, dismiss it, or leave and want back in, and there was no way in.
 *  - **Adding someone mid-call.** `_join` admits only users who already hold a roster
 *    row, and those rows are created once from the conversation's membership when the
 *    call starts. The two "Add people" buttons were wired to nothing at all.
 *  - **Layout past a handful of people**, and a participant leaving without taking the
 *    call down with them.
 *
 * Three contexts is the minimum that can tell "the roster works" from "the roster
 * happens to have one entry".
 */

const LIVEKIT_HTTP = process.env.E2E_LIVEKIT_HTTP || 'http://127.0.0.1:7880';
const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const suffix = `grp${process.pid}${Math.floor(Math.random() * 1000)}`;
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

let seeded;
let group;
let sfuUp = false;

test.beforeAll(async ({ request }) => {
  try {
    sfuUp = (await request.get(LIVEKIT_HTTP, { timeout: 3000 })).ok();
  } catch {
    sfuUp = false;
  }
  if (!sfuUp) return;

  // `dave` is deliberately NOT put in the group: he is the invite path's reason to
  // exist. Every member of the conversation already holds a roster row from the moment
  // the call starts, so nothing short of the invite endpoint can reach anyone else.
  seeded = await seedOrgWithUsers(request, suffix, ['alice', 'bob', 'carol', 'dave']);

  // The group is created through the API rather than the UI: this suite is about the
  // CALL, and driving the create-group modal would make every test here depend on it.
  const login = await request.post(`${API}/api/auth/login`, {
    headers: H,
    data: { email: seeded.users.alice.email, password: seeded.users.alice.password },
  });
  expect(login.ok(), 'alice could not sign in to create the group').toBeTruthy();
  const created = await request.post(`${API}/api/conversations/group`, {
    headers: H,
    data: {
      name: `Group Call ${suffix}`,
      member_ids: [seeded.users.bob.id, seeded.users.carol.id],
    },
  });
  expect(created.ok(), `group creation failed: ${created.status()}`).toBeTruthy();
  group = await created.json();
});

test.beforeEach(() => {
  test.skip(!sfuUp, `No LiveKit SFU at ${LIVEKIT_HTTP} — start one to run group calling tests`);
});

/** Audio sinks actually carrying a live remote track — the real signal media arrived. */
const remoteAudioCount = (page) =>
  page.evaluate(() => [...document.querySelectorAll('audio')]
    .filter((a) => a.srcObject && a.srcObject.getAudioTracks().length > 0).length);

/** How many tiles the grid is rendering, and how many people it knows about. */
const gridCounts = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="video-grid"]');
    if (!el) return null;
    return {
      tiles: Number(el.dataset.tileCount),
      participants: Number(el.dataset.participantCount),
    };
  });

/**
 * Any video in the grid whose rendered transform flips it horizontally.
 *
 * A mirrored self-view is a rendering choice that must depend on WHICH camera is
 * feeding it: a front camera shows you your own face and people expect a mirror, but
 * the back camera is pointed at the world, and mirroring the world puts every sign and
 * badge in the scene back-to-front. The web tile is drawn untransformed for both, so
 * anything with a negative horizontal scale here is a regression — including one
 * arriving by CSS (`-scale-x-100`, `transform: scaleX(-1)`) rather than by JS.
 *
 * Read from the computed matrix rather than the class list, so it cannot be fooled by
 * the flip being expressed a different way.
 */
const mirroredVideoCount = (page) =>
  page.evaluate(() => {
    const grid = document.querySelector('[data-testid="video-grid"]');
    if (!grid) return -1;
    return [...grid.querySelectorAll('video')].filter((el) => {
      const t = getComputedStyle(el).transform;
      if (!t || t === 'none') return false;
      // matrix(a, b, c, d, e, f) — `a` < 0 is a horizontal flip.
      const a = Number(t.replace(/^matrix(3d)?\(/, '').split(',')[0]);
      return Number.isFinite(a) && a < 0;
    }).length;
  });

/**
 * Tiles in the grid that are actually rendering a video element.
 *
 * `VideoTile` renders a `<video>` only when it has a stream AND the camera is not off,
 * and shows the avatar otherwise — so this counts "cameras I can see", which is the
 * thing a peer must learn about when somebody turns their camera off. Counting the
 * DOM rather than reading the store keeps the assertion on what the user sees.
 */
const gridVideoCount = (page) =>
  page.evaluate(() => document.querySelectorAll(
    '[data-testid="video-grid"] video'
  ).length);

/** Invited, not answered yet. -1 distinguishes "no grid" from "grid, nobody ringing". */
const pendingCount = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="video-grid"]');
    return el ? Number(el.dataset.pendingCount) : -1;
  });

async function signInAndOpenGroup(page, who) {
  await uiLogin(page, seeded.users[who].email, seeded.users[who].password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await page.getByTestId('conversation-item').filter({ hasText: `Group Call ${suffix}` })
    .first().click();
  await expect(page.getByTestId('message-input')).toBeVisible();
}

test('three-way group call: everyone gets media, the grid counts everyone, and leaving does not end it', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const ctxs = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })));
  const [aPage, bPage, cPage] = await Promise.all(ctxs.map((c) => c.newPage()));

  await signInAndOpenGroup(aPage, 'alice');
  await signInAndOpenGroup(bPage, 'bob');
  await signInAndOpenGroup(cPage, 'carol');

  // Alice starts it. The others are rung.
  await aPage.getByTestId('header-video-call-btn').click();
  for (const [who, page] of [['bob', bPage], ['carol', cPage]]) {
    await expect(page.getByTestId('call-accept-btn'), `${who} was never rung`)
      .toBeVisible({ timeout: 20000 });
  }
  await bPage.getByTestId('call-accept-btn').click();
  await cPage.getByTestId('call-accept-btn').click();

  // All three must carry remote audio. This is the assertion the 1:1 suite cannot make:
  // with three legs, a roster that only tracks one peer still "works" for two of them.
  for (const [who, page] of [['alice', aPage], ['bob', bPage], ['carol', cPage]]) {
    await expect
      .poll(() => remoteAudioCount(page), {
        timeout: 45000,
        message: `${who} received no remote audio in the group call`,
      })
      .toBeGreaterThanOrEqual(2);
  }

  // The grid knows about all three — self plus two peers — and lays out three tiles.
  await expect.poll(() => gridCounts(aPage), { timeout: 20000 })
    .toEqual({ tiles: 3, participants: 3 });

  // Nothing in the grid is horizontally flipped — not the local tile, not a peer's.
  // The back camera must show the scene as captured, and a remote tile has already
  // been composed the right way round by whoever sent it.
  for (const [who, page] of [['alice', aPage], ['bob', bPage], ['carol', cPage]]) {
    expect(await mirroredVideoCount(page), `${who}'s grid contains a mirrored video`).toBe(0);
  }
  // And the aspect ratio is preserved rather than stretched: `object-fit` must be a
  // cover/contain crop, never `fill`, which squashes a 16:9 camera into a square tile.
  const fits = await aPage.evaluate(() => [...document.querySelectorAll(
    '[data-testid="video-grid"] video'
  )].map((el) => getComputedStyle(el).objectFit));
  expect(fits.length).toBeGreaterThan(0);
  expect(fits.every((f) => f === 'cover' || f === 'contain'), `object-fit was ${fits}`).toBe(true);

  // Carol leaves. The call must survive for the other two: an ordinary participant
  // hanging up is a LEAVE, and only the initiator (or the last one out) ends it.
  await cPage.locator('[data-testid="call-end-btn"]:visible').first().click();

  await expect.poll(() => gridCounts(aPage), {
    timeout: 25000,
    message: 'the grid did not drop the participant who left',
  }).toEqual({ tiles: 2, participants: 2 });

  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    expect(await remoteAudioCount(page), `${who} lost the call when carol left`)
      .toBeGreaterThanOrEqual(1);
  }

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await Promise.all(ctxs.map((c) => c.close()));
});

test('a member who was not on the ringing screen can still join from the conversation', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const ctxs = await Promise.all([0, 1].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })));
  const [aPage, bPage] = await Promise.all(ctxs.map((c) => c.newPage()));

  await signInAndOpenGroup(aPage, 'alice');
  await signInAndOpenGroup(bPage, 'bob');

  await aPage.getByTestId('header-video-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });

  // Bob dismisses the ring instead of answering — the case that used to be a dead end.
  // The call is still running, and `call:group_active` told his client so, but nothing
  // rendered it.
  await bPage.getByTestId('call-decline-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toHaveCount(0);

  // The conversation now offers the call.
  const bar = bPage.getByTestId('ongoing-group-call-bar');
  await expect(bar, 'no way to join a call that is still running').toBeVisible({ timeout: 20000 });
  await expect(bar).toContainText(/on a call|call is in progress/i);

  await bPage.getByTestId('join-group-call-btn').click();

  for (const [who, page] of [['alice', aPage], ['bob', bPage]]) {
    await expect
      .poll(() => remoteAudioCount(page), {
        timeout: 45000,
        message: `${who} got no audio after a late join`,
      })
      .toBeGreaterThanOrEqual(1);
  }
  // And the bar goes away, because offering "Join" to someone already in it is how you
  // end up with one user holding two legs of the same call.
  await expect(bar).toHaveCount(0);

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await Promise.all(ctxs.map((c) => c.close()));
});

test('someone outside the group can be invited into a call already in progress', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const ctxs = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })));
  const [aPage, cPage, dPage] = await Promise.all(ctxs.map((c) => c.newPage()));

  await signInAndOpenGroup(aPage, 'alice');
  await signInAndOpenGroup(cPage, 'carol');
  // Dave signs in BEFORE the invite. That is the flow the feature is for — you add
  // someone who is using the app — and it is the only one that can ring: an invitee who
  // is offline when the invite goes out has the `call:incoming` published to a channel
  // with no subscriber, and on reconnect `resume_calls_for` correctly reports a
  // CONNECTED call, which is a "Join" affordance rather than a ring. Dave is not in the
  // group conversation, so he has nowhere for that affordance to render — see the note
  // in the summary; ringing an online invitee is what is covered here.
  await uiLogin(dPage, seeded.users.dave.email, seeded.users.dave.password);
  await expect(dPage.getByTestId('conversation-search')).toBeVisible();

  // A group call between alice and carol, then alice pulls in dave — who is not in the
  // conversation at all, so he holds no roster row and `_join` would have refused him.
  // Before the invite endpoint existed the roster was fixed at second zero.
  await aPage.getByTestId('header-video-call-btn').click();
  await expect(cPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
  await cPage.getByTestId('call-accept-btn').click();
  await expect.poll(() => remoteAudioCount(aPage), { timeout: 45000 }).toBeGreaterThanOrEqual(1);

  const callId = await aPage.evaluate(async () => {
    const r = await fetch('/api/calls/active', {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    return (await r.json())?.call?.call_id ?? null;
  });
  expect(callId, 'no active call to invite into').toBeTruthy();

  const invited = await aPage.evaluate(async ([id, userId]) => {
    const r = await fetch(`/api/calls/${id}/invite`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ user_ids: [userId] }),
    });
    return { status: r.status, body: await r.json() };
  }, [callId, seeded.users.dave.id]);

  expect(invited.status, JSON.stringify(invited.body)).toBe(200);
  expect(invited.body.invited).toEqual([seeded.users.dave.id]);
  expect(invited.body.outcome[seeded.users.dave.id]).toBe('invited');

  // Somebody who is IN the room is reported as such rather than added twice or refused.
  //
  // "Holds a roster row" is deliberately not the test for this. Every member of the
  // conversation holds one from the moment the call starts, and bob — who let this ring
  // out — holds one too; treating that as `already_invited` made a member who never
  // answered, or who left, unreachable by invite, which is the main reason to invite
  // somebody. Carol is on the call, so she genuinely has nothing to be invited to.
  const again = await aPage.evaluate(async ([id, userId]) => {
    const r = await fetch(`/api/calls/${id}/invite`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ user_ids: [userId] }),
    });
    return { status: r.status, body: await r.json() };
  }, [callId, seeded.users.carol.id]);
  expect(again.status).toBe(200);
  expect(again.body.outcome[seeded.users.carol.id]).toBe('already_invited');
  expect(again.body.invited).toEqual([]);

  // Dave — never in the conversation — is rung by the invite and can accept, and the
  // server puts him on the call.
  await expect(dPage.getByTestId('call-accept-btn'), 'the invitee was never rung')
    .toBeVisible({ timeout: 25000 });
  await dPage.getByTestId('call-accept-btn').click();

  await expect
    .poll(async () => dPage.evaluate(async () => {
      const r = await fetch('/api/calls/active', {
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
      });
      return (await r.json())?.call?.self_joined ?? null;
    }), {
      timeout: 30000,
      message: 'the invitee accepted but the server never recorded them as joined',
    })
    .toBe(true);

  // And the media follows — the point of the whole feature.
  //
  // `self_joined` above is NOT sufficient evidence of that, and reading it as if it were
  // is how this assertion came to be left out: the server sets `joined_at` inside `_join`,
  // which happens BEFORE the joiner has seen `call:group_participants`, asked for a room
  // token, or reached the SFU. So `self_joined` goes true a full round trip early, and
  // anything checked at that instant looks like an invitee who joined but has no media.
  // The two facts need separate waits.
  await expect
    .poll(() => remoteAudioCount(dPage), {
      timeout: 45000,
      message: 'the invitee joined but never received the other participants\' audio',
    })
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(() => remoteAudioCount(aPage), {
      timeout: 45000,
      message: 'the invitee joined but the existing participants never received their audio',
    })
    .toBeGreaterThanOrEqual(2);
  // Three people on the call, from the perspective of someone who was never in the
  // conversation it started from.
  await expect.poll(() => gridCounts(dPage), { timeout: 30000 })
    .toEqual({ tiles: 3, participants: 3 });

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await Promise.all(ctxs.map((c) => c.close()));
});

test('adding people from the call screen: the button works, and the grid shows them ringing before they answer', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const ctxs = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })));
  const [aPage, cPage, dPage] = await Promise.all(ctxs.map((c) => c.newPage()));

  await signInAndOpenGroup(aPage, 'alice');
  await signInAndOpenGroup(cPage, 'carol');
  await uiLogin(dPage, seeded.users.dave.email, seeded.users.dave.password);
  await expect(dPage.getByTestId('conversation-search')).toBeVisible();

  await aPage.getByTestId('header-video-call-btn').click();
  await expect(cPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
  await cPage.getByTestId('call-accept-btn').click();
  await expect.poll(() => remoteAudioCount(aPage), { timeout: 45000 }).toBeGreaterThanOrEqual(1);

  // The whole point of this test: the invite goes through the UI, not a fetch. Both
  // "Add people" buttons on the call screens used to be rendered with no onClick at
  // all, so every previous invite test proved the endpoint and none of them proved
  // there was any way for a user to reach it.
  await aPage.getByTestId('call-add-people-btn').click();
  await expect(aPage.getByTestId('add-participants-modal')).toBeVisible();

  // Carol is on the call, so she is listed but not selectable — a name silently missing
  // from this list reads as "not in this organisation".
  const carolRow = aPage.locator(`[data-testid="add-participant-item"][data-user-id="${seeded.users.carol.id}"]`);
  await expect(carolRow).toBeVisible();
  await expect(carolRow).toBeDisabled();

  await aPage.getByTestId('add-participants-search').fill('dave');
  const daveRow = aPage.locator(`[data-testid="add-participant-item"][data-user-id="${seeded.users.dave.id}"]`);
  await expect(daveRow).toBeVisible({ timeout: 15000 });
  await daveRow.click();
  await aPage.getByTestId('add-participants-confirm').click();
  await expect(aPage.getByTestId('add-participants-modal')).toBeHidden({ timeout: 15000 });

  // Ringing, and visible as ringing. `call:participants_invited` has been published to
  // everyone in the call since the invite endpoint existed and nothing read it, so an
  // invitee appeared out of nowhere when they answered — and an invite nobody answered
  // left no trace at all.
  await expect.poll(() => pendingCount(aPage), {
    timeout: 20000,
    message: 'the inviter was never told the invitee is ringing',
  }).toBe(1);
  await expect(aPage.getByTestId('video-grid-pending')).toBeVisible();
  // Carol, already in the call, is told too.
  await expect.poll(() => pendingCount(cPage), { timeout: 20000 }).toBe(1);

  // Answering retires the placeholder and produces a real tile with real media.
  await expect(dPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 25000 });
  await dPage.getByTestId('call-accept-btn').click();

  await expect.poll(() => remoteAudioCount(dPage), { timeout: 45000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => pendingCount(aPage), {
    timeout: 30000,
    message: 'the placeholder outlived the person it was standing in for',
  }).toBe(0);
  await expect.poll(() => gridCounts(aPage), { timeout: 30000 })
    .toEqual({ tiles: 3, participants: 3 });

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await Promise.all(ctxs.map((c) => c.close()));
});

test('an invitee who declines stops ringing for everyone, and the call carries on', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const ctxs = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })));
  const [aPage, cPage, dPage] = await Promise.all(ctxs.map((c) => c.newPage()));

  await signInAndOpenGroup(aPage, 'alice');
  await signInAndOpenGroup(cPage, 'carol');
  await uiLogin(dPage, seeded.users.dave.email, seeded.users.dave.password);
  await expect(dPage.getByTestId('conversation-search')).toBeVisible();

  await aPage.getByTestId('header-video-call-btn').click();
  await expect(cPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
  await cPage.getByTestId('call-accept-btn').click();
  await expect.poll(() => remoteAudioCount(aPage), { timeout: 45000 }).toBeGreaterThanOrEqual(1);

  await aPage.getByTestId('call-add-people-btn').click();
  await aPage.getByTestId('add-participants-search').fill('dave');
  const daveRow = aPage.locator(`[data-testid="add-participant-item"][data-user-id="${seeded.users.dave.id}"]`);
  await expect(daveRow).toBeVisible({ timeout: 15000 });
  await daveRow.click();
  await aPage.getByTestId('add-participants-confirm').click();
  await expect.poll(() => pendingCount(aPage), { timeout: 20000 }).toBe(1);

  await expect(dPage.getByTestId('call-decline-btn')).toBeVisible({ timeout: 25000 });
  await dPage.getByTestId('call-decline-btn').click();

  // Declining a group call was a complete no-op on the server: group calls are created
  // `connected`, never `ringing`, so `_decline` returned before telling anybody. The
  // decliner kept a roster row marked as somebody still expected to arrive, which is
  // what the placeholder reads from — it would have sat there for the rest of the call.
  await expect.poll(() => pendingCount(aPage), {
    timeout: 25000,
    message: 'the declined invitee is still shown as ringing',
  }).toBe(0);
  await expect.poll(() => pendingCount(cPage), { timeout: 25000 }).toBe(0);

  // And one person saying no did not end a call two other people are in.
  await expect.poll(() => gridCounts(aPage), { timeout: 20000 })
    .toEqual({ tiles: 2, participants: 2 });
  expect(await remoteAudioCount(aPage)).toBeGreaterThanOrEqual(1);

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await Promise.all(ctxs.map((c) => c.close()));
});

test('with a second camera the Flip control appears, and flipping keeps the call alive and unmirrored', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const ctxs = await Promise.all([0, 1].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })));
  const [aPage, bPage] = await Promise.all(ctxs.map((c) => c.newPage()));

  // Chromium's fake capture device exposes exactly one video input, so the control is
  // correctly hidden in every other test here and the whole path would go uncovered.
  // Stubbing the DEVICE LIST is the smallest lie that exercises the real code: the
  // gate reads a camera count, and `flipCamera` reads the same list when the platform
  // reports no `facingMode` (which is every desktop browser).
  await aPage.addInitScript(() => {
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    navigator.mediaDevices.enumerateDevices = async () => {
      const devices = await real();
      const cam = devices.find((d) => d.kind === 'videoinput');
      if (!cam) return devices;
      return [...devices, {
        deviceId: 'fake-back-camera',
        kind: 'videoinput',
        label: 'Back Camera',
        groupId: cam.groupId,
        toJSON() { return this; },
      }];
    };
  });

  await signInAndOpenGroup(aPage, 'alice');
  await signInAndOpenGroup(bPage, 'bob');

  await aPage.getByTestId('header-video-call-btn').click();
  await expect(bPage.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
  await bPage.getByTestId('call-accept-btn').click();
  await expect.poll(() => remoteAudioCount(aPage), { timeout: 45000 }).toBeGreaterThanOrEqual(1);

  // Alice sees the control; Bob, with one camera, does not.
  await expect(aPage.getByTestId('call-flip-camera-btn'),
    'a machine with two cameras was not offered the switch').toBeVisible({ timeout: 20000 });
  await expect(bPage.getByTestId('call-flip-camera-btn'),
    'a machine with one camera was offered a switch that cannot do anything').toHaveCount(0);

  await aPage.getByTestId('call-flip-camera-btn').click();
  await aPage.waitForTimeout(1500);

  // The call survives. This is the assertion that matters: `flipCamera` used to take
  // `videoTrackPublications[0]`, which is the SCREEN SHARE when one is running, and a
  // `restartTrack` on the wrong publication is how a flip takes the call down with it.
  expect(await remoteAudioCount(aPage), 'flipping the camera dropped the call').toBeGreaterThanOrEqual(1);
  expect(await remoteAudioCount(bPage), 'flipping the camera dropped it for the peer').toBeGreaterThanOrEqual(1);
  await expect.poll(() => gridCounts(aPage), { timeout: 20000 }).toEqual({ tiles: 2, participants: 2 });
  // And still nothing mirrored, whichever camera the flip landed on.
  expect(await mirroredVideoCount(aPage)).toBe(0);

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await Promise.all(ctxs.map((c) => c.close()));
});

test('camera off and on in a group call: the peers see it, and rapid taps settle consistently', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const ctxs = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })));
  const [aPage, bPage, cPage] = await Promise.all(ctxs.map((c) => c.newPage()));

  await signInAndOpenGroup(aPage, 'alice');
  await signInAndOpenGroup(bPage, 'bob');
  await signInAndOpenGroup(cPage, 'carol');

  await aPage.getByTestId('header-video-call-btn').click();
  for (const page of [bPage, cPage]) {
    await expect(page.getByTestId('call-accept-btn')).toBeVisible({ timeout: 20000 });
    await page.getByTestId('call-accept-btn').click();
  }
  for (const [who, page] of [['alice', aPage], ['bob', bPage], ['carol', cPage]]) {
    await expect.poll(() => remoteAudioCount(page), {
      timeout: 45000, message: `${who} got no remote audio`,
    }).toBeGreaterThanOrEqual(2);
  }
  // Three cameras visible to everyone: their own tile plus two peers.
  for (const [who, page] of [['alice', aPage], ['bob', bPage], ['carol', cPage]]) {
    await expect.poll(() => gridVideoCount(page), {
      timeout: 45000, message: `${who} never saw all three cameras`,
    }).toBe(3);
  }

  // ── Alice turns her camera OFF ────────────────────────────────────────────
  await aPage.getByTestId('call-camera-btn').click();

  // Her own tile drops to an avatar rather than a frozen last frame — the SDK stops
  // the MediaStreamTrack on mute, so the camera indicator light goes out too.
  await expect.poll(() => gridVideoCount(aPage), {
    timeout: 20000, message: "alice's own tile kept rendering video after she turned the camera off",
  }).toBe(2);

  // And BOTH peers see it. This is the assertion that matters: it can only pass if the
  // mute actually reached them, either natively as `TrackMuted` or over the socket as
  // `call:media_toggle`.
  for (const [who, page] of [['bob', bPage], ['carol', cPage]]) {
    await expect.poll(() => gridVideoCount(page), {
      timeout: 25000, message: `${who} did not see alice's camera go off`,
    }).toBe(2);
  }
  // Audio is untouched — camera and microphone are independent publications.
  for (const [who, page] of [['bob', bPage], ['carol', cPage]]) {
    expect(await remoteAudioCount(page), `${who} lost audio when alice's camera went off`)
      .toBeGreaterThanOrEqual(2);
  }

  // ── And back ON, without rejoining ───────────────────────────────────────
  await aPage.getByTestId('call-camera-btn').click();
  for (const [who, page] of [['alice', aPage], ['bob', bPage], ['carol', cPage]]) {
    await expect.poll(() => gridVideoCount(page), {
      timeout: 30000, message: `${who} never saw alice's camera come back`,
    }).toBe(3);
  }
  // The call was never re-established: the duration keeps counting from the original
  // connect, so a rejoin would show as a reset clock.
  await expect(aPage.getByTestId('video-grid')).toBeVisible();

  // ── Rapid taps ───────────────────────────────────────────────────────────
  // Four clicks dispatched SYNCHRONOUSLY, in one task, so React has no chance to
  // re-render between them and every handler sees the same rendered props.
  //
  // `page.click()` cannot express this: it waits for actionability, which lets React
  // flush in between, so the taps serialise themselves and the race never happens. In
  // one task the old handler read `isCameraOn` from the same stale render four times,
  // computed the same target four times, and four taps produced ONE toggle — ending
  // OFF where the user asked for ON. Reading the store per tap is what makes this
  // alternate properly, and the chain in `livekitClient` is what stops the four
  // operations finishing out of order.
  await aPage.evaluate(() => {
    const button = document.querySelector('[data-testid="call-camera-btn"]');
    for (let i = 0; i < 4; i += 1) button.click();
  });

  await expect.poll(() => gridVideoCount(aPage), {
    timeout: 30000, message: 'four synchronous taps did not settle back to camera-on',
  }).toBe(3);
  for (const [who, page] of [['bob', bPage], ['carol', cPage]]) {
    await expect.poll(() => gridVideoCount(page), {
      timeout: 30000, message: `${who} was left with the wrong camera state after rapid taps`,
    }).toBe(3);
  }
  // Exactly one camera publication survived the burst — duplicate publications would
  // show up as an extra tile or a second video in alice's own tile.
  await expect.poll(() => gridCounts(aPage), { timeout: 20000 })
    .toEqual({ tiles: 3, participants: 3 });

  await aPage.locator('[data-testid="call-end-btn"]:visible').first().click();
  await Promise.all(ctxs.map((c) => c.close()));
});
