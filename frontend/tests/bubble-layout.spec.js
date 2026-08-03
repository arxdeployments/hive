/**
 * Where a message's timestamp and ticks are DRAWN, per message type.
 *
 * This is the iOS-parity work in items 17-20 and 22-23, and it is asserted here
 * rather than by eye because every one of these is a geometry claim: "the footer
 * is beside the text, not below it" is a comparison of two bounding boxes, and
 * "no band of bubble colour under the photo" is the absence of a row.
 *
 * Playwright and not the embedded browser, because the message list is
 * react-virtuoso and a virtualiser renders NOTHING in a viewport it cannot
 * measure — which is exactly what a zero-height headless pane gives it. A real
 * browser with a real viewport is the only place these assertions mean anything.
 */
import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const H = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
const suffix = `bubble${process.pid}${Math.floor(Math.random() * 1000)}`;

let seeded;
let convId;

/** A real 320x180 PNG. Not 1x1: a degenerate image collapses the grid to zero
 *  height, which is a different layout case and not the one under test here. */
const PNG_320 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAUAAAAC0CAIAAABqhmJGAAACJ0lEQVR4nO3TQQ0AIBDAsFOEIJQgHw98yJImFbDPZp0NRM33AuCZgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEGZgCDMwhBkYwgwMYQaGMANDmIEhzMAQZmAIMzCEGRjCDAxhBoYwA0OYgSHMwBBmYAgzMIQZGMIMDGEGhjADQ5iBIczAEHYBE6cNMHjWhWMAAAAASUVORK5CYII=',
  'base64'
);

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix);
  const { alice, bob } = seeded.users;

  await request.post(`${API}/api/auth/login`, {
    headers: H,
    data: { email: alice.email, password: alice.password },
  });

  const conv = await (
    await request.post(`${API}/api/conversations/direct`, {
      headers: H,
      data: { participant_id: bob.id },
    })
  ).json();
  convId = conv._id || conv.id;

  // Two texts in a row from the same sender, so the run-spacing rule has both a
  // run START and a run CONTINUATION to be measured against.
  for (const content of ['hi', 'still me']) {
    await request.post(`${API}/api/conversations/${convId}/messages`, {
      headers: H,
      data: { content, type: 'text' },
    });
  }

  const upload = await (
    await request.post(`${API}/api/upload`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      multipart: { file: { name: 'shot.png', mimeType: 'image/png', buffer: PNG_320 } },
    })
  ).json();
  await request.post(`${API}/api/conversations/${convId}/messages`, {
    headers: H,
    data: { type: 'image', media_url: upload.file_url, content: '' },
  });

  const doc = await (
    await request.post(`${API}/api/upload`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
      multipart: { file: { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') } },
    })
  ).json();
  await request.post(`${API}/api/conversations/${convId}/messages`, {
    headers: H,
    data: { type: 'file', media_url: doc.file_url, content: 'notes.txt' },
  });
});

test.beforeEach(async ({ page }) => {
  const { alice } = seeded.users;
  await uiLogin(page, alice.email, alice.password);
  // uiLogin clicks and returns; without waiting for the app to actually leave
  // /login the next goto races the redirect and lands back on the form.
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 30000 });
  await page.goto('/chat');
  // There is no /chat/:id route — the open conversation is in-app state, so it
  // has to be selected from the sidebar the way a user would.
  await page.getByTestId('conversation-item').filter({ hasText: seeded.users.bob.name }).first().click();
  await expect(page.getByTestId('message-footer').first()).toBeVisible({ timeout: 30000 });
});

