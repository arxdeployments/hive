// Service-worker registration + Web Push subscription helpers.
import client from '../api/client';
import { tearDownPush } from './pushTeardown';

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[PWA] SW registration failed:', err);
    });
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export async function enablePushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported in this browser');
  }
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission denied');

  const { data } = await client.get('/api/notifications/vapid-key');
  if (!data.public_key) throw new Error('Push is not configured on the server');

  const reg = await navigator.serviceWorker.ready;
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
