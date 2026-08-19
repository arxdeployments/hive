import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import useChatStore from './chatStore.js';

/**
 * Store-level tests, run by Node's own test runner (`npm run test:unit`).
 * Nothing here touches the DOM.
 *
 * The subject is what survives a sign-out. An expired session is torn down by
 * api/client.js with `window.location.href`, which destroys the heap; the
 * sign-out BUTTON is a React Router transition, which does not. So this store —
 * the only place the app holds one person's threads and message bodies — has to
 * be able to be put down explicitly, or the next person to sign in on a shared
 * workstation inherits it.
 */

const store = () => useChatStore.getState();

/** The store's data keys, snapshotted at import before any test writes to it. */
const dataKeys = (s) => Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v !== 'function'));
const INITIAL = dataKeys(useChatStore.getState());

/** Put the store in the state an ordinary session leaves behind. */
function fillSignedInState() {
  store().setConversations([
    { _id: 'conv-a', name: 'Ward Round', unread_count: 2 },
    { _id: 'conv-b', name: 'Referrals' },
  ]);
  store().setActiveConversation('conv-a');
  store().setContacts([{ _id: 'u1', display_name: 'Dr Okafor' }]);
  store().setWsConnected(true);
  useChatStore.setState({
    messages: {
      'conv-a': [{ _id: 'm1', content: 'patient in bed 4 is spiking a temp' }],
    },
    typingUsers: { 'conv-a': { u1: true } },
  });
}

afterEach(() => {
  store().reset();
});

describe('chatStore.reset', () => {
  it('leaves nothing of the previous session behind', () => {
    fillSignedInState();
    // precondition: the data really is in there
    assert.equal(store().conversations.length, 2);
    assert.equal(store().messages['conv-a'].length, 1);

    store().reset();

    assert.deepEqual(store().conversations, []);
    assert.deepEqual(store().messages, {});
    assert.deepEqual(store().contacts, []);
    assert.deepEqual(store().typingUsers, {});
    assert.equal(store().wsConnected, false);
    assert.equal(store().wsConnecting, false);
  });

  it('clears activeConversationId, which is what actually gets rendered', () => {
    // Chat.jsx renders <ChatPanel conversationId={activeConversationId}> and
    // ChatPanel reads messages[conversationId] straight from this store. Leaving
    // the id behind is what put the previous user's thread on screen; leaving
    // only the bodies behind would have been inert.
    fillSignedInState();
    assert.equal(store().activeConversationId, 'conv-a');

    store().reset();

    assert.equal(store().activeConversationId, null);
  });

  it('does not leak message bodies through a stale conversation id', () => {
    fillSignedInState();
    const staleId = store().activeConversationId;

    store().reset();

    // The exact read ChatPanel performs, against the id it would have performed
    // it with. No body may come back.
    assert.deepEqual(store().messages[staleId], undefined);
  });

  it('is safe to call when nothing was ever loaded', () => {
    // logout() runs it unconditionally, including straight after a failed login.
    store().reset();
    store().reset();
    assert.deepEqual(store().conversations, []);
    assert.equal(store().activeConversationId, null);
  });

  it('restores every data key, including ones added to the store later', () => {
    // The drift guard. `reset` is a shallow merge over a hand-written object, so
    // a field declared anywhere other than emptyState is a field it silently
    // cannot clear — which is how pinnedVersion, added later beside its own
    // action, survived the first version of this. Rather than naming the fields,
    // this dirties whatever the store actually has and demands all of it back,
    // so the next field added outside emptyState fails here instead of shipping.
    const dirty = {};
    for (const [key, initial] of Object.entries(INITIAL)) {
      if (Array.isArray(initial)) dirty[key] = [{ _id: 'dirty' }];
      else if (initial !== null && typeof initial === 'object') dirty[key] = { 'conv-a': 'dirty' };
      else if (typeof initial === 'boolean') dirty[key] = !initial;
      else dirty[key] = 'dirty';
    }
    useChatStore.setState(dirty);
    // precondition: every key really did change
    assert.notDeepEqual(dataKeys(useChatStore.getState()), INITIAL);

    store().reset();

    assert.deepEqual(dataKeys(useChatStore.getState()), INITIAL);
  });

  it('clears pinnedVersion, which is keyed by the previous user\'s conversations', () => {
    store().bumpPinnedVersion('conv-a');
    assert.equal(store().pinnedVersion['conv-a'], 1);

    store().reset();

    assert.deepEqual(store().pinnedVersion, {});
  });

  it('leaves the store usable for the next session', () => {
    fillSignedInState();
    store().reset();

    store().setConversations([{ _id: 'conv-z', name: 'New Person Chat' }]);
    store().setActiveConversation('conv-z');

    assert.equal(store().conversations.length, 1);
    assert.equal(store().conversations[0]._id, 'conv-z');
    assert.equal(store().activeConversationId, 'conv-z');
  });
});
