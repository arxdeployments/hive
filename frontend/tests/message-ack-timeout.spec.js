import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * A text message the server never acknowledged must end up retryable, not
 * deleted.
 *
 * `ws.send()` on a socket whose network has died neither throws nor drops — it
 * buffers into a connection nobody is reading. So `sendMessage` returned true,
 * the optimistic bubble stayed on 'sending', and nothing anywhere resolved it:
 * `message_ack` and the matching `error` frame are the only two things that can,
 * the server sends `new_message` to everyone EXCEPT the sender, and
 * `message_status` keys on the real uuid the optimistic row does not have yet.
 *
 * Then the reconnect refetch replaced the array wholesale, carrying over only
 * 'failed' rows — so the message vanished from the thread with no toast, no
 * error and no way to retry. The comment on that filter said as much: scoped to
 * 'failed' "deliberately NOT 'sending' — there is no ack timeout anywhere, so a
 * preserved 'sending' bubble would hang for ever."
 *
 * `page.routeWebSocket` reproduces the precondition exactly rather than
 * approximating it: readyState stays OPEN, send() does not throw, and the frame
 * never reaches the server. Pings still get their pongs, so the socket is
 * healthy right up until it is closed — a half-open connection, which is what
 * produces this in the wild.
 */

const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix, ['alice', 'bob']);
});

/**
 * Proxy the app's socket, swallowing chat frames on demand.
 * @returns a handle whose `drop` decides whether message frames are forwarded,
 *          and whose `kill` closes the client side the way a network loss does.
 */
async function interceptSocket(page) {
  const state = { drop: false, sockets: [] };
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    state.sockets.push(ws);
    ws.onMessage((m) => {
      // Only the chat frame. Pings still get their pongs, so nothing else in the
      // client notices anything is wrong — which is the point.
      if (state.drop && typeof m === 'string' && m.includes('"type":"message"')) return;
      server.send(m);
    });
    server.onMessage((m) => ws.send(m));
  });
  return {
    set drop(v) { state.drop = v; },
    get drop() { return state.drop; },
    kill: () => state.sockets.forEach((ws) => { try { ws.close(); } catch { /* gone */ } }),
  };
}

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

async function sendText(page, body) {
  await page.getByTestId('message-input').fill(body);
  await page.getByTestId('message-send-btn').click();
}

test('a send the server never received survives the reconnect as retryable', async ({ page }) => {
  const socket = await interceptSocket(page);
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  socket.drop = true;
  const body = `never acked ${suffix}`;
  await sendText(page, body);
  await expect(page.locator('[data-testid="message-status"][data-status="sending"]')).toBeVisible();

  // Lose the socket well inside the 15s deadline. This is the ordering that
  // matters: the reconnect refetch runs long before the deadline would fire, so
  // resolving the send at socket loss is what keeps the bubble alive.
  socket.drop = false;
  socket.kill();

  // The retry control is only rendered for 'failed', so its presence IS the
  // assertion that the message survived the refetch in a recoverable state.
  await expect(
    page.getByTestId('message-retry'),
    'the unacked message was deleted by the reconnect refetch instead of being made retryable'
  ).toBeVisible({ timeout: 20000 });
  await expect(page.getByText(body).first()).toBeVisible();

  // ...and the control actually works: retrying puts the message on the server.
  await page.getByTestId('message-retry').click();
  await expect(page.locator('[data-testid="message-status"][data-status="sent"]').first())
    .toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('message-retry')).toHaveCount(0);
});

test('a jump to an older message does not delete a send still in flight', async ({ page }) => {
  // The same data loss with NO socket loss at all, and with no deadline elapsed.
  // `handleJumpToMessage` refetches an `around` window and replaces the array
  // wholesale — and jumping is exactly what people do WHILE waiting for a send
  // (tapping a pinned message, a reply quote, a search hit). Carrying only
  // 'failed' rows deleted the in-flight message outright, and the ack deadline
  // then found no row to mark and silently gave up, so the message was lost
  // exactly as before.
  //
  // The jump only refetches when the target is OUTSIDE the loaded window
  // (`scrollToLoaded` short-circuits otherwise), which is why this seeds a
  // thread deeper than the 50-message window.
  test.setTimeout(120000);

  const socket = await interceptSocket(page);
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  const convId = await page.evaluate(async () => {
    const { default: useChatStore } = await import('/src/stores/chatStore.js');
    return useChatStore.getState().activeConversationId;
  });
  expect(convId, 'no active conversation').toBeTruthy();

  // Deeper than the 50-message window, straight through the API — the point is
  // the window boundary, not the UI that produced the history.
  const post = (body) =>
    page.request.post(`${process.env.E2E_API_URL || 'http://127.0.0.1:8000'}/api/conversations/${convId}/messages`, {
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      data: body,
    });

  const oldest = await (await post({ content: `oldest ${suffix}`, type: 'text' })).json();
  for (let i = 0; i < 54; i += 1) {
    await post({ content: `filler ${i} ${suffix}`, type: 'text' });
  }
  // The newest message quotes the oldest, giving a one-click route to a target
  // that is now off the end of the loaded window.
  await post({ content: `quoting ${suffix}`, type: 'text', reply_to: oldest._id });

  // Reload to pick the seeded history up: the server publishes `new_message` to
  // everyone EXCEPT the sender, and alice is the sender, so her open window
  // would otherwise never learn about it.
  await page.reload();
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');
  await expect(page.getByTestId('reply-quote').last()).toBeVisible();

  socket.drop = true;
  const body = `in flight ${suffix}`;
  await sendText(page, body);
  await expect(page.locator('[data-testid="message-status"][data-status="sending"]')).toBeVisible();

  // Jump. This is the wholesale replace.
  await page.getByTestId('reply-quote').last().click();
  await expect(async () => {
    const anchored = await page.evaluate(async (id) => {
      const { default: useChatStore } = await import('/src/stores/chatStore.js');
      const msgs = useChatStore.getState().messages[useChatStore.getState().activeConversationId] || [];
      return msgs.some((m) => m._id === id);
    }, oldest._id);
    expect(anchored, 'the jump never refetched an around-window').toBe(true);
  }).toPass({ timeout: 15000 });

  // Asserted against the STORE rather than the viewport: after the jump the
  // window is centred on a message 55 rows back, so the carried-over bubble is
  // legitimately scrolled out of the virtualised list. Being in the store is
  // what "not deleted" means.
  const statuses = await page.evaluate(async (text) => {
    const { default: useChatStore } = await import('/src/stores/chatStore.js');
    const msgs = useChatStore.getState().messages[useChatStore.getState().activeConversationId] || [];
    return msgs.filter((m) => m.content === text).map((m) => m.status);
  }, body);
  expect(statuses, 'the jump deleted a message that was still in flight').toHaveLength(1);
  expect(['sending', 'failed']).toContain(statuses[0]);

  // ...and it still resolves, so it cannot hang on 'sending' for ever either.
  await expect(async () => {
    const after = await page.evaluate(async (text) => {
      const { default: useChatStore } = await import('/src/stores/chatStore.js');
      const msgs = useChatStore.getState().messages[useChatStore.getState().activeConversationId] || [];
      return msgs.filter((m) => m.content === text).map((m) => m.status);
    }, body);
    expect(after).toEqual(['failed']);
  }).toPass({ timeout: 30000 });
});
