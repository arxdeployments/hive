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

// message-send-btn only exists once the composer has text — it is the voice
// record button otherwise — so the fill has to precede the click.
async function sendMessage(page, text) {
  await page.getByTestId('message-input').fill(text);
  await page.getByTestId('message-send-btn').click();
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

/**
 * The two tests above assert the composer is empty after a switch — the symptom.
 * The harm named at the top of this file is the next Send reaching the wrong
 * person, and nothing asserted that: no spec in the suite sends a message after
 * switching conversations, so the `key={conversationId}` remount is never
 * exercised ahead of a send.
 *
 * Three contexts because the claim is about routing. Alice's own view cannot
 * tell "Carol got it" from "Bob got it too" — only Bob's and Carol's can.
 *
 * The 5s budget is the suite's cross-user delivery contract (see README): it is
 * tighter than the sidebar's fallback poll, so a broken WebSocket fails here
 * rather than quietly degrading to polling.
 */
test('a message sent after switching conversations reaches only that conversation', async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const carolCtx = await browser.newContext();

  try {
    const aPage = await aliceCtx.newPage();
    const bPage = await bobCtx.newPage();
    const cPage = await carolCtx.newPage();

    await uiLogin(aPage, seeded.users.alice.email, seeded.users.alice.password);
    await uiLogin(bPage, seeded.users.bob.email, seeded.users.bob.password);
    await uiLogin(cPage, seeded.users.carol.email, seeded.users.carol.password);
    await expect(aPage.getByTestId('conversation-search')).toBeVisible();
    await expect(bPage.getByTestId('conversation-search')).toBeVisible();
    await expect(cPage.getByTestId('conversation-search')).toBeVisible();

    // Alice opens each thread first: it has to exist before the other side can
    // find it in their sidebar.
    await openConversationWith(aPage, 'Bob E2E');
    const stranded = `never sent to bob ${suffix}`;
    await aPage.getByTestId('message-input').fill(stranded);
    await expect(aPage.getByTestId('message-input')).toHaveValue(stranded);
    await openConversationWith(bPage, 'Alice E2E');

    // Abandon Bob's draft and switch. This is the remount under test.
    await openConversationWith(aPage, 'Carol E2E');
    await expect(aPage.getByTestId('message-input')).toHaveValue('');
    await openConversationWith(cPage, 'Alice E2E');

    const forCarol = `for carol ${suffix} ${Math.floor(Math.random() * 1e6)}`;
    const sentAt = Date.now();
    await sendMessage(aPage, forCarol);
    await expect(aPage.getByText(forCarol).first()).toBeVisible();

    await expect(
      cPage.getByText(forCarol).first(),
      'a message sent after a conversation switch never reached its recipient'
    ).toBeVisible({ timeout: 5000 });
    expect(Date.now() - sentAt).toBeLessThan(5000);

    // Carol has it, so delivery has completed — anything on Bob's side now is
    // misrouted rather than still in flight.
    await expect(
      bPage.getByText(forCarol),
      'a message composed for Carol was delivered to Bob'
    ).toHaveCount(0);
    await expect(
      bPage.getByText(stranded),
      'the abandoned draft was delivered to Bob'
    ).toHaveCount(0);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
    await carolCtx.close();
  }
});
