// Service-worker registration + Web Push subscription helpers.
import client from '../api/client';
import { tearDownPush } from './pushTeardown';
import { hasPushSubscription, shouldRestorePush } from './pushRestore';
import { wantsDesktopNotifications } from '../utils/notificationPrefs';
import { withTimeout } from './withTimeout';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[PWA] SW registration failed:', err);
    });
  });
}

/** Bound on the service-worker await inside subscribeToPush. */
const SUBSCRIBE_TIMEOUT_MS = 3000;

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** serviceWorker + PushManager both present. */
export function pushSupported() {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window;
}

/**
 * Create the subscription and register it with the API. Does NOT prompt.
 *
 * Split out of enablePushNotifications so the silent restore below can reuse the
 * subscribe half without the permission half: requestPermission() must run
 * inside a user gesture for Safari to honour it, and the restore has no gesture
 * behind it. Requires permission to be granted already, and says so rather than
 * prompting.
 */
export async function subscribeToPush() {
  if (!pushSupported()) {
    throw new Error('Push notifications are not supported in this browser');
  }
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    throw new Error('Notification permission denied');
  }

  const { data } = await client.get('/api/notifications/vapid-key');
  if (!data.public_key) throw new Error('Push is not configured on the server');

  // Bounded: serviceWorker.ready never resolves when no worker is registered,
  // and this now runs on an app-start effect as well as behind a click.
  const reg = await withTimeout(navigator.serviceWorker.ready, SUBSCRIBE_TIMEOUT_MS);
  if (!reg?.pushManager) throw new Error('The service worker is not available');
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(data.public_key),
  });

  const json = sub.toJSON();
  await client.post('/api/notifications/subscribe', {
    endpoint: json.endpoint,
    keys: json.keys,
  });
  return true;
}

export async function enablePushNotifications() {
  if (!pushSupported()) {
    throw new Error('Push notifications are not supported in this browser');
  }
  // First, and before any await that is not this one, so it stays inside the
  // click that called us.
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission denied');
  return subscribeToPush();
}

/**
 * Does this browser hold a subscription? `null` means "could not find out".
 *
 * Settings uses it to stop reporting a subscription that does not exist.
 */
export function pushSubscriptionExists() {
  return hasPushSubscription({ nav: typeof navigator === 'undefined' ? undefined : navigator });
}

/**
 * Re-create a subscription for somebody who already asked for one and lost it.
 *
 * Silent by design and best-effort: it never prompts, never throws, and does
 * nothing at all unless shouldRestorePush agrees on all four counts — see that
 * function for why an unset preference is not consent.
 *
 * @returns {Promise<boolean>} whether a subscription was actually created
 */
export async function healPushSubscription() {
  try {
    const supported = pushSupported();
    // Skip the lookup entirely when the answer cannot matter; it costs a
    // serviceWorker.ready await on every app start otherwise.
    if (!supported || !wantsDesktopNotifications()) return false;
    const subscribed = await pushSubscriptionExists();
    const restore = shouldRestorePush({
      intentIsExplicit: true,
      permission: typeof Notification === 'undefined' ? 'default' : Notification.permission,
      hasSubscription: subscribed,
      pushSupported: supported,
    });
    if (!restore) return false;
    await subscribeToPush();
    return true;
  } catch {
    // The user's own next visit to Settings is the fallback. A failed silent
    // restore must not surface as an error nobody asked for.
    return false;
  }
}

/**
 * Turn push off for this device. One implementation, shared with every sign-out
 * path — see lib/pushTeardown.js for the ordering and the timeouts.
 *
 * `storage` is deliberately not passed: this is the Settings toggle, which owns
 * `rxhive_desktop_notif` itself and writes it as the user flips the switch.
 * Clearing it from in here would fight that effect.
 *
 * Throws when a subscription existed and could not be revoked, because the caller
 * is a toggle that rolls itself back on failure. tearDownPush never throws — that
 * is its contract, and the right one for a sign-out, which must complete either
 * way — so the failure has to be raised here or the switch would move to "off"
 * over a subscription that is still live and still delivering.
 *
 * A missing subscription is not a failure: there was nothing to turn off.
 */
export async function disablePushNotifications() {
  const { hadSubscription, unsubscribed } = await tearDownPush({ nav: navigator, api: client });
  if (hadSubscription && !unsubscribed) {
    throw new Error('Could not turn off notifications on this device');
  }
}
