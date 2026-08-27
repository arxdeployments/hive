/**
 * Web Push teardown, shared by every sign-out path.
 *
 * Imports nothing outside this directory, and nothing that reaches api/client.js
 * — that module reads `import.meta.env` at module scope, which is a Vite
 * construct, so importing the axios instance from here would make this file
 * unloadable under `npm run test:unit` (Node's own runner, no bundler). The
 * client and the browser globals are passed in instead, which is also what lets
 * the unit tests drive the failure paths.
 *
 * The `.js` on the import below is required, not stylistic: Vite resolves
 * extensionless specifiers, Node's ESM loader does not, so dropping it fails the
 * unit suite with ERR_MODULE_NOT_FOUND while `vite build` stays perfectly green.
 */

import { withTimeout } from './withTimeout.js';

/**
 * The localStorage keys that record THIS user's notification choices.
 *
 * Not device preferences like the font size or the media-quality tier: these
 * three say whether this person wanted notifications and whether they have
 * already been asked, so leaving them behind hands the next person on a shared
 * workstation the previous one's answers. `rxhive_desktop_notif` is the one that
 * matters most — Settings reads it back as the state of the toggle that
 * subscribes to push, so a stale `true` describes a subscription this teardown
 * has just removed.
 */
export const SESSION_NOTIFICATION_KEYS = [
  'rxhive_desktop_notif',
  'rxhive_notif_sound',
  'rxhive_notif_asked',
];

/**
 * Wall-clock budget for the WHOLE teardown, not per step.
 *
 * Each await below is bounded, and they share this one deadline rather than
 * getting 3s each: four sequential steps with their own budget is a twelve-second
 * sign-out in the worst case, which is a hang as far as the person clicking is
 * concerned.
 */
export const TEARDOWN_TIMEOUT_MS = 3000;

/** Drop the departing user's notification preferences. Never throws. */
export function clearNotificationPrefs(storage) {
  if (!storage) return;
  for (const key of SESSION_NOTIFICATION_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      // Private mode, or storage blocked by policy. Nothing to clean up then.
    }
  }
}

/**
 * Put this device's Web Push subscription down, and forget the departing user's
 * notification preferences.
 *
 * Best-effort and it never throws: a sign-out has to complete even when none of
 * this works. Pass `api` only when the session cookies are still valid — on the
 * expired-session paths a DELETE would 401 and re-enter the refresh interceptor
 * for a session that is already over.
 *
 * `hadSubscription` is reported separately from `unsubscribed` so a caller can
 * tell "there was nothing to do" from "there was, and it failed". The sign-out
 * paths do not care; the Settings toggle does, because those two have to move the
 * switch in opposite directions.
 *
 * @returns {Promise<{hadSubscription: boolean, serverCleared: boolean, unsubscribed: boolean}>}
 */
export async function tearDownPush({
  nav,
  api,
  storage,
  timeoutMs = TEARDOWN_TIMEOUT_MS,
} = {}) {
  clearNotificationPrefs(storage);
  const result = { hadSubscription: false, serverCleared: false, unsubscribed: false };
  if (!nav || !('serviceWorker' in nav)) return result;

  // One deadline for everything that follows. Each step gets what is left of it.
  const expiry = Date.now() + timeoutMs;
  const remaining = () => Math.max(0, expiry - Date.now());

  try {
    const reg = await withTimeout(nav.serviceWorker.ready, remaining());
    const sub = reg?.pushManager
      ? await withTimeout(reg.pushManager.getSubscription(), remaining())
      : null;
    if (!sub?.endpoint) return result;
    result.hadSubscription = true;
    // The server row goes first, and only then the browser subscription: DELETE
    // /api/notifications/subscribe authenticates as the caller, so it has to
    // happen before the logout POST clears the cookies. A row left behind keeps
    // the fan-out in services/push.py selecting this endpoint for the user who
    // has just left.
    if (api) {
      try {
        // Bounded, and the .then(true) is what distinguishes a completed DELETE
        // from a timed-out one: withTimeout resolves undefined when it gives up,
        // which must not be recorded as the row having been cleared.
        const cleared = await withTimeout(
          api
            .delete('/api/notifications/subscribe', { data: { endpoint: sub.endpoint } })
            .then(() => true),
          remaining(),
        );
        result.serverCleared = cleared === true;
      } catch {
        // Expired session, offline, or the API is down. The unsubscribe below
        // still stops delivery to this browser, which is the part that matters.
      }
    }
    // The half that actually stops delivery here, and the reason a failed or
    // abandoned server call is survivable: once the endpoint is gone the push
    // service answers 404/410 and services/push.py prunes the row on the next
    // send. Given its own remaining budget rather than being skipped when the
    // DELETE used all of it — this is the step worth spending the last of the
    // deadline on.
    result.unsubscribed = (await withTimeout(sub.unsubscribe(), Math.max(remaining(), 250))) === true;
  } catch {
    // Best-effort by contract. Whatever happened, the sign-out proceeds.
  }
  return result;
}
