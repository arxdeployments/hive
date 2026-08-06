import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The composer must not carry an unsent draft into the next conversation.
 *
 * MessageComposer holds its text and staged attachments in local `useState`
 * with no reset of their own, and it used to be rendered from ChatPanel with no
 * `key` — so switching conversations was a prop change rather than a remount,
 * and that state survived. `handleSend` targets whatever `conversationId` is
 * current, so a message typed for one person and left unsent was still in the
 * box when you opened someone else's thread, and the next Send delivered it to
 * them. Staged images were the worse half: an image picked for one conversation
 * stayed staged in another.
 *
 * ChatPanel now passes `key={conversationId}` (see the comment at that prop),
 * so the composer remounts on a switch and its state goes with it. These tests
 * hold that line.
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
  // The header, not the composer, is the synchronisation point. message-input
  // is already visible from the conversation we are leaving, so waiting on its
  // visibility returns immediately and a following fill() can land in the old
  // composer — which the key={conversationId} remount then wipes. The test goes
  // on to assert the box is empty and passes without ever having tested the
  // draft it meant to. Waiting for the identity to name the counterpart proves
  // the switch happened; the composer remount precedes the header, which only
  // resolves the name once the conversation itself has loaded.
  await expect(page.getByTestId('chat-header-identity')).toContainText(counterpartName);
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
