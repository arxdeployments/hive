import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The hold gesture has to survive the element it started on.
 *
 * `useHoldToTalk` took pointer capture on the mic button and listened for
 * move/up there. But starting a recording is exactly what unmounts that button:
 * the composer renders `AudioRecorderBar` in place of the whole row as soon as
 * `recorder.state` leaves 'idle', and that happens a few hundred ms into every
 * hold, while the finger is still down. Capture dies with the element, the rest
 * of the gesture lands on whatever is under the finger by then — the recorder
 * bar, which was handed `hold` for display but never `hold.handlers` — and the
 * hook heard nothing more.
 *
 * So the three things the gesture exists for all stopped at the moment they
 * became reachable: no drag tracking, no slide-to-cancel, and no release-to-send.
 * The recording just ran on until the user found the bar's own Discard button.
 *
 * The fix moves capture and the move/up handlers to a surface that spans both
 * the composer row and the recorder bar, so the swap happens INSIDE the gesture
 * rather than under it. Both assertions in the first test below are about events
 * arriving after the button is gone; the `toBeHidden` in between is what makes
 * that meaningful, since it is the proof the swap already happened.
 *
 * The first test cancels, which isolates the gesture but leaves the third of
 * those three behaviours — release-to-send — resting on nothing. The second test
 * covers it end to end, and is the only test in the suite that produces a voice
 * message at all.
 *
 * Driven with the real mouse rather than synthetic PointerEvents on purpose:
 * `setPointerCapture` throws NotFoundError for a pointer id that is not actually
 * down, so a dispatched event would fail inside `onPointerDown` and never reach
 * the behaviour under test. Only the coarse-pointer gate is faked — it is a
 * media query, not part of the lifecycle, and Playwright's mobile emulation
 * would drag touch-event translation in with it for no benefit.
 */

const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix, ['alice', 'bob']);
});

/** Open the coarse-pointer gate, leaving every other media query real. */
const forceCoarsePointer = (page) =>
  page.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      if (!String(query).includes('pointer: coarse')) return real(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() { return false; },
      };
    };
  });

async function openConversationWith(page, counterpartName) {
  const sidebarItem = page.getByTestId('conversation-item').filter({ hasText: counterpartName });
  if (await sidebarItem.count()) {
    await sidebarItem.first().click();
  } else {
    await page.getByTestId('new-chat-button').click();
    await page.getByTestId('contact-item').filter({ hasText: counterpartName }).first().click();
  }
  await expect(page.getByTestId('message-input')).toBeVisible();
}

test('the gesture keeps the pointer after the mic button is swapped for the recorder bar', async ({ page }) => {
  await forceCoarsePointer(page);

  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  const mic = page.getByTestId('voice-record-btn');
  await expect(mic).toHaveAttribute('data-hold-active', 'true');
  const box = await mic.boundingBox();
  expect(box, 'the mic button was not on screen').not.toBeNull();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();

  // The swap. Everything after this point is a gesture whose original element
  // no longer exists.
  await expect(page.getByTestId('audio-recorder-bar')).toBeVisible();
  await expect(mic).toBeHidden();

  // Slide left past CANCEL_THRESHOLD (90px), holding y so it does not read as a
  // swipe up to lock. The strip only renders while the hook believes a finger is
  // down, and only arms once it has tracked the travel — so seeing it armed is
  // pointermove having been heard by a hook whose button is gone.
  await page.mouse.move(start.x - 60, start.y, { steps: 4 });
  await page.mouse.move(start.x - 130, start.y, { steps: 4 });
  const strip = page.getByTestId('hold-to-talk-strip');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('data-cancel-armed', 'true');

  // And the release. Cancel rather than send so the assertion rests on the
  // gesture alone: `onPointerUp` checks the cancel threshold before the
  // MIN_HOLD_MS guard and before any upload, so a returned-to-idle composer
  // means the pointerup arrived and nothing else.
  await page.mouse.up();
  await expect(page.getByTestId('audio-recorder-bar')).toBeHidden();
  await expect(page.getByTestId('message-input')).toBeVisible();
});

