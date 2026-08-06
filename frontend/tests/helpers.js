// Shared E2E helpers: seed users through the super-admin API, then drive the UI.
const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const SUPERADMIN_EMAIL = process.env.E2E_SUPERADMIN_EMAIL || 'admin@rhythmrx.ai';
const SUPERADMIN_PASSWORD = process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe-Dev-Password1';

const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };

async function apiLogin(request, email, password) {
  const resp = await request.post(`${API}/api/auth/login`, {
    headers: H,
    data: { email, password },
  });
  if (!resp.ok()) throw new Error(`login failed for ${email}: ${resp.status()}`);
  // return the cookie header for reuse
  const cookies = resp.headers()['set-cookie'] || '';
  return cookies;
}

/**
 * POST one fixture record and return it, or throw naming the endpoint and what
 * the API actually said.
 *
 * Every write here was previously unchecked. A 4xx or 5xx returns an error body
 * rather than a record, so `_id` came back undefined and the NEXT write was
 * built on it — a dead admin API produced an org with no id, a department under
 * `org_id: undefined`, and users under both, without one of them throwing. The
 * run then failed much later on `conversation-search never appeared`, which
 * reads as a broken frontend rather than a stack that never seeded. Same
 * reasoning as global-setup.js: fail where the failure is, and say what broke.
 *
 * `_id` is asserted as well as the status, because a 200 of an unexpected shape
 * fails in exactly the same silent way further down.
 */
async function seedPost(request, path, data) {
  const resp = await request.post(`${API}${path}`, { headers: H, data });
  if (!resp.ok()) {
    throw new Error(`fixture write failed: POST ${path} → ${resp.status()} ${await resp.text()}`);
  }
  const body = await resp.json();
  if (!body?._id) {
    throw new Error(`fixture write returned no _id: POST ${path} → ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Ensure a two-user org exists and return credentials. Uses the super-admin API
 * with absolute URLs (the API is on a different origin from the web app). The
 * `request` fixture already carries a cookie jar, so the superadmin session set
 * by login is reused for the subsequent admin calls.
 */
export async function seedOrgWithUsers(request, suffix, names = ['alice', 'bob']) {
  const login = await request.post(`${API}/api/auth/login`, {
    headers: H,
    data: { email: SUPERADMIN_EMAIL, password: SUPERADMIN_PASSWORD },
  });
  if (!login.ok()) {
    throw new Error(`superadmin login failed: ${login.status()} — set E2E_SUPERADMIN_PASSWORD`);
  }

  const org = await seedPost(request, '/api/admin/organizations', {
    name: `E2E Org ${suffix}`,
  });
  const dept = await seedPost(request, '/api/admin/departments', {
    org_id: org._id,
    name: 'E2E Dept',
  });

  const users = {};
  for (const name of names) {
    const email = `${name}.${suffix}@rxhive-e2e.com`;
    const password = 'E2ePassword123';
    const body = await seedPost(request, '/api/admin/users', {
      org_id: org._id,
      dept_id: dept._id,
      email,
      display_name: `${name[0].toUpperCase()}${name.slice(1)} E2E`,
      password,
      role: name === 'alice' ? 'admin' : 'member',
    });
    users[name] = { id: body._id, email, password, name: body.display_name };
  }
  return { org, dept, users };
}

export async function uiLogin(page, email, password) {
  await page.goto('/login');
  await page.getByTestId('login-email-input').fill(email);
  await page.getByTestId('login-password-input').fill(password);
  await page.getByTestId('login-submit-button').click();
}
