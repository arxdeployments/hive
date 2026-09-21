/**
 * The e2e suite has to be able to notice it stopped running.
 *
 * `test.only` is how a debugging session narrows to one test, and it is the
 * easiest thing in the world to leave behind. Playwright does not treat it as a
 * mistake: it runs the marked test, reports it passed, and exits 0. Measured on
 * this suite with one stray `.only`:
 *
 *     without forbidOnly    1 passed, exit 0     (64 tests never ran)
 *     with forbidOnly       Error: item focused with '.only' … exit 1
 *
 * The e2e job takes seven minutes of every CI run and is the only thing that
 * exercises calling, media and the realtime hub end to end. Losing it silently
 * is worse than not having it, because the green check still says it ran.
 *
 * `forbidOnly` is the fix and it lives in the config, so what is left to guard
 * is the config — a line nothing asserts is a line a refactor can drop.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const FRONTEND = join(import.meta.dirname, '..');
const CONFIG = join(FRONTEND, 'playwright.config.js');
const SPEC_DIR = join(FRONTEND, 'tests');

const config = () => readFileSync(CONFIG, 'utf8');

/**
 * Every spec Playwright would discover under `dir`, as paths relative to it.
 *
 * Recursive, because `testDir` is: Playwright walks subdirectories and a flat
 * readdir does not. A spec in tests/<anything>/ would be run by the e2e job and
 * skipped by the scan below, which is the one place a focused test could still
 * hide from this file.
 */
const specsIn = (dir) =>
  readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.spec.js'));

const specs = () => specsIn(SPEC_DIR);