/**
 * Release-to-send, all the way to the other user's screen.
 *
 * The test above deliberately cancels, so nothing in the suite ever proved that
 * a released hold produces a message — `audio-bubble` appeared in no spec at all.
 * That left the send path covered only by its parts: the gesture here, the
 * recorder in voice-recorder-leak, the upload in bubble-layout. Nothing joined
 * them, which is exactly where a regression hides.
 *
 * Two independent minimums have to be cleared, and missing either drops the send
 * SILENTLY — no toast, no bubble, an idle composer indistinguishable from a
 * cancel. `MIN_HOLD_MS` (300ms) in useHoldToTalk gates `onSend` at all, and
 * `MIN_DURATION_SECONDS` (0.6s) in useAudioRecorder lands `onstop` on 'idle'
 * rather than 'preview', so `uploadVoice` is never reached. The hold below is
 * long enough for both with room for a slow box to open the fake device, since
 * the clip is only as long as the time AFTER getUserMedia resolves.
 */
test('a released hold sends the voice message and the second user receives it', async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  try {
    // Alice gestures, so only she needs the coarse-pointer gate open.
    await forceCoarsePointer(aPage);

    await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
    await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
    await expect(aPage.getByTestId('conversation-search')).toBeVisible();
    await expect(bPage.getByTestId('conversation-search')).toBeVisible();

    await openConversationWith(aPage, 'Bob E2E');
    await openConversationWith(bPage, 'Alice E2E');

    // Counting rather than matching text, because a voice message carries none.
    // Sound only because the test above sends nothing and workers=1 keeps the
    // file sequential, so this thread has no other audio in it.
    await expect(bPage.getByTestId('audio-bubble')).toHaveCount(0);

    const mic = aPage.getByTestId('voice-record-btn');
    await expect(mic).toHaveAttribute('data-hold-active', 'true');
    const box = await mic.boundingBox();
    expect(box, 'the mic button was not on screen').not.toBeNull();
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await aPage.mouse.move(start.x, start.y);
    await aPage.mouse.down();
    // The bar is also the proof `onStart` resolved, which is what sets `armed` —
    // an unarmed release returns before `onSend` and would send nothing.
    await expect(aPage.getByTestId('audio-recorder-bar')).toBeVisible();

    await aPage.waitForTimeout(2000);

    // Released without travelling: past 90px left cancels and past 55px up locks,
    // and either would quietly make this a test of something else.
    await aPage.mouse.up();

    // Alice's own bubble is the whole send having completed — gesture released,
    // blob finalised, upload stored, message committed server-side.
    await expect(aPage.getByTestId('audio-bubble')).toHaveCount(1);

    // The 5s budget starts HERE, not at the release. The requirement is on
    // cross-user delivery, and everything before this point is Alice-side
    // recording and upload that has to finish before there is a message to
    // deliver at all — charging that to the delivery budget would measure the
    // wrong thing. This mirrors the text-message equivalent in messaging.spec.js.
    const sentAt = Date.now();
    await expect(bPage.getByTestId('audio-bubble')).toHaveCount(1, { timeout: 5000 });
    expect(
      Date.now() - sentAt,
      'the voice message took longer than 5s to reach the second user'
    ).toBeLessThan(5000);

    // Delivered AND playable. A 0-byte blob, or the Infinity/NaN duration the
    // container reports when the server sends none, both still render a bubble —
    // they just render it reading 0:00, so this is what separates a real voice
    // message from an empty shell of one.
    await expect(bPage.getByTestId('audio-play-toggle').first()).toBeVisible();
    await expect(bPage.getByTestId('audio-duration').first()).not.toHaveText('0:00');
  } finally {
    // In a finally so a failed assertion above still tears the contexts down;
    // workers=1 means a leaked context would follow the rest of the run.
    await aliceCtx.close();
    await bobCtx.close();
  }
});
