import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * Guards the "list is mounted but renders nothing" class of bug.
 *
 * The virtualized message list can be present in the DOM, correctly sized, and
 * still show zero rows if data never reaches it. That failure is invisible to a
 * smoke test that only checks the page loaded, so assert on actual rendered
 * message content after opening an existing conversation — including after a
 * reload, which is when history (not live socket data) populates the list.
 */
const suffix = `render${process.pid}${Math.floor(Math.random() * 1000)}`;
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

test('history renders in the message list, at a small viewport too', async ({ page }) => {
  // Deliberately small: a short viewport is where flex/virtualization bugs bite.
  await page.setViewportSize({ width: 900, height: 460 });

  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openWith(page, 'Bob E2E');

  const marker = `render check ${suffix}`;
  await page.getByTestId('message-input').fill(marker);
  await page.getByTestId('message-send-btn').click();
  await expect(page.getByText(marker).first()).toBeVisible();

  // The decisive assertion: after a reload the list is populated from history.
  await page.reload();
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openWith(page, 'Bob E2E');

  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 10000 });

  // Assert on rendered, on-screen message content rather than virtuoso's
  // internal DOM: its row container is not the element carrying
  // data-testid="virtuoso-item-list", so counting that element's children
  // reports 0 even when the list is fully populated. (Cost several hours of
  // phantom debugging — assert what the user sees, not library internals.)
  const bubble = page.getByText(marker).first();
  const box = await bubble.boundingBox();
  expect(box, 'message has no layout box').not.toBeNull();
  expect(box.height).toBeGreaterThan(0);
  expect(box.y).toBeLessThan(460); // inside the short viewport, not below the fold

  // Earlier history is present too, not just the message we just sent.
  await expect(page.getByTestId('message-status').first()).toBeVisible();
});
