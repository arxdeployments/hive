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
