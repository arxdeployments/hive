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
 * rather than under it. Both assertions below are about events arriving after
 * the button is gone; the `toBeHidden` in between is what makes that meaningful,
 * since it is the proof the swap already happened.
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