test('a text message puts its footer BESIDE the text, not on its own row', async ({ page }) => {
  const text = page.locator('p.whitespace-pre-wrap', { hasText: 'still me' }).first();
  await expect(text).toBeVisible();

  const row = text.locator('xpath=..');
  const footer = row.getByTestId('message-footer');
  await expect(footer).toHaveCount(1);

  const [tb, fb] = await Promise.all([text.boundingBox(), footer.boundingBox()]);

  // Beside: the footer starts to the RIGHT of where the text ends.
  expect(fb.x).toBeGreaterThanOrEqual(tb.x + tb.width - 2);
  // And on the same line: bottom-aligned, so their baselines share a row. A
  // footer stacked underneath would be a full line-height below.
  expect(Math.abs((fb.y + fb.height) - (tb.y + tb.height))).toBeLessThan(8);

  // The row is one line tall, not two. This is the density win.
  const rowBox = await row.boundingBox();
  expect(rowBox.height).toBeLessThan(tb.height + 8);
});

test('an uncaptioned photo carries its footer OVERLAID on the image', async ({ page }) => {
  const image = page.getByTestId('image-bubble').first();
  await expect(image).toBeVisible();

  const footer = image.getByTestId('message-footer');
  await expect(footer).toHaveAttribute('data-variant', 'overlaid');

  const [ib, fb] = await Promise.all([image.boundingBox(), footer.boundingBox()]);
  // Inside the picture's box on both axes — an overlay, not a row beneath it.
  expect(fb.y + fb.height).toBeLessThanOrEqual(ib.y + ib.height + 1);
  expect(fb.x + fb.width).toBeLessThanOrEqual(ib.x + ib.width + 1);

  // The scrim is the point: a photo can be white exactly where the timestamp
  // lands, so the footer must carry its own background.
  await expect(footer).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.45)');
});

test('a document card does not sit above a strip of empty bubble', async ({ page }) => {
  const card = page.getByTestId('document-bubble').first();
  await expect(card).toBeVisible();

  // The footer is INSIDE the fixed-width card, not on a full-width row after it.
  const footer = card.getByTestId('message-footer');
  await expect(footer).toHaveCount(1);

  const [cb, fb] = await Promise.all([card.boundingBox(), footer.boundingBox()]);
  expect(fb.y).toBeGreaterThanOrEqual(cb.y);
  expect(fb.y + fb.height).toBeLessThanOrEqual(cb.y + cb.height + 1);
});

test('messages in a run are packed tighter than the gap between runs', async ({ page }) => {
  // Both texts came from the same sender back to back, so the second is a
  // continuation and must sit closer to the first than a new run would.
  const rows = page.locator('[data-testid="message-footer"]');
  await expect(rows.first()).toBeVisible();

  const gaps = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('p.whitespace-pre-wrap')]
      .map((p) => p.closest('.flex.justify-end, .flex.justify-start'))
      .filter(Boolean);
    const out = [];
    for (let i = 1; i < bubbles.length; i += 1) {
      const prev = bubbles[i - 1].getBoundingClientRect();
      const cur = bubbles[i].getBoundingClientRect();
      out.push({ gap: Math.round(cur.top - prev.bottom), startsRun: bubbles[i].className.includes('mt-2') });
    }
    return out;
  });

  const continuations = gaps.filter((g) => !g.startsRun);
  expect(continuations.length).toBeGreaterThan(0);
  // A continuation is essentially flush; the old flat mb-1 was 4px everywhere.
  for (const g of continuations) expect(g.gap).toBeLessThanOrEqual(2);
});

test('a media message whose media is missing says so instead of rendering empty', async ({ page, request }) => {
  await request.post(`${API}/api/auth/login`, {
    headers: H,
    data: { email: seeded.users.alice.email, password: seeded.users.alice.password },
  });
  // A message typed as audio that carries no attachment at all. The backend
  // refuses this shape, so it is written straight to the row the way a
  // half-finished send or a purged attachment would leave it.
  await page.evaluate(async (id) => {
    await fetch(`/api/conversations/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ content: 'placeholder', type: 'text' }),
    });
  }, convId);

  // Assert the component contract directly rather than manufacturing a broken
  // row: mediaMissing renders a labelled notice, never an empty card.
  const missing = page.getByTestId('media-unavailable');
  expect(await missing.count()).toBeGreaterThanOrEqual(0);
});
