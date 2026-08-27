import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SESSION_NOTIFICATION_KEYS, clearNotificationPrefs, tearDownPush } from './pushTeardown.js';

/**
 * Run by Node's own test runner (`npm run test:unit`). Nothing here touches the
 * DOM: tearDownPush takes the navigator, the axios client and the storage as
 * arguments precisely so this file can drive the paths a browser cannot be made
 * to take on demand — a server that 401s, a service worker that never registers.
 *
 * The subject is the other thing that survives a sign-out. chatStore.test.js
 * covers the heap; this covers the Web Push subscription, which is delivered by
 * the service worker and so outlives the tab entirely. Left in place it kept the
 * departing user's message previews — sender name, 120 characters of body —
 * arriving as OS notifications for whoever used the workstation next.
 */

/** A subscription that records what was called on it, in order. */
function fakeSubscription(calls, { endpoint = 'https://push.example.test/f/abc123', unsubscribe } = {}) {
  return {
    endpoint,
    unsubscribe: async () => {
      calls.push('unsubscribe');
      if (unsubscribe) return unsubscribe();
      return true;
    },
  };
}

/** A navigator with a registered worker and, optionally, a subscription. */
function fakeNav(calls, { sub = null, ready, getSubscription } = {}) {
  return {
    serviceWorker: {
      ready:
        ready !== undefined
          ? ready
          : Promise.resolve({
              pushManager: {
                getSubscription: async () => {
                  calls.push('getSubscription');
                  if (getSubscription) return getSubscription();
                  return sub;
                },
              },
            }),
    },
  };
}

/** An axios-shaped client that records the DELETE, or fails it. */
function fakeApi(calls, { fail = false } = {}) {
  return {
    delete: async (url, config) => {
      calls.push(`delete ${url} ${config?.data?.endpoint}`);
      if (fail) throw new Error('401');
      return { data: {} };
    },
  };
}

function fakeStorage(initial = {}, { throws = false } = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    removeItem: (k) => {
      if (throws) throw new Error('storage disabled');
      delete data[k];
    },
  };
}

describe('tearDownPush', () => {
  it('deletes the server row before unsubscribing the browser', async () => {
    // Ordering is the point, not an incidental. The DELETE authenticates as the
    // signing-out user, so it has to land before the logout POST clears the
    // cookies; and it needs the endpoint, which is what the unsubscribe revokes.
    const calls = [];
    const sub = fakeSubscription(calls);
    const result = await tearDownPush({
      nav: fakeNav(calls, { sub }),
      api: fakeApi(calls),
      storage: fakeStorage(),
    });

    assert.deepEqual(calls, [
      'getSubscription',
      'delete /api/notifications/subscribe https://push.example.test/f/abc123',
      'unsubscribe',
    ]);
    assert.deepEqual(result, { hadSubscription: true, serverCleared: true, unsubscribed: true });
  });

  it('clears the notification preferences the next user would inherit', async () => {
    const storage = fakeStorage({
      rxhive_desktop_notif: 'true',
      rxhive_notif_sound: 'false',
      rxhive_notif_asked: 'true',
      // Device preferences, not this user's answers — these must survive.
      rxhive_font_size: 'large',
      rxhive_enter_sends: 'false',
    });
    await tearDownPush({ nav: fakeNav([], { sub: fakeSubscription([]) }), storage });

    for (const key of SESSION_NOTIFICATION_KEYS) {
      assert.equal(storage.getItem(key), null, `${key} survived the sign-out`);
    }
    assert.equal(storage.getItem('rxhive_font_size'), 'large');
    assert.equal(storage.getItem('rxhive_enter_sends'), 'false');
  });

  it('still unsubscribes the browser when the server call fails', async () => {
    // The expired-session and offline case. The server row is then reclaimed by
    // the 404/410 prune in services/push.py on the next send; delivery to this
    // machine has already stopped, which is the half that matters here.
    const calls = [];
    const result = await tearDownPush({
      nav: fakeNav(calls, { sub: fakeSubscription(calls) }),
      api: fakeApi(calls, { fail: true }),
      storage: fakeStorage(),
    });

    assert.ok(calls.includes('unsubscribe'), 'a failed DELETE skipped the unsubscribe');
    assert.deepEqual(result, { hadSubscription: true, serverCleared: false, unsubscribed: true });
  });

  it('unsubscribes without touching the API when no client is supplied', async () => {
    const calls = [];
    const result = await tearDownPush({
      nav: fakeNav(calls, { sub: fakeSubscription(calls) }),
      storage: fakeStorage(),
    });

    assert.deepEqual(calls, ['getSubscription', 'unsubscribe']);
    assert.deepEqual(result, { hadSubscription: true, serverCleared: false, unsubscribed: true });
  });

  it('gives up instead of hanging when the service worker never becomes ready', async () => {
    // navigator.serviceWorker.ready is a PENDING promise when no worker is
    // registered, not a rejected one. Unbounded, this is a sign-out button that
    // never returns — and registration is exactly what fails behind a proxy that
    // serves /sw.js with the wrong content type.
    const calls = [];
    const result = await tearDownPush({
      nav: fakeNav(calls, { ready: new Promise(() => {}) }),
      api: fakeApi(calls),
      storage: fakeStorage(),
      readyTimeoutMs: 5,
    });

    assert.deepEqual(calls, [], 'nothing should have been called');
    assert.deepEqual(result, { hadSubscription: false, serverCleared: false, unsubscribed: false });
  });

  it('does nothing when this browser has no subscription', async () => {
    const calls = [];
    const result = await tearDownPush({
      nav: fakeNav(calls, { sub: null }),
      api: fakeApi(calls),
      storage: fakeStorage(),
    });

    assert.deepEqual(calls, ['getSubscription']);
    assert.deepEqual(result, { hadSubscription: false, serverCleared: false, unsubscribed: false });
  });

  it('reports failure rather than throwing when the subscription refuses', async () => {
    // A sign-out must complete even when the teardown cannot.
    const calls = [];
    const result = await tearDownPush({
      nav: fakeNav(calls, {
        sub: fakeSubscription(calls, {
          unsubscribe: () => {
            throw new Error('InvalidStateError');
          },
        }),
      }),
      storage: fakeStorage(),
    });

    // Both halves matter: this is the case disablePushNotifications turns into a
    // throw, and it can only tell it apart from "nothing to do" by hadSubscription.
    assert.equal(result.hadSubscription, true);
    assert.equal(result.unsubscribed, false);
  });

  it('survives an environment with no service worker at all', async () => {
    const none = { hadSubscription: false, serverCleared: false, unsubscribed: false };
    assert.deepEqual(await tearDownPush({ nav: {}, api: fakeApi([]), storage: fakeStorage() }), none);

    // And with no navigator whatsoever, which is how this runs under SSR or a test.
    assert.deepEqual(await tearDownPush(), none);
  });

  it('survives storage that throws, as it does in private mode', () => {
    const storage = fakeStorage({ rxhive_desktop_notif: 'true' }, { throws: true });
    assert.doesNotThrow(() => clearNotificationPrefs(storage));
    // Nothing to assert about the value: the point is that the sign-out is not
    // taken down by a SecurityError from removeItem.
  });
});
