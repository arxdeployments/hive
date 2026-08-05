import { expect, test } from '@playwright/test';
import { seedOrgWithUsers, uiLogin } from './helpers.js';

/**
 * The pre-send media editor: undo granularity and text-box interaction.
 *
 * This file exists because the editor had no coverage at all, and the first two bugs
 * users hit were both invisible to every other test:
 *
 *  1. **Undo wiped the drawing.** History was kept by calling `setHistory` from inside
 *     a `setEdit` updater. React may invoke an updater more than once — eagerly to
 *     test for a bail-out, and again whenever an update queue is re-processed — so one
 *     finished stroke could push several entries all holding the same early snapshot.
 *     Undo popped one of those and restored a state from before any stroke existed.
 *     Only a test that draws SEVERAL strokes and undoes ONE can see it: with a single
 *     stroke, "remove the last stroke" and "wipe everything" are the same picture.
 *  2. **Text boxes were inert unless the Text tool was selected**, so a caption could
 *     not be nudged or retyped without a trip to the tool picker, and a single tap
 *     went straight to the caret — which meant touching a box to move it opened the
 *     keyboard over the picture instead.
 *
 * The assertions are on the composited canvas the exporter draws, because that canvas
 * IS what gets uploaded — counting ink is the only way to tell "one stroke removed"
 * from "all strokes removed" without reaching into React internals.
 */

const suffix = `edit${process.pid}${Math.floor(Math.random() * 1000)}`;
let seeded;

test.beforeAll(async ({ request }) => {
  seeded = await seedOrgWithUsers(request, suffix);
});

/** A plain white PNG, big enough that strokes land well inside it. */
function whitePng(width = 480, height = 360) {
  const canvasScript = `
    const c = document.createElement('canvas');
    c.width = ${width}; c.height = ${height};
    const x = c.getContext('2d');
    x.fillStyle = '#ffffff'; x.fillRect(0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  `;
  return canvasScript;
}

async function openEditorWithImage(page) {
  // Build the file in the page and hand it to the hidden input, rather than shipping
  // a fixture: the bytes only have to be a decodable image.
  const dataUrl = await page.evaluate(new Function(whitePng()));
  const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
  await page.setInputFiles('input[type="file"][accept*="image"]', {
    name: 'canvas.png',
    mimeType: 'image/png',
    buffer,
  });
  await expect(page.getByTestId('staged-file-tile').first()).toBeVisible({ timeout: 15000 });
  await page.getByTestId('staged-file-edit').first().click();
  await expect(page.getByTestId('media-editor-undo')).toBeVisible({ timeout: 15000 });
  // The editor opens on Crop; the drawing tools live behind the pen.
  await page.getByTestId('media-editor-tool-draw').click();
  await expect(page.getByTestId('editor-draw-surface')).toBeVisible();
}

/**
 * How much non-white ink the composite canvas is carrying.
 *
 * Sampled on the visible `EditedCanvas`, which is painted by the same `drawEdit` the
 * exporter uses — so this measures what would actually be sent.
 */
async function inkPixels(page) {
  return page.evaluate(() => {
    const stage = document.querySelector('[data-testid="editor-annotate-stage"]');
    const canvas = stage?.querySelector('canvas');
    if (!canvas) return -1;
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    // The base image is pure white, so anything appreciably darker is ink.
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) n += 1;
    }
    return n;
  });
}

/**
 * A bounding box that has stopped moving.
 *
 * Switching tools changes the toolbar's height, the stage is re-fitted to whatever space
 * is left (`useFittedBox`), and every overlay is re-laid out in the new display scale —
 * a text box measured 477px wide under the Text tool settles at 555px under the pen.
 * Reading `boundingBox()` straight after the click therefore captures a geometry that
 * exists for one frame, and comparing a later reading against it fails by the difference
 * between the two layouts rather than by anything the editor did wrong. Two consecutive
 * agreeing reads is enough: the re-fit is a single layout pass, not an animation.
 */
async function stableBox(locator) {
  let previous = null;
  for (let i = 0; i < 40; i += 1) {
    const current = await locator.boundingBox();
    if (
      previous && current
      && Math.abs(previous.x - current.x) < 0.5 && Math.abs(previous.y - current.y) < 0.5
      && Math.abs(previous.width - current.width) < 0.5
      && Math.abs(previous.height - current.height) < 0.5
    ) {
      return current;
    }
    previous = current;
    await locator.page().waitForTimeout(50);
  }
  throw new Error('the element never stopped moving');
}

/** Draw one horizontal stroke at `yFraction` down the drawing surface. */
async function drawStroke(page, yFraction) {
  const surface = page.getByTestId('editor-draw-surface');
  const b = await surface.boundingBox();
  const y = b.y + b.height * yFraction;
  await page.mouse.move(b.x + b.width * 0.15, y);
  await page.mouse.down();
  for (let i = 2; i <= 10; i += 1) {
    await page.mouse.move(b.x + b.width * (0.15 + (0.7 * i) / 10), y);
  }
  await page.mouse.up();
}

