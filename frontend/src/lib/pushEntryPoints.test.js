import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * A static guard, in the spirit of scripts/check_contracts.py: it asserts a
 * property of the source tree that lints, builds and renders perfectly well
 * while being wrong.
 *
 * Asking the browser for notification permission is NOT subscribing to Web Push.
 * Permission alone creates no PushSubscription row, so services/push.py has
 * nothing to deliver to and its fan-out short-circuits on an empty set. A surface
 * that requests permission and stops there therefore reports success, dismisses
 * its own prompt, and delivers nothing — and nothing fails until someone notices
 * they are not being notified.
 *
 * That has now happened twice on the same pair of surfaces. Settings.jsx was
 * moved onto enablePushNotifications() for exactly this reason; the banner in
 * Chat.jsx was left on the old permission-only path and stayed inert, including
 * for the incoming-call ring that services/calls.py:_dispatch_call_push describes
 * as the only channel reaching a callee whose socket is gone.
 *
 * Asserted positively, on the two surfaces that offer to turn notifications on.
 * A scan for the wrong call instead of the right one was tried first and thrown
 * away: both files legitimately DISCUSS requestPermission in prose, so it flagged
 * comments, and a test that fails when someone edits a comment is worse than no
 * test.
 */

const SRC = join(import.meta.dirname, '..');

/** Every UI that offers to turn notifications on, and must therefore subscribe. */
const ENABLE_SURFACES = ['pages/Settings.jsx', 'pages/Chat.jsx'];

describe('Web Push entry points', () => {
  for (const surface of ENABLE_SURFACES) {
    it(`${surface} enables push through lib/pwa, not permission alone`, () => {
      const source = readFileSync(join(SRC, surface), 'utf8');

      assert.match(
        source,
        /import\s*\{[^}]*\benablePushNotifications\b[^}]*\}\s*from\s*'\.\.\/lib\/pwa'/,
        `${surface} offers to enable notifications without importing ` +
          'enablePushNotifications: requesting the OS permission on its own ' +
          'creates no subscription, so this surface would report success and ' +
          'deliver nothing.',
      );
      assert.match(
        source,
        /await\s+enablePushNotifications\(\)/,
        `${surface} imports enablePushNotifications but never awaits it.`,
      );
    });
  }
});
