import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The chat surface, operated without a mouse and without sight.
 *
 * Every assertion here failed before this batch: the controls were bare `div`s
 * with an onClick (unreachable by keyboard, unnamed to a screen reader), the
 * overlays were plain `motion.div`s with no dialog role and no Escape — so
 * opening one was a dead end — and arrivals were never announced at all.
 *
 * Deliberately NOT asserted by Tab-hop counts. Between the sidebar's profile
 * button and its search box sit New Chat, New Group, Settings and, for an admin,
 * a whole WorkspaceSwitcher tablist — so "press Shift+Tab once" is a fixture
 * detail, not the property under test. What matters is that the control is
 * focusable and named, which is asserted directly.
 */

const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix, ['alice', 'bob']);
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

/** WCAG relative-luminance contrast, computed from what the browser actually paints. */
const CONTRAST = `(fg, bg) => {
  const chan = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (rgb) => {
    const [r, g, b] = rgb.match(/\\d+/g).map(Number);
    return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
  };
  const a = lum(fg), b2 = lum(bg);
  return (Math.max(a, b2) + 0.05) / (Math.min(a, b2) + 0.05);
}`;

test('the sidebar profile control is focusable and named', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();

  // It was a bare div: no role, no name, and no way to reach it — which meant a
  // keyboard-only user could not open their own profile at all, since this is
  // the only route to that drawer anywhere in the app.
  const profile = page.getByTestId('sidebar-profile-button');
  await expect(profile).toHaveAttribute('aria-label', /profile/i);
  await profile.focus();
  await expect(profile).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('profile-drawer')).toBeVisible();
});

test('a dialog announces itself, closes on Escape and gives focus back', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();

  const trigger = page.getByTestId('new-chat-button');
  await trigger.focus();
  await page.keyboard.press('Enter');

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  // Named from its own heading, so a screen reader says which dialog opened
  // rather than leaving the user silently inside an unnamed region.
  await expect(dialog).toHaveAccessibleName(/new conversation/i);

  // Escape was the whole point: the only previous way out was clicking the
  // backdrop, which a keyboard cannot do.
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  // And focus comes back to what opened it, rather than collapsing to <body>.
  // This is the assertion that catches capturing the restore target too late:
  // React runs `autoFocus` in the layout phase, before any passive effect, so
  // an effect-based capture saves the dialog's own search box and this fails.
  await expect(trigger).toBeFocused();
});

test('photos and reply quotes are operable from the keyboard', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  // Send a message, then quote it, so a reply block exists to assert against.
  const original = `quotable ${suffix}`;
  await page.getByTestId('message-input').fill(original);
  await page.getByTestId('message-send-btn').click();
  await expect(page.getByText(original).first()).toBeVisible();

  await page.getByTestId('message-menu-trigger').last().click();
  const replyItem = page.getByRole('menuitem').filter({ hasText: /^Reply$/ });
  await replyItem.first().click();
  await page.getByTestId('message-input').fill(`the reply ${suffix}`);
  await page.getByTestId('message-send-btn').click();

  const quote = page.getByTestId('reply-quote').last();
  await expect(quote).toBeVisible();
  // Was a div with onClick — no role, no tab stop, no name.
  await expect(quote).toHaveAttribute('role', 'button');
  await expect(quote).toHaveAttribute('tabindex', '0');
  await expect(quote).toHaveAccessibleName(/replied message/i);
  await quote.focus();
  await expect(quote).toBeFocused();
});

test('composer icon buttons are named, and arrivals are announced', async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  await uiLogin(alice, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bob, seeded.users.bob.email, seeded.users.bob.password);
  await expect(alice.getByTestId('conversation-search')).toBeVisible();
  await expect(bob.getByTestId('conversation-search')).toBeVisible();

  await openConversationWith(alice, 'Bob E2E');
  await openConversationWith(bob, 'Alice E2E');

  // Two icon-only buttons side by side that both announced as just "button".
  await expect(alice.getByTestId('composer-emoji-btn')).toHaveAccessibleName(/emoji/i);
  await expect(alice.getByTestId('composer-attach-btn')).toHaveAccessibleName(/attach/i);

  // The live region has to EXIST before the text lands in it, or assistive
  // technology has nothing subscribed to the change.
  const announcer = alice.getByTestId('message-announcer');
  await expect(announcer).toHaveAttribute('aria-live', 'polite');
  await expect(announcer).toHaveText('');

  const body = `announce me ${suffix}`;
  await bob.getByTestId('message-input').fill(body);
  await bob.getByTestId('message-send-btn').click();

  // Nothing else tells a non-sighted user this arrived: the socket handler
  // deliberately skips the sound, the notification and the unread bump while the
  // thread is open and visible, on the reasoning that you watch it appear.
  await expect(announcer).toHaveText(new RegExp(body));

  await aliceCtx.close();
  await bobCtx.close();
});

test('message text and the composer placeholder meet WCAG AA contrast', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  const body = `contrast ${suffix}`;
  await page.getByTestId('message-input').fill(body);
  await page.getByTestId('message-send-btn').click();
  await expect(page.getByText(body).first()).toBeVisible();

  // Read the painted colours rather than the source: what matters is the pixels,
  // and the bubble background is set several classes deep.
  // Resolved through Playwright rather than a DOM scan: the element holding the
  // text also holds the footer, so an exact textContent match finds nothing.
  const ownRatio = await page.getByText(body).last().evaluate((node, contrastSrc) => {
    // eslint-disable-next-line no-eval
    const contrast = eval(contrastSrc);
    let bubble = node;
    while (bubble && getComputedStyle(bubble).backgroundColor === 'rgba(0, 0, 0, 0)') bubble = bubble.parentElement;
    if (!bubble) return null;
    return contrast(getComputedStyle(node).color, getComputedStyle(bubble).backgroundColor);
  }, CONTRAST);

  expect(ownRatio, 'own-message bubble text is below the 4.5:1 AA floor').toBeGreaterThanOrEqual(4.5);

  const placeholderRatio = await page.evaluate(({ contrastSrc }) => {
    // eslint-disable-next-line no-eval
    const contrast = eval(contrastSrc);
    const input = document.querySelector('[data-testid="message-input"]');
    const ink = getComputedStyle(input, '::placeholder').color;
    let bg = input;
    while (bg && getComputedStyle(bg).backgroundColor === 'rgba(0, 0, 0, 0)') bg = bg.parentElement;
    return contrast(ink, getComputedStyle(bg).backgroundColor);
  }, { contrastSrc: CONTRAST });

  expect(placeholderRatio, 'composer placeholder is below the 4.5:1 AA floor').toBeGreaterThanOrEqual(4.5);
});
