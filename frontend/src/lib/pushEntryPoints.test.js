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

/**
 * The other half of the lifecycle, added in Batch 39.
 *
 * These two are wiring assertions: the logic they guard is unit-tested in
 * pushRestore.test.js, but logic nothing calls is the failure this whole file
 * exists for — enablePushNotifications sat in the repo with zero call sites while
 * a toggle claimed to use it.
 */
describe('Web Push subscription state', () => {
  it('Settings derives the toggle from the subscription, not from the preference alone', () => {
    const source = readFileSync(join(SRC, 'pages/Settings.jsx'), 'utf8');

    assert.match(
      source,
      /import\s*\{[^}]*\bpushSubscriptionExists\b[^}]*\}\s*from\s*'\.\.\/lib\/pwa'/,
      'Settings does not ask whether a subscription exists, so its toggle can only ' +
        'be reporting the stored preference — which defaults to ON when unset.',
    );
    // Both facts have to reach the displayed value. The preference on its own is
    // the bug: unset reads as ON, so the switch sat on for users who had never
    // subscribed and for every user who had just signed in.
    assert.match(
      source,
      /const\s+desktopNotif\s*=[^;]*desktopNotifPref[^;]*pushSubscribed|const\s+desktopNotif\s*=[^;]*pushSubscribed[^;]*desktopNotifPref/,
      'the toggle value is not derived from both the preference and the subscription.',
    );
    // And the mount lookup must not land on top of a deliberate toggle. Its
    // `cancelled` flag only flips on unmount, so without a separate guard the late
    // answer — false, correctly, because nothing was subscribed at mount — beat
    // the optimistic true and left the switch off after a SUCCESSFUL subscribe.
    // Asserted as wiring because the behaviour needs a React harness this repo
    // does not have; the logic it guards is one boolean.
    assert.match(
      source,
      /!\s*notifTouched\.current/,
      'the mount lookup can overwrite a user action: it is not guarded against one.',
    );
    assert.match(
      source,
      /notifTouched\.current\s*=\s*true/,
      'nothing ever marks the toggle as touched, so the guard above can never fire.',
    );
  });

  it('the session restores a subscription the user asked for and lost', () => {
    // Nothing re-subscribed anywhere: two call sites, both a person clicking, no
    // pushsubscriptionchange handler in public/sw.js. Sign-out now revokes the
    // subscription by design, so without this the loss is permanent and silent.
    const source = readFileSync(join(SRC, 'components/shared/RealtimeSession.jsx'), 'utf8');

    assert.match(
      source,
      /import\s*\{[^}]*\bhealPushSubscription\b[^}]*\}\s*from\s*'\.\.\/\.\.\/lib\/pwa'/,
      'RealtimeSession does not import healPushSubscription.',
    );
    // Deliberately not anchored to the argument list: the call gained an
    // `isCancelled` option after review, and a guard that has to be edited
    // whenever the signature moves is a guard people stop trusting.
    assert.match(
      source,
      /healPushSubscription\(/,
      'healPushSubscription is imported but never called.',
    );
    // The cancellation itself, though, is load-bearing — without it a restore can
    // outlive the session that started it and re-subscribe the user who just
    // signed out.
    assert.match(
      source,
      /isCancelled\s*:/,
      'the restore is started without a cancellation hook, so a sign-out cannot stop it.',
    );
  });
});