test('undo removes one stroke at a time and keeps the earlier ones', async ({ page }) => {
  test.setTimeout(120000);
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await page.getByTestId('new-chat-button').click();
  await page.getByTestId('contact-item').filter({ hasText: 'Bob E2E' }).first().click();
  await expect(page.getByTestId('message-input')).toBeVisible();

  await openEditorWithImage(page);

  const blank = await inkPixels(page);
  expect(blank, 'the stage canvas was not readable').toBeGreaterThanOrEqual(0);

  // Three separated strokes, measuring after each so the growth is monotonic.
  const after = [];
  for (const yFraction of [0.3, 0.5, 0.7]) {
    await drawStroke(page, yFraction);
    await expect.poll(() => inkPixels(page), { timeout: 5000 }).toBeGreaterThan(
      after.length ? after[after.length - 1] : blank
    );
    after.push(await inkPixels(page));
  }

  // Undo once: back to two strokes' worth of ink — NOT back to blank. This is the
  // whole regression; before the fix this assertion landed on `blank`.
  await page.getByTestId('media-editor-undo').click();
  await expect.poll(() => inkPixels(page), { timeout: 5000 }).toBeLessThan(after[2]);
  const oneBack = await inkPixels(page);
  expect(oneBack, 'undo wiped the drawing instead of removing the last stroke')
    .toBeGreaterThan(blank + (after[0] - blank) / 2);
  expect(Math.abs(oneBack - after[1]), 'undo did not land exactly on the two-stroke state')
    .toBeLessThan(Math.max(40, after[1] * 0.05));

  // And again: one stroke's worth.
  await page.getByTestId('media-editor-undo').click();
  await expect.poll(() => inkPixels(page), { timeout: 5000 }).toBeLessThan(oneBack);
  const twoBack = await inkPixels(page);
  expect(Math.abs(twoBack - after[0])).toBeLessThan(Math.max(40, after[0] * 0.05));

  // Third undo empties it, and then Undo must go inert rather than doing something
  // arbitrary.
  await page.getByTestId('media-editor-undo').click();
  await expect.poll(() => inkPixels(page), { timeout: 5000 }).toBeLessThanOrEqual(blank + 40);
  await expect(page.getByTestId('media-editor-undo')).toBeDisabled();
});

test('a text box is movable and editable with the pen selected, not only the text tool', async ({
  page,
}) => {
  test.setTimeout(120000);
  await uiLogin(page, seeded.users.alice.email, seeded.users.alice.password);
  await expect(page.getByTestId('conversation-search')).toBeVisible();
  await page.getByTestId('new-chat-button').click();
  await page.getByTestId('contact-item').filter({ hasText: 'Bob E2E' }).first().click();
  await expect(page.getByTestId('message-input')).toBeVisible();

  await openEditorWithImage(page);

  // Add a caption from the Text tool, type into it, then leave the caret.
  await page.getByTestId('media-editor-tool-text').click();
  await page.getByTestId('editor-add-text').click();
  const input = page.getByTestId('editor-text-input');
  await expect(input).toBeVisible();
  await input.fill('hello');
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);

  const box = page.getByTestId('editor-text-box').first();
  await expect(box).toBeVisible();

  // ── With the PEN selected, the box must still be grabbable ────────────────
  await page.getByTestId('media-editor-tool-draw').click();
  const before = await stableBox(box);

  // A single tap selects and must NOT open the caret, even though this box is still
  // selected from being created — touching a box to move it used to raise the keyboard
  // over the picture, and "already selected" is not a signal the user chose.
  await page.mouse.click(before.x + before.width / 2, before.y + before.height / 2);
  await expect(page.getByTestId('editor-text-input')).toHaveCount(0);
  await expect(page.getByTestId('editor-text-resize')).toBeVisible();

  // Now drag it, with the pen still active.
  const from = await stableBox(box);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 60, from.y + from.height / 2 + 40, { steps: 8 });
  await page.mouse.up();

  const moved = await stableBox(box);
  expect(Math.abs(moved.x - before.x), 'the box did not move with the pen selected')
    .toBeGreaterThan(20);

  // A deliberate double-tap opens the caret — still on the pen, no tool switch.
  const at = await stableBox(box);
  await page.mouse.dblclick(at.x + at.width / 2, at.y + at.height / 2);
  await expect(page.getByTestId('editor-text-input')).toBeVisible();
  // Formatting survived the move and the mode changes.
  await expect(page.getByTestId('editor-text-input')).toHaveValue('hello');

  // Undo returns it to where it was before the drag — one step, not a wipe.
  await page.keyboard.press('Escape');
  await page.getByTestId('media-editor-undo').click();
  await expect(page.getByTestId('editor-text-box').first()).toBeVisible();
  const undone = await stableBox(page.getByTestId('editor-text-box').first());
  expect(Math.abs(undone.x - before.x), 'undo did not restore the pre-drag position')
    .toBeLessThan(12);
});
