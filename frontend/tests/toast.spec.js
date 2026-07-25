import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * Toasts must be dismissible and short-lived. They render over the content
 * behind them, so a stack of slow-expiring confirmations (mute/unmute toggled
 * twice) obscured the contact details underneath.
 */
const suffix = `toast${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix);
});

async function openWith(page, who) {
  const existing = page.getByTestId('conversation-item').filter({ hasText: who });
  if (await existing.count()) await existing.first().click();
  else {
    await page.getByTestId('new-chat-button').click();
    await page.getByTestId('contact-item').filter({ hasText: who }).first().click();
  }
  await expect(page.getByTestId('message-input')).toBeVisible();
}

/** Fire a toast through a real user action (mute from the chat header menu). */
async function triggerToast(page) {
  await page.getByTestId('chat-header-menu-trigger').click();
  await page.getByTestId('chat-header-menu-mute').click();
}

test('toast has a visible close button that dismisses it immediately', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openWith(page, 'Bob E2E');

  await triggerToast(page);

  const toast = page.locator('[data-sonner-toast]').first();
  await expect(toast).toBeVisible();

  // The X must be visible without hovering — not sonner's hover-only default.
  const close = toast.locator('[data-close-button]');
  await expect(close).toBeVisible();
  expect((await close.boundingBox())?.width ?? 0).toBeGreaterThan(0);

  await close.click();
  await expect(toast).toBeHidden({ timeout: 1000 }); // gone at once, not after the timeout
});

test('toasts auto-dismiss quickly and do not stack up', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openWith(page, 'Bob E2E');

  // Toggle twice in quick succession — the case from the report.
  await triggerToast(page);
  await triggerToast(page);
  expect(await page.locator('[data-sonner-toast]').count()).toBeLessThanOrEqual(2);

  // Everything clears well inside the old 4s duration.
  await expect(page.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 3500 });
});
