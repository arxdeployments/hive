/**
 * Web Push teardown, shared by every sign-out path.
 *
 * Deliberately imports nothing. api/client.js reads `import.meta.env` at module
 * scope, which is a Vite construct, so importing the axios instance from here
 * would make this file unloadable under `npm run test:unit` — Node's own runner,
 * no bundler. The client and the browser globals are passed in instead, which is
 * also what lets the unit tests drive the failure paths.
 */

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

/** Bound on each await below. See withTimeout. */
export const SW_READY_TIMEOUT_MS = 3000;

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
 * `navigator.serviceWorker.ready` never resolves when no worker is registered —
 * it is not a rejected promise, it is a permanently pending one. Awaited
 * unguarded on a sign-out path that is a sign-out button which hangs forever,
 * and failed SW registration is not exotic: a corporate proxy serving the wrong
 * content type for /sw.js, or storage blocked by policy, both do it, and
 * registerServiceWorker() only console.warns when they do.
 */
async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
 * @returns {Promise<{serverCleared: boolean, unsubscribed: boolean}>}
 */
export async function tearDownPush({
  nav,
  api,
  storage,
  readyTimeoutMs = SW_READY_TIMEOUT_MS,
} = {}) {
  clearNotificationPrefs(storage);
  const result = { serverCleared: false, unsubscribed: false };
  if (!nav || !('serviceWorker' in nav)) return result;
  try {
    const reg = await withTimeout(nav.serviceWorker.ready, readyTimeoutMs);
    const sub = reg?.pushManager
      ? await withTimeout(reg.pushManager.getSubscription(), readyTimeoutMs)
      : null;
    if (!sub?.endpoint) return result;
    // The server row goes first, and only then the browser subscription: DELETE
    // /api/notifications/subscribe authenticates as the caller, so it has to
    // happen before the logout POST clears the cookies. A row left behind keeps
    // the fan-out in services/push.py selecting this endpoint for the user who
    // has just left.
    if (api) {
      try {
        await api.delete('/api/notifications/subscribe', { data: { endpoint: sub.endpoint } });
        result.serverCleared = true;
      } catch {
        // Expired session, offline, or the API is down. The unsubscribe below
        // still stops delivery to this browser, which is the part that matters.
      }
    }
    // The half that actually stops delivery here, and the reason a failed server
    // call is survivable: once the endpoint is gone the push service answers
    // 404/410 and services/push.py prunes the row on the next send.
    result.unsubscribed = (await withTimeout(sub.unsubscribe(), readyTimeoutMs)) === true;
  } catch {
    // Best-effort by contract. Whatever happened, the sign-out proceeds.
  }
  return result;
}
