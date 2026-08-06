import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The other half of the retry story, from the client's side.
 *
 * `send_message` commits BEFORE the sender is told anything, so a lost ack, a
 * request timeout or a 502 in front of the app all leave the client holding a
 * message it cannot classify. The ack deadline calls that failed and offers a
 * retry — correctly, because the alternative is deleting a message that may
 * never have been sent — but the retry used to mint a fresh temp id, so the one
 * case where the message HAD been stored is the case that stored it twice.
 *
 * Two behaviours make that safe, and both are asserted here rather than assumed:
 * the retry sends the ORIGINAL key back, so the server answers with the row it
 * already has instead of inserting a second one; and a refetch drops a failed
 * bubble whose `client_msg_id` is present in the fetched history, so the user is
 * not shown their delivered message twice with an invitation to send it again.
 *
 * The uncertain send is produced honestly. `routeWebSocket` forwards the chat
 * frame to the real server — so the message really is stored — and swallows only
 * the `message_ack` coming back, which is exactly what a connection that dies
 * mid-round-trip does. Nothing here fakes the backend.
 */

const suffix = `${process.pid}${Math.floor(Math.random() * 1000)}`;
const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix, ['alice', 'bob']);
});

/**
 * Proxy the app's socket. `swallowAcks` drops server→client `message_ack`
 * frames while leaving everything else — including the client's own send —
 * flowing normally.
 */
async function interceptSocket(page) {
  const state = { swallowAcks: false, sockets: [] };
  await page.routeWebSocket('**/api/ws', (ws) => {
    const server = ws.connectToServer();
    state.sockets.push(ws);
    ws.onMessage((m) => server.send(m));
    server.onMessage((m) => {
      // Parsed rather than substring-matched: the client stringifies compactly
      // but the server is Python `json.dumps`, which writes `"type": "..."` with
      // a space, so a literal match silently never fires.
      if (state.swallowAcks && typeof m === 'string') {
        let type = null;
        try {
          type = JSON.parse(m)?.type;
        } catch {
          /* not our JSON — pass it through */
        }
        if (type === 'message_ack') return;
      }
      ws.send(m);
    });
  });
  return {
    set swallowAcks(v) { state.swallowAcks = v; },
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

/** How many messages with this exact content the SERVER actually holds. */
async function serverCopies(page, body) {
  const convId = await page.evaluate(async () => {
    const { default: useChatStore } = await import('/src/stores/chatStore.js');
    return useChatStore.getState().activeConversationId;
  });
  const resp = await page.request.get(`${API}/api/conversations/${convId}/messages?limit=100`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  expect(resp.ok(), `history fetch failed: ${resp.status()}`).toBe(true);
  const { messages } = await resp.json();
  return messages.filter((m) => m.content === body).length;
}

test('a retry after an uncertain send does not deliver the message twice', async ({ page }) => {
  // 15s of ack deadline, on top of seeding and login.
  test.setTimeout(120000);

  const socket = await interceptSocket(page);
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  // The send reaches the server and is stored; only the answer is lost. The
  // socket stays up, so nothing refetches and the bubble is left to the deadline.
  socket.swallowAcks = true;
  const body = `uncertain ${suffix}`;
  await page.getByTestId('message-input').fill(body);
  await page.getByTestId('message-send-btn').click();

  await expect(
    page.getByTestId('message-retry'),
    'the unacknowledged send never resolved to a retryable state'
  ).toBeVisible({ timeout: 25000 });

  // It really was stored — otherwise this test would prove nothing about
  // duplication, only about retrying a message that never existed.
  expect(await serverCopies(page, body), 'the send never reached the server').toBe(1);

  // Retry, this time letting the answer through.
  socket.swallowAcks = false;
  await page.getByTestId('message-retry').click();
  await expect(page.locator('[data-testid="message-status"][data-status="sent"]').first())
    .toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('message-retry')).toHaveCount(0);

  // The whole point.
  expect(
    await serverCopies(page, body),
    'the retry stored a second copy of a message the server already had'
  ).toBe(1);
});

test('a failed bubble whose message actually landed is not shown beside it', async ({ page }) => {
  test.setTimeout(120000);

  const socket = await interceptSocket(page);
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await openConversationWith(page, 'Bob E2E');

  socket.swallowAcks = true;
  const body = `landed anyway ${suffix}`;
  await page.getByTestId('message-input').fill(body);
  await page.getByTestId('message-send-btn').click();
  await expect(page.locator('[data-testid="message-status"][data-status="sending"]').first())
    .toBeVisible();

  // Losing the socket resolves the pending send immediately, then reconnecting
  // force-refetches — which is where the fetched history and the local bubble
  // meet. Acks flow again from here so the reconnect is clean.
  socket.swallowAcks = false;
  socket.kill();

  // One copy on the server, and exactly one row in the client's thread: the
  // stored message, not the stored message plus a failed bubble for it.
  await expect(async () => {
    const rows = await page.evaluate(async (text) => {
      const { default: useChatStore } = await import('/src/stores/chatStore.js');
      const s = useChatStore.getState();
      return (s.messages[s.activeConversationId] || [])
        .filter((m) => m.content === text)
        .map((m) => m.status || 'stored');
    }, body);
    expect(rows).toHaveLength(1);
  }).toPass({ timeout: 30000 });

  expect(await serverCopies(page, body)).toBe(1);
  await expect(
    page.getByTestId('message-retry'),
    'a delivered message was still offering a retry that would duplicate it'
  ).toHaveCount(0);
});
