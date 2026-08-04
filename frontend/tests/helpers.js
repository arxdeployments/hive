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

  const org = await (
    await request.post(`${API}/api/admin/organizations`, {
      headers: H,
      data: { name: `E2E Org ${suffix}` },
    })
  ).json();
  const dept = await (
    await request.post(`${API}/api/admin/departments`, {
      headers: H,
      data: { org_id: org._id, name: 'E2E Dept' },
    })
  ).json();

  const users = {};
  for (const name of names) {
    const email = `${name}.${suffix}@rxhive-e2e.com`;
    const password = 'E2ePassword123';
    const resp = await request.post(`${API}/api/admin/users`, {
      headers: H,
      data: {
        org_id: org._id,
        dept_id: dept._id,
        email,
        display_name: `${name[0].toUpperCase()}${name.slice(1)} E2E`,
        password,
        role: name === 'alice' ? 'admin' : 'member',
      },
    });
    const body = await resp.json();
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