describe('the e2e suite cannot be silently emptied', () => {
  it('has specs to protect', () => {
    // Every assertion below is vacuous against an empty directory.
    assert.ok(specs().length >= 10, `only found ${specs().length} spec files`);
  });

  it('forbids a focused test in CI', () => {
    assert.match(
      config(),
      /forbidOnly:\s*!!process\.env\.CI/,
      "playwright.config.js does not set forbidOnly from CI. Without it a stray " +
        'test.only reduces the run to that one test and still exits 0.',
    );
  });

  it('does not forbid one locally, which is what .only is for', () => {
    // The mirror of the rule above, so "fix" does not become "banned outright":
    // a developer narrowing to one test is the tool working as intended.
    assert.doesNotMatch(
      config(),
      /forbidOnly:\s*true\b/,
      'forbidOnly is unconditional, which breaks the local inner loop.',
    );
  });

  it('starts its own web server in CI rather than reusing a stranger', () => {
    assert.match(
      config(),
      /reuseExistingServer:\s*!process\.env\.CI/,
      'reuseExistingServer is not tied to CI. Reusing whatever answers on the ' +
        'port means the suite can pass against something other than the build.',
    );
  });


  it('looks inside subdirectories, the way Playwright does', () => {
    // Asserted against a temporary tree rather than the real one, which is flat
    // today — so this would pass either way and prove nothing about recursion.
    const root = mkdtempSync(join(tmpdir(), 'e2e-specs-'));
    mkdirSync(join(root, 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'top.spec.js'), '');
    writeFileSync(join(root, 'nested', 'mid.spec.js'), '');
    writeFileSync(join(root, 'nested', 'deeper', 'low.spec.js'), '');
    writeFileSync(join(root, 'nested', 'helper.js'), '');

    const found = specsIn(root).sort();
    assert.deepEqual(found, ['nested/deeper/low.spec.js', 'nested/mid.spec.js', 'top.spec.js']);
  });


  // A wait for message CONTENT has to be scoped to the thread. The sidebar
  // renders a `You: <text>` preview of the newest message and comes earlier in
  // the DOM, so `page.getByText(body)` matches THAT and is satisfied before the
  // thread has rendered anything. Measured, sending a message and waiting:
  //
  //     unscoped   first match in chat-sidebar,       0 message-menu-trigger mounted
  //     scoped     thread has rendered,               2 message-menu-trigger mounted
  //
  // accessibility.spec.js clicked a trigger straight after the unscoped wait and
  // was flaky in 5 of 7 CI runs. messaging.spec.js and render-check.spec.js
  // asserted a message had come back from history, which the sidebar preview
  // satisfies with an empty thread — the test passed without checking its point.
  //
  // A string literal is UI chrome ("Forward Message", "Call ended") and stays
  // page-wide; a variable is a message body somebody built for the test.
  const CONTENT_WAIT = /expect\(\s*page\.getByText\(\s*([^)]*)\)/g;

  /**
   * Whether this argument names UI chrome rather than a message body.
   *
   * A quoted string or a regex is chrome. A template literal is only chrome if
   * nothing is interpolated into it — `\`x ${id}\`` is runtime content built for
   * the test and has to be scoped like any other body, which a rule keyed on
   * the opening backtick alone would wave through.
   */
  const isChrome = (argument) =>
    /^['"]/.test(argument) ||
    argument.startsWith('/') ||
    (argument.startsWith('`') && !argument.includes('${'));

  /** The page-wide waits in `source` whose argument is a message body. */
  const unscopedContentWaits = (source) =>
    [...source.matchAll(CONTENT_WAIT)]
      .map((match) => match[1].trim())
      .filter((argument) => argument && !isChrome(argument));

  it('tells a message body from a piece of UI chrome', () => {
    // The whole rule rests on this distinction, and the real specs are clean —
    // so running it over them proves only that it found nothing. These are the
    // cases it has to get right, in both directions.
    assert.deepEqual(unscopedContentWaits("await expect(page.getByText(body)).toBeVisible();"), ['body']);
    assert.deepEqual(unscopedContentWaits("await expect(page.getByText(original).first()).toBeVisible();"), ['original']);
    // An interpolated template is content, not chrome — this case asserted the
    // opposite until review caught it.
    assert.deepEqual(
      unscopedContentWaits('await expect(page.getByText(`x ${id}`)).toBeVisible();'),
      ['`x ${id}`'],
    );
    // ...but a template with nothing in it is just a string.
    assert.deepEqual(unscopedContentWaits('await expect(page.getByText(`Forward`)).toBeVisible();'), []);
    assert.deepEqual(unscopedContentWaits("await expect(page.getByText('Forward Message')).toBeVisible();"), []);
    assert.deepEqual(unscopedContentWaits('await expect(page.getByText("Call ended")).toHaveCount(0);'), []);
    assert.deepEqual(unscopedContentWaits("await expect(page.getByText(/muted/i)).toBeVisible();"), []);
    // Already scoped, so not a page-wide wait at all.
    assert.deepEqual(unscopedContentWaits("await expect(thread(page).getByText(body)).toBeVisible();"), []);
  });

  for (const name of specs()) {
    it(`${name} scopes its message-content waits to the thread`, () => {
      const unscoped = unscopedContentWaits(readFileSync(join(SPEC_DIR, name), 'utf8'));
      assert.deepEqual(
        unscoped,
        [],
        `${name} waits page-wide for ${unscoped.join(', ')}. The sidebar preview ` +
          'satisfies that before the thread renders — use thread(page).getByText(…).',
      );
    });
  }

  for (const name of specs()) {
    it(`${name} leaves no focused test behind`, () => {
      // Belt and braces: forbidOnly already fails the CI run, but it fails it
      // in the seven-minute job. This fails in the unit tests, in seconds, with
      // the file name.
      const source = readFileSync(join(SPEC_DIR, name), 'utf8');
      // The modifiers chain: test.describe.serial.only() and
      // test.describe.parallel.only() are both real, and a rule that only knew
      // `test.only` and `describe.only` would wave them through.
      assert.doesNotMatch(
        source,
        /\b(?:test|describe)(?:\.\w+)*\.only\s*\(/,
        `${name} contains a focused test, which would reduce the whole e2e run to it.`,
      );
    });
  }
});
