import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasPushSubscription, restorePushSubscription, shouldRestorePush } from './pushRestore.js';
import { isExplicitOff, isExplicitOn } from '../utils/notificationPrefs.js';

/**
 * Run by Node's own test runner (`npm run test:unit`). No DOM: the navigator is
 * injected, and the decision rules are a pure function precisely so the cases
 * that matter can be stated rather than clicked.
 *
 * What is under test is a silent, automatic subscribe. It runs on app start with
 * nobody watching, so the rules about when it must NOT fire carry more weight
 * than the happy path.
 */

function fakeNav({ sub, ready, getSubscription } = {}) {
  return {
    serviceWorker: {
      ready:
        ready !== undefined
          ? ready
          : Promise.resolve({
              pushManager: {
                getSubscription: getSubscription || (async () => sub ?? null),
              },
            }),
    },
  };
}

const SUB = { endpoint: 'https://push.example.test/f/abc123' };

/** All four facts aligned for a restore. Each test breaks exactly one. */
const RESTORABLE = {
  intentIsExplicit: true,
  permission: 'granted',
  hasSubscription: false,
  pushSupported: true,
};

describe('shouldRestorePush', () => {
  it('restores for someone who asked and lost it', () => {
    assert.equal(shouldRestorePush(RESTORABLE), true);
  });

  it('does not treat an absent preference as consent', () => {
    // The case that decides whether this feature is safe at all.
    //
    // `rxhive_desktop_notif` is read elsewhere as `!== 'false'`, so unset means ON
    // for the in-page path. Unset is ALSO the normal state of a fresh sign-in,
    // because the sign-out teardown clears the key — so reading unset as consent
    // would subscribe whoever sat down next at a shared workstation to push they
    // were never asked about, and bind it to their account server-side.
    assert.equal(shouldRestorePush({ ...RESTORABLE, intentIsExplicit: false }), false);
  });

  it('never prompts: no permission, no restore', () => {
    // requestPermission() must run inside a user gesture for Safari to honour it,
    // and this path is an effect on app start. Anything short of already-granted
    // waits for the Settings toggle or the banner.
    for (const permission of ['default', 'denied', undefined]) {
      assert.equal(
        shouldRestorePush({ ...RESTORABLE, permission }),
        false,
        `permission ${String(permission)} should not restore`,
      );
    }
  });

  it('does nothing when a subscription is already there', () => {
    assert.equal(shouldRestorePush({ ...RESTORABLE, hasSubscription: true }), false);
  });

  it('treats an unknown subscription state as a reason not to act', () => {
    // `null` is "could not find out", which is not "absent". Subscribing on it
    // would hit the push service again on every single app start.
    assert.equal(shouldRestorePush({ ...RESTORABLE, hasSubscription: null }), false);
  });

  it('does nothing where push is unsupported', () => {
    assert.equal(shouldRestorePush({ ...RESTORABLE, pushSupported: false }), false);
  });
});

describe('isExplicitOn', () => {
  it('separates an explicit yes from a merely absent value', () => {
    assert.equal(isExplicitOn('true'), true);
    assert.equal(isExplicitOn('on'), true);
    // The three that must not read as consent. `null` is what getItem returns for
    // a key the sign-out teardown has cleared.
    assert.equal(isExplicitOn(null), false);
    assert.equal(isExplicitOn(undefined), false);
    assert.equal(isExplicitOn('false'), false);
  });
});

describe('hasPushSubscription', () => {
  it('reports a real subscription', async () => {
    assert.equal(await hasPushSubscription({ nav: fakeNav({ sub: SUB }) }), true);
  });

  it('reports the absence of one as false, not unknown', async () => {
    // This is the value that authorises a restore, so it has to be false and not
    // null when the browser has genuinely answered "no subscription".
    assert.equal(await hasPushSubscription({ nav: fakeNav({ sub: null }) }), false);
  });

  it('says unknown rather than absent when the worker never becomes ready', async () => {
    const result = await hasPushSubscription({
      nav: fakeNav({ ready: new Promise(() => {}) }),
      timeoutMs: 5,
    });
    assert.equal(result, null);
  });

  it('says unknown rather than absent when the lookup throws', async () => {
    const result = await hasPushSubscription({
      nav: fakeNav({
        getSubscription: async () => {
          throw new Error('InvalidStateError');
        },
      }),
    });
    assert.equal(result, null);
  });

  it('says unknown where there is no service worker', async () => {
    assert.equal(await hasPushSubscription({ nav: {} }), null);
    assert.equal(await hasPushSubscription(), null);
  });
});

describe('isExplicitOff', () => {
  it('honours the legacy "off" that a raw !== \'false\' comparison gets wrong', () => {
    // The one value where the two readings disagree, and the reason Settings must
    // not compare the string itself: a profile from an older build storing 'off'
    // read as ENABLED, and the mount effect then persisted 'true' over it — so
    // notifications the user had switched off came back, and now would also
    // authorise an automatic subscribe.
    assert.equal(isExplicitOff('off'), true);
    assert.equal(isExplicitOff('false'), true);
    assert.equal(isExplicitOff(null), false, 'unset must stay ON for the in-page path');
    // And it is never consent, whichever way it is read.
    assert.equal(isExplicitOn('off'), false);
  });
});

