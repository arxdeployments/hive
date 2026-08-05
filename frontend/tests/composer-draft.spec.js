import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The composer must not carry an unsent draft into the next conversation.
 *
 * MessageComposer holds its text in local `useState` and is rendered from
 * ChatPanel with no `key`, so switching conversations is a prop change, not a
 * remount — the component and its state survive. `handleSend` then targets
 * whatever `conversationId` is current. So a message typed for one person and
 * left unsent is still sitting in the box when you open someone else's thread,
 * and the next Send delivers it to them.
 *
 * The same holds for staged attachments, which is the worse half: an image
 * picked for one conversation is still staged in another.
 */

const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix, ['alice', 'bob', 'carol']);
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

test('an unsent draft does not follow you into another conversation', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();

  await openConversationWith(page, 'Bob E2E');
  const secret = `for bob only ${suffix}`;
  await page.getByTestId('message-input').fill(secret);
  await expect(page.getByTestId('message-input')).toHaveValue(secret);

  // Leave without sending.
  await openConversationWith(page, 'Carol E2E');

  await expect(
    page.getByTestId('message-input'),
    'Bob’s unsent draft is sitting in Carol’s composer; the next Send delivers it to her'
  ).toHaveValue('');
});

test('returning to a conversation does not resurrect a draft into a third one', async ({ page }) => {
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();

  await openConversationWith(page, 'Bob E2E');
  await page.getByTestId('message-input').fill(`draft one ${suffix}`);
  await openConversationWith(page, 'Carol E2E');
  await page.getByTestId('message-input').fill(`draft two ${suffix}`);
  await openConversationWith(page, 'Bob E2E');

  await expect(
    page.getByTestId('message-input'),
    'text typed for Carol is now in Bob’s composer'
  ).toHaveValue('');
});
