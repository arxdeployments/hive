import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The recorder must never leave a microphone open.
 *
 * `useAudioRecorder.start()` guarded re-entry on `state !== 'idle'`, but `state`
 * is React state and is not set to 'recording' until AFTER the getUserMedia
 * await. No render happens during that await, so two clicks inside the
 * device-open window both read 'idle' and both open a stream — and the second
 * assignment to `streamRef` orphans the first. `releaseStream()` can then only
 * ever stop the survivor: the browser's recording indicator stays lit and the
 * device stays held against other apps until the page is reloaded.
 *
 * Three more things ride on the same orphaned instance: its MediaRecorder keeps
 * appending into the shared chunk array (so the sent file interleaves two takes
 * behind two container headers), its 200ms tick keeps re-rendering the composer
 * for the life of the page, and its track-watcher listeners stay attached.
 *
 * The race is made deterministic without injecting any delay: dispatching both
 * clicks inside one `page.evaluate` means the first handler suspends at the
 * getUserMedia await before the second click is delivered. That is the real code
 * path, not a simulation of it.
 *
 * The assertion counts EVERY stream getUserMedia ever handed out, not the one
 * the hook still has a reference to — that is the whole point, since the leaked
 * stream is precisely the one nothing holds any more.
 */

const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix, ['alice', 'bob', 'carol']);
});

/** Record every stream getUserMedia hands out, before the app can call it. */
const trackStreams = (page) =>
  page.addInitScript(() => {
    window.__micStreams = [];
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) return;
    const real = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints) => {
      const s = await real(constraints);
      window.__micStreams.push(s);
      return s;
    };
  });

const liveTracks = (page) =>
  page.evaluate(() =>
    window.__micStreams
      .flatMap((s) => s.getTracks())
      .filter((t) => t.readyState === 'live').length
  );

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

test('a double-clicked mic leaves no microphone open', async ({ page }) => {
  await trackStreams(page);

  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  // Both clicks in ONE task. The mic button is not disabled while a start is in
  // flight (it is `disabled={!hasText && !canRecord}`), and the recorder bar that
  // replaces it only mounts once the state leaves 'idle' — i.e. after the await —
  // so it stays mounted and clickable for the whole device-open window.
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="voice-record-btn"]');
    if (!btn) return 0;
    btn.click();
    btn.click();
    return 2;
  });
  expect(clicked, 'the mic button was not on screen').toBe(2);

  await expect(page.getByTestId('audio-recorder-bar')).toBeVisible();
  // Discard rather than send, so the assertion does not depend on
  // MIN_DURATION_SECONDS or on an upload succeeding. `cancel()` sets discardRef,
  // which onstop checks before the duration guard, and routes through the same
  // releaseStream().
  await page.getByTestId('audio-discard-btn').click();
  await expect(page.getByTestId('message-input')).toBeVisible();

  const seen = await page.evaluate(() => ({
    opened: window.__micStreams.length,
    live: window.__micStreams
      .flatMap((s) => s.getTracks())
      .filter((t) => t.readyState === 'live').length,
  }));

  // The invariant that matters, asserted first: the hook's own docblock says
  // "Every exit path stops the MediaStream tracks."
  expect(seen.live, 'a microphone track was left live after the recording ended').toBe(0);
  // And the mechanism, so a regression names its own cause.
  expect(seen.opened, 'the duplicate click opened a second MediaStream').toBe(1);
});

test('switching conversations while the mic is opening does not strand the stream', async ({ page }) => {
  // The same leak by a different trigger, and the one `micHeldRef` cannot catch.
  // The composer is keyed on the conversation, so a switch REMOUNTS the hook —
  // and when that lands inside the device-open window, the unmount cleanup runs
  // while `streamRef` is still null. The stream then arrives into a dead
  // instance that nothing will ever call again, so no later Discard, Send or
  // unmount can reach it.
  await trackStreams(page);

  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  // Both threads have to exist in the sidebar first: the switch itself must
  // happen inside a single task, with no round trip to open a new chat.
  await openConversationWith(page, 'Carol E2E');
  await openConversationWith(page, 'Bob E2E');

  // Start the mic and switch away in the SAME task. The mic handler suspends at
  // the getUserMedia await; the sidebar click is a discrete event, so React
  // flushes the conversation change — and the composer's remount — before the
  // device ever finishes opening.
  const switched = await page.evaluate(() => {
    const mic = document.querySelector('[data-testid="voice-record-btn"]');
    if (!mic) return 'no mic button';
    mic.click();
    const other = [...document.querySelectorAll('[data-testid="conversation-item"]')]
      .find((el) => el.textContent.includes('Carol E2E'));
    if (!other) return 'no Carol conversation in the sidebar';
    other.click();
    return 'ok';
  });
  expect(switched).toBe('ok');

  await expect(page.getByTestId('chat-header-identity')).toContainText('Carol E2E');
  await expect(page.getByTestId('message-input')).toBeVisible();

  // The acquisition has to have actually happened, or there is nothing to leak
  // and the assertion below would pass vacuously.
  await expect(async () => {
    expect(await page.evaluate(() => window.__micStreams.length)).toBeGreaterThan(0);
  }).toPass({ timeout: 5000 });

  expect(await liveTracks(page), 'the conversation switch stranded an open microphone').toBe(0);
});
