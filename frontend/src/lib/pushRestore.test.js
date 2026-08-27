import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasPushSubscription, shouldRestorePush } from './pushRestore.js';
import { isExplicitOn } from '../utils/notificationPrefs.js';

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
