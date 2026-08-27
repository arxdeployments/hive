/**
 * Deciding whether to silently restore a Web Push subscription, and finding out
 * whether one exists.
 *
 * Same constraints as pushTeardown.js: nothing here reaches api/client.js, and
 * every relative import carries its `.js`, so `npm run test:unit` can load it
 * under Node's own runner. The browser objects are injected.
 *
 * WHY A RESTORE EXISTS AT ALL
 *
 * pushManager.subscribe() had exactly two call sites, both of them a person
 * clicking something: the Settings toggle and the banner in Chat. There is no
 * `pushsubscriptionchange` handler in public/sw.js and nothing re-subscribed on
 * load, so a subscription lost for ANY reason was gone until the user thought to
 * toggle it off and on again — and nothing told them it had gone.
 *
 * Batch 38 turned that from rare into routine: sign-out now revokes the
 * subscription deliberately (lib/pushTeardown.js). So somebody who explicitly
 * asked for push lost it at the end of every shift and silently never got it
 * back. Browsers also rotate and expire subscriptions on their own, which was
 * always unhandled.
 */

import { withTimeout } from './withTimeout.js';

/** Bound on the lookup below. Short: this runs on the app's start-up path. */
export const RESTORE_TIMEOUT_MS = 3000;

/**
 * Whether this browser currently holds a push subscription.
 *
 * Best-effort: `null` means "could not find out" — no service worker, the
 * registration never became ready, the lookup threw — and is deliberately NOT
 * `false`, because the two lead to different decisions. Treating "unknown" as
 * "absent" would subscribe on a hunch; treating it as "present" would report a
 * subscription that may not exist.
 *
 * @returns {Promise<boolean|null>}
 */
export async function hasPushSubscription({ nav, timeoutMs = RESTORE_TIMEOUT_MS } = {}) {
  if (!nav || !('serviceWorker' in nav)) return null;
  try {
    const expiry = Date.now() + timeoutMs;
    const remaining = () => Math.max(0, expiry - Date.now());
    const reg = await withTimeout(nav.serviceWorker.ready, remaining());
    if (!reg?.pushManager) return null;
    const sub = await withTimeout(reg.pushManager.getSubscription().then((s) => ({ s })), remaining());
    // The wrapper object is what separates "resolved with no subscription" from
    // "withTimeout gave up", both of which are otherwise undefined.
    if (!sub) return null;
    return Boolean(sub.s?.endpoint);
  } catch {
    return null;
  }
}

/**
 * Should a subscription be created right now, without asking anybody?
 *
 * Pure, and the whole point of the module: these four rules are the ones with
 * consequences if they are wrong, so they are separated from the browser calls
 * and tested directly.
 *
 * @param {object} facts
 * @param {boolean} facts.intentIsExplicit  the preference is stored as "yes",
 *   not merely absent — see wantsDesktopNotifications in utils/notificationPrefs
 * @param {string}  facts.permission        Notification.permission
 * @param {boolean|null} facts.hasSubscription  from hasPushSubscription
 * @param {boolean} facts.pushSupported     serviceWorker + PushManager present
 */
export function shouldRestorePush({
  intentIsExplicit,
  permission,
  hasSubscription,
  pushSupported,
}) {
  // An ABSENT preference must never reach here, which is why the caller has to
  // establish that the stored value is explicitly "yes".
  //
  // `rxhive_desktop_notif` is read elsewhere as `!== 'false'`, so unset means ON
  // for the in-page notification path — a default that is fine for a tab drawing
  // its own notification and quite wrong as authority to create a server-side
  // subscription. It is also the NORMAL state of a fresh sign-in, because the
  // sign-out teardown clears the key: defaulting that to "subscribe" would bind
  // push to whoever signed in next on a shared workstation without them ever
  // asking. Restoring is for someone who said yes and lost it, never for someone
  // who has not been asked.
  if (!intentIsExplicit) return false;
  if (!pushSupported) return false;
  // Never prompt. Notification.requestPermission() has to run inside a user
  // gesture for Safari to honour it, and this path has no gesture behind it — it
  // is an effect on app start. Permission already granted is what makes a silent
  // pushManager.subscribe() legitimate; anything else waits for the user to use
  // the Settings toggle or the banner.
  if (permission !== 'granted') return false;
  // `null` is "could not find out", and subscribing then risks a pointless
  // duplicate call against the push service on every load.
  if (hasSubscription !== false) return false;
  return true;
}

/**
 * Decide and act: restore a subscription if the rules allow, otherwise do nothing.
 *
 * The orchestration lives here rather than in pwa.js so the cases below can be
 * tested — pwa.js reaches api/client.js, which Node's runner cannot load. Every
 * fact arrives as a FUNCTION, not a value, and that is the whole design:
 *
 * WHY THE FACTS ARE RE-READ AFTER THE AWAIT
 *
 * hasPushSubscription waits on serviceWorker.ready and can take seconds. A
 * session can end inside that window, and signing out clears
 * `rxhive_desktop_notif` and revokes the subscription (lib/pushTeardown.js). Read
 * once up front, the values are then stale in the worst possible direction: the
 * lookup returns "no subscription" precisely BECAUSE the sign-out just removed
 * it, and a restore decided on the pre-await preference would subscribe again —
 * re-binding push to the user who has just left, which is the leak Batch 38
 * existed to close, reintroduced through a race.
 *
 * `isCancelled` covers the same window from the other side: RealtimeSession's
 * effect cleanup runs on sign-out, and this must not outlive the session that
 * started it.
 *
 * Never throws. A silent restore that fails must not surface as an error nobody
 * asked for.
 *
 * @returns {Promise<boolean>} whether a subscription was actually created
 */
export async function restorePushSubscription({
  nav,
  pushSupported,
  getPermission,
  wantsPush,
  subscribe,
  tearDown,
  isCancelled = () => false,
  timeoutMs = RESTORE_TIMEOUT_MS,
}) {
  try {
    // Cheap gate first: skip the serviceWorker.ready await entirely when the
    // answer cannot matter, since this runs on every app start.
    if (!pushSupported || !wantsPush()) return false;

    const hasSubscription = await hasPushSubscription({ nav, timeoutMs });

    if (isCancelled()) return false;
    const restore = shouldRestorePush({
      // Both re-read, deliberately, and never carried across the await above.
      intentIsExplicit: wantsPush(),
      permission: getPermission(),
      hasSubscription,
      pushSupported,
    });
    if (!restore) return false;

    await subscribe();

    // The checks above did NOT close the window, they only moved it. subscribe()
    // is several network round trips — the VAPID key, the push service, then the
    // POST that registers the endpoint — so a session can end inside it too.
    //
    // And this is the worst place for that to happen. Sign-out runs the teardown
    // BEFORE the logout request, so it looks for a subscription that does not
    // exist yet, deletes nothing, and returns; then this POST lands with cookies
    // that are still valid and persists a subscription bound to the user who has
    // just left. Teardown cannot protect against something created after it ran,
    // so the restore has to clean up after itself.
    if (isCancelled() || !wantsPush()) {
      if (tearDown) await tearDown();
      return false;
    }
    return true;
  } catch {
    // The user's own next visit to Settings is the fallback.
    return false;
  }
}
