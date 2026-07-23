// Service-worker registration + Web Push subscription helpers.
import client from '../api/client';

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

export async function disablePushNotifications() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    await client.post('/api/notifications/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe();
  }
}
