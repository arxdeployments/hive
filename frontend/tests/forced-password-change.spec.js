import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The forced password change, batch 73, end to end.
 *
 * Every admin password reset set users.must_change_password, a successful change
 * cleared it, and nothing read it in between. The admin is SHOWN the temporary
 * password, so the account stayed fully usable on a password somebody else
 * knows. The API now refuses such an account everywhere except the few routes
 * needed to get out of it (403 PASSWORD_CHANGE_REQUIRED), and the web client
 * holds the session on one screen until the password is replaced.
 *
 * What this proves that the unit and wiring tests cannot: that the refusal is
 * real at the API, that the screen is the ONLY thing running — no conversation
 * list, no active-call lookup, no socket — and that a valid change actually lets
 * the user in and keeps them in across a reload, which is the half that breaks
 * if the server's flag and the client's disagree.
 *
 * Everything is seeded and reset INSIDE the test, under a suffix that includes
 * the retry number, so a CI retry starts from an account that has never been
 * reset rather than one the first attempt already changed.
 */

const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

/** The routes the forced state must never reach: the chat, calls, the socket. */
const GATED = /^\/api\/(conversations|calls|ws)(\/|$)/;

test('an admin reset holds the account on the change-password screen until it picks a new one', async (
  { page, request, playwright },
  testInfo,
) => {
  const suffix = `forcedpw${process.pid}${Math.floor(Math.random() * 1e6)}r${testInfo.retry}`;
  // Leaves the superadmin session on `request`, which the reset below uses.
  const { users } = await seedOrgWithUsers(request, suffix, ['bob']);
  const bob = users.bob;
  const fresh = `Fresh${suffix}Pass9`;

  const reset = await request.post(`${API}/api/admin/users/${bob.id}/reset-password`, { headers: H });
  expect(reset.status(), await reset.text()).toBe(200);
  const { temporary_password: temporary } = await reset.json();
  expect(typeof temporary).toBe('string');

  // --- the API refuses the account, and says why ---------------------------
  // A separate cookie jar, so this session is not the browser's.
  const before = await playwright.request.newContext();
  try {
    const login = await before.post(`${API}/api/auth/login`, {
      headers: H,
      data: { email: bob.email, password: temporary },
    });
    expect(login.status()).toBe(200);
    // Inside "user", never top level — the wire contract every client builds on.
    expect((await login.json()).user.must_change_password).toBe(true);

    const refused = await before.get(`${API}/api/conversations`, { headers: H });
    expect(refused.status()).toBe(403);
    expect((await refused.json()).code).toBe('PASSWORD_CHANGE_REQUIRED');

    // /me stays open: it is how the client learns the flag and proves its session.
    const me = await before.get(`${API}/api/auth/me`, { headers: H });
    expect(me.status()).toBe(200);
    expect((await me.json()).must_change_password).toBe(true);
  } finally {
    await before.dispose();
  }

  // --- the browser: only the forced screen runs ----------------------------
  const seen = [];
  page.on('request', (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
  page.on('websocket', (ws) => seen.push(`WS ${new URL(ws.url()).pathname}`));

  await uiLogin(page, bob.email, temporary);
  await expect(page.getByTestId('forced-password-screen')).toBeVisible();
  await expect(page.getByTestId('conversation-search')).toHaveCount(0);

  // A wrong temporary password is named as such and keeps the user here.
  await page.getByTestId('forced-current-password').fill(`Wrong${suffix}Temp1`);
  await page.getByTestId('forced-new-password').fill(fresh);
  await page.getByTestId('forced-confirm-password').fill(fresh);
  await page.getByTestId('forced-password-submit').click();
  await expect(page.getByTestId('forced-password-error')).toHaveText('That temporary password is not right.');
  await expect(page.getByTestId('forced-password-screen')).toBeVisible();
  await expect(page.getByTestId('conversation-search')).toHaveCount(0);

  // The submit proved the session with /me before posting the change: posting
  // straight away would report a lapsed access cookie as a wrong password.
  const loginAt = seen.lastIndexOf('POST /api/auth/login');
  const changeAt = seen.indexOf('POST /api/auth/change-password', loginAt);
  expect(loginAt).toBeGreaterThan(-1);
  expect(changeAt).toBeGreaterThan(loginAt);
  expect(seen.slice(loginAt, changeAt)).toContain('GET /api/auth/me');

  // Nothing behind the gate has run: no conversation list, no active-call
  // lookup, no socket.
  const gatedWhileForced = seen.filter((entry) => GATED.test(entry.split(' ')[1]));
  expect(gatedWhileForced).toEqual([]);

  // --- a valid change lets the user in, and keeps them in ------------------
  await page.getByTestId('forced-current-password').fill(temporary);
  await page.getByTestId('forced-new-password').fill(fresh);
  await page.getByTestId('forced-confirm-password').fill(fresh);
  await page.getByTestId('forced-password-submit').click();
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await expect(page.getByTestId('forced-password-screen')).toHaveCount(0);

  await page.reload();
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await expect(page.getByTestId('forced-password-screen')).toHaveCount(0);

  // --- and the API agrees ---------------------------------------------------
  const after = await playwright.request.newContext();
  try {
    const stale = await after.post(`${API}/api/auth/login`, {
      headers: H,
      data: { email: bob.email, password: temporary },
    });
    expect(stale.status()).toBe(401);

    const login = await after.post(`${API}/api/auth/login`, {
      headers: H,
      data: { email: bob.email, password: fresh },
    });
    expect(login.status()).toBe(200);
    expect((await login.json()).user.must_change_password).toBe(false);

    const allowed = await after.get(`${API}/api/conversations`, { headers: H });
    expect(allowed.status()).toBe(200);
  } finally {
    await after.dispose();
  }
});
