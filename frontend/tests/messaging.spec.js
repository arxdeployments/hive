import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

// Unique suffix per run so seeded users/messages don't collide across runs.
const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix);
});

/**
 * Open the conversation with `counterpartName` from the current user's page.
 * Uses the existing sidebar entry when there is one, otherwise creates the
 * conversation through the New Chat contact picker (which is idempotent
 * server-side, so both sides converge on the same direct conversation).
 *
 * The counterpart is always the *other* user — the contact list excludes self.
 */
async function openConversationWith(page, counterpartName) {
  const sidebarItem = page.getByTestId('conversation-item').filter({ hasText: counterpartName });
  if (await sidebarItem.count()) {
    await sidebarItem.first().click();
  } else {
    await page.getByTestId('new-chat-button').click();
    // Scope to the picker so we never grab a same-named node behind the modal.
    await page.getByTestId('contact-item').filter({ hasText: counterpartName }).first().click();
  }
  // Composer visible = the conversation pane is open and ready.
  await expect(page.getByTestId('message-input')).toBeVisible();
}

async function sendMessage(page, text) {
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('message-send-btn').click();
}

test('login issues a session and lands on chat', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  // Cookie-only auth: nothing sensitive in web storage.
  const accessToken = await page.evaluate(() => localStorage.getItem('access_token'));
  expect(accessToken).toBeNull();
});

test('two users exchange a message in real time', async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const aPage = await aliceCtx.newPage();
  const bPage = await bobCtx.newPage();

  await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
  await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
  await expect(aPage.getByTestId('conversation-search')).toBeVisible();
  await expect(bPage.getByTestId('conversation-search')).toBeVisible();

  // Alice creates/opens the thread, then Bob opens the same thread from his side.
  await openConversationWith(aPage, 'Bob E2E');
  await openConversationWith(bPage, 'Alice E2E');

  const outbound = `hello bob ${suffix} ${Math.floor(Math.random() * 1e6)}`;
  const sentAt = Date.now();
  await sendMessage(aPage, outbound);
  await expect(aPage.getByText(outbound).first()).toBeVisible();

  // Delivered live over the WebSocket into Bob's open conversation.
  // The 5s budget is deliberate: the sidebar poll runs every 15s, so a pass
  // here can only come from the socket. Without it, a dead socket looks green.
  await expect(bPage.getByText(outbound).first()).toBeVisible({ timeout: 5000 });
  expect(Date.now() - sentAt).toBeLessThan(5000);

  // And the reverse direction, proving the socket is bidirectional.
  const reply = `hi alice ${suffix} ${Math.floor(Math.random() * 1e6)}`;
  await sendMessage(bPage, reply);
  await expect(aPage.getByText(reply).first()).toBeVisible({ timeout: 5000 });

  await aliceCtx.close();
  await bobCtx.close();
});

test('message persists across reload', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  const text = `persisted ${suffix} ${Math.floor(Math.random() * 1e6)}`;
  await sendMessage(page, text);
  await expect(page.getByText(text).first()).toBeVisible();

  await page.reload();
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');
  await expect(page.getByText(text).first()).toBeVisible();
});