describe('restorePushSubscription', () => {
  /** Facts aligned for a restore, each supplied as a getter. */
  function deps(overrides = {}) {
    const calls = [];
    const base = {
      nav: fakeNav({ sub: null }),
      pushSupported: true,
      getPermission: () => 'granted',
      wantsPush: () => true,
      subscribe: async () => {
        calls.push('subscribe');
        return true;
      },
      calls,
    };
    return { ...base, ...overrides, calls: overrides.calls || calls };
  }

  it('subscribes for someone who asked and lost it', async () => {
    const d = deps();
    assert.equal(await restorePushSubscription(d), true);
    assert.deepEqual(d.calls, ['subscribe']);
  });

  it('does NOT subscribe when the preference is cleared while the lookup is out', async () => {
    // The regression test for the sign-out race, and the reason every fact is a
    // getter rather than a value.
    //
    // hasPushSubscription waits on serviceWorker.ready and can take seconds. Sign
    // out inside that window and lib/pushTeardown.js clears the preference AND
    // revokes the subscription — so the lookup returns "no subscription" precisely
    // BECAUSE the sign-out removed it. Deciding on the pre-await preference would
    // subscribe again and re-bind push to the user who just left, which is exactly
    // the leak Batch 38 closed.
    const calls = [];
    let signedOut = false;
    const d = deps({
      calls,
      // Flips during the await, the way a sign-out does.
      wantsPush: () => !signedOut,
      nav: fakeNav({
        getSubscription: async () => {
          signedOut = true;
          return null;
        },
      }),
      subscribe: async () => {
        calls.push('subscribe');
        return true;
      },
    });

    assert.equal(await restorePushSubscription(d), false);
    assert.deepEqual(calls, [], 'subscribed after the session had ended');
  });

  it('does NOT subscribe when the session is cancelled while the lookup is out', async () => {
    // The same window, closed from the other side: RealtimeSession's effect
    // cleanup runs on sign-out, and this must not outlive the session.
    const calls = [];
    let cancelled = false;
    const d = deps({
      calls,
      isCancelled: () => cancelled,
      nav: fakeNav({
        getSubscription: async () => {
          cancelled = true;
          return null;
        },
      }),
      subscribe: async () => {
        calls.push('subscribe');
        return true;
      },
    });

    assert.equal(await restorePushSubscription(d), false);
    assert.deepEqual(calls, []);
  });

  it('does NOT subscribe when permission is revoked while the lookup is out', async () => {
    const calls = [];
    let permission = 'granted';
    const d = deps({
      calls,
      getPermission: () => permission,
      nav: fakeNav({
        getSubscription: async () => {
          permission = 'denied';
          return null;
        },
      }),
      subscribe: async () => {
        calls.push('subscribe');
        return true;
      },
    });

    assert.equal(await restorePushSubscription(d), false);
    assert.deepEqual(calls, []);
  });

  it('never reaches the lookup when the preference is already off', async () => {
    // The cheap gate: this runs on every app start, so it must not pay for a
    // serviceWorker.ready await it cannot use.
    const calls = [];
    const d = deps({
      calls,
      wantsPush: () => false,
      nav: fakeNav({
        getSubscription: async () => {
          calls.push('getSubscription');
          return null;
        },
      }),
    });

    assert.equal(await restorePushSubscription(d), false);
    assert.deepEqual(calls, []);
  });

  it('does nothing when a subscription is already there', async () => {
    const d = deps({ nav: fakeNav({ sub: SUB }) });
    assert.equal(await restorePushSubscription(d), false);
    assert.deepEqual(d.calls, []);
  });

  it('tears down a subscription it created after the session had ended', async () => {
    // The last window, and the worst one: subscribe() is several network round
    // trips, so a sign-out can land inside it. Sign-out runs the teardown BEFORE
    // the logout request, so it looks for a subscription that does not exist yet,
    // deletes nothing, and returns — then this POST lands with cookies that are
    // still valid and leaves push bound to the user who just left. Teardown cannot
    // protect against something created after it ran.
    const calls = [];
    let cancelled = false;
    const d = deps({
      calls,
      isCancelled: () => cancelled,
      subscribe: async () => {
        calls.push('subscribe');
        // The session ends while this is still in flight.
        cancelled = true;
      },
      tearDown: async () => {
        calls.push('tearDown');
      },
    });

    assert.equal(await restorePushSubscription(d), false);
    assert.deepEqual(calls, ['subscribe', 'tearDown']);
  });

  it('tears down when the preference is cleared during the subscribe', async () => {
    // Same window, reached the other way: signing out clears the preference too,
    // and the Settings toggle can clear it without any sign-out at all.
    const calls = [];
    let wanted = true;
    const d = deps({
      calls,
      wantsPush: () => wanted,
      subscribe: async () => {
        calls.push('subscribe');
        wanted = false;
      },
      tearDown: async () => {
        calls.push('tearDown');
      },
    });

    assert.equal(await restorePushSubscription(d), false);
    assert.deepEqual(calls, ['subscribe', 'tearDown']);
  });

  it('leaves a subscription alone when the session is still good', async () => {
    // The other half of the guard: it must not undo its own successful work.
    const calls = [];
    const d = deps({
      calls,
      subscribe: async () => {
        calls.push('subscribe');
      },
      tearDown: async () => {
        calls.push('tearDown');
      },
    });

    assert.equal(await restorePushSubscription(d), true);
    assert.deepEqual(calls, ['subscribe']);
  });

  it('reports false rather than throwing when the subscribe fails', async () => {
    const d = deps({
      subscribe: async () => {
        throw new Error('Push is not configured on the server');
      },
    });
    assert.equal(await restorePushSubscription(d), false);
  });
});
