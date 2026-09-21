/**
 * A send made while the conversation's first fetch was still in flight used to
 * disappear from the thread.
 *
 * fetchMessages carried over only 'failed' bubbles. The reasoning was sound for
 * the path it was written against — the ack deadline resolves an unacked send
 * to 'failed' before a reconnect-triggered refetch — but fetchMessages also
 * runs when a conversation is OPENED, where no socket has been lost, no
 * deadline has elapsed, and a send from a moment ago is still 'sending'.
 *
 * Nothing could put it back afterwards:
 *
 *   - `replaceOptimisticMessage` matches on temp_id and no-ops when the bubble
 *     is gone, so the ack did nothing.
 *   - the API excludes the sender from its own `new_message` broadcast
 *     (services/messaging.py, `conversation_recipients(..., exclude=sender.id)`),
 *     so no arrival added it either.
 *
 * The message was on the server and visible in the sidebar's last-message
 * preview, and absent from the thread until the next fetch. It is what the e2e
 * suite had been calling a flaky click for months: `accessibility.spec.js`
 * opened a conversation, sent, and clicked the new message's menu, and on a
 * slow runner the fetch landed in between.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import useChatStore from '../stores/chatStore.js';
import { carryOverLocalOnly } from './carryOverLocalOnly.js';

const CONV = 'conv-1';

/** What fetchMessages did before: 'failed' only. */
const failedOnly = (existing, fetched) => {
  const landed = new Set(fetched.map((m) => m.client_msg_id).filter(Boolean));
  return existing.filter((m) => m.status === 'failed' && !landed.has(m.temp_id));
};

/** One conversation open, one message already loaded, one send in flight. */
const sendWhileFetching = (carry) => {
  useChatStore.setState({ messages: {}, activeConversationId: CONV });
  const store = useChatStore.getState();
  store.setMessages(CONV, [{ _id: 'old-1', content: 'older', status: 'sent' }]);
  store.addOptimisticMessage(CONV, { temp_id: 't-1', content: 'in flight', status: 'sending' });

  // A fetch that STARTED BEFORE the send now lands, so its payload cannot
  // contain it, and setMessages replaces the window wholesale.
  const fetched = [{ _id: 'old-1', content: 'older', status: 'sent' }];
  const local = carry(useChatStore.getState().messages[CONV] || [], fetched);
  store.setMessages(CONV, local.length ? [...fetched, ...local] : fetched);

  // The ack the server sends the sender instead of a new_message broadcast.
  store.replaceOptimisticMessage(CONV, 't-1', { _id: 'real-1', created_at: 'now', status: 'sent' });
  return (useChatStore.getState().messages[CONV] || []).find((m) => m.content === 'in flight');
};

describe('a send in flight survives the fetch that lands on top of it', () => {
  it('was lost under the old rule', () => {
    // Pinned so the fix cannot be quietly reverted to "failed only" and read as
    // equivalent: this is the behaviour that shipped, and it is wrong.
    assert.equal(sendWhileFetching(failedOnly), undefined);
  });

  it('survives, and the ack still resolves it', () => {
    const message = sendWhileFetching(carryOverLocalOnly);
    assert.ok(message, 'the send vanished from the thread');
    assert.equal(message.status, 'sent');
    assert.equal(message._id, 'real-1');
  });
});

describe('carryOverLocalOnly keeps exactly what the server has not seen', () => {
  for (const [status, kept] of [
    ['sending', true],
    ['failed', true],
    ['sent', false],
    ['delivered', false],
    ['read', false],
    [undefined, false],
  ]) {
    it(`${kept ? 'keeps' : 'drops'} a ${status ?? 'statusless'} bubble`, () => {
      const existing = [{ temp_id: 't', content: 'x', status }];
      assert.equal(carryOverLocalOnly(existing, []).length, kept ? 1 : 0);
    });
  }

  it('drops a bubble whose message already came back, so it is not shown twice', () => {
    // client_msg_id is the sender's temp_id, cleaned. Without this the message
    // sits under its own real copy, inviting the user to send it again.
    const existing = [{ temp_id: 't-9', content: 'landed', status: 'sending' }];
    const fetched = [{ _id: 'real-9', content: 'landed', status: 'sent', client_msg_id: 't-9' }];
    assert.deepEqual(carryOverLocalOnly(existing, fetched), []);
  });

  it('keeps a bubble the fetch does not account for', () => {
    const existing = [{ temp_id: 't-9', content: 'not landed', status: 'sending' }];
    const fetched = [{ _id: 'real-8', content: 'someone else', status: 'sent', client_msg_id: 't-8' }];
    assert.equal(carryOverLocalOnly(existing, fetched).length, 1);
  });

  it('is not confused by messages carrying no key', () => {
    // The API withholds other senders' client_msg_id, so most fetched rows have
    // none. A naive Set would collect `undefined` and match every local bubble
    // that also has none.
    const existing = [{ content: 'mine', status: 'sending' }];
    const fetched = [{ _id: 'theirs', content: 'theirs', status: 'sent' }];
    assert.equal(carryOverLocalOnly(existing, fetched).length, 1);
  });

  it('tolerates an empty or missing window', () => {
    assert.deepEqual(carryOverLocalOnly(undefined, undefined), []);
    assert.deepEqual(carryOverLocalOnly([], []), []);
  });
});


/**
 * The rule above is only worth what its wiring is worth.
 *
 * Every mutation of the helper reds a test, and deleting the call from
 * ChatPanel red nothing — the send vanished again and the suite stayed green.
 * That is the gap this repo keeps finding: a guard that is correct and unused.
 *
 * Source assertions, in the style of components/chat/chatRequestOrdering.test.js,
 * because there is no component harness here to mount ChatPanel in.
 */
describe('ChatPanel actually uses the rule', () => {
  const source = () =>
    readFileSync(join(import.meta.dirname, '..', 'components', 'chat', 'ChatPanel.jsx'), 'utf8');

  it('imports the helper', () => {
    assert.match(
      source(),
      /import\s*\{[^}]*\bcarryOverLocalOnly\b[^}]*\}\s*from/,
      'ChatPanel does not import carryOverLocalOnly, so nothing carries a send in flight.',
    );
  });

  it('replaces a fetched window only through it', () => {
    // Both fetch paths — the initial load and the jump — end by replacing the
    // window wholesale. Each has to fold the local-only bubbles back in first.
    const replacements = [...source().matchAll(/setMessages\(\s*conversationId\s*,([^;]*);/g)]
      .map((match) => match[1])
      .filter((argument) => argument.includes('fetched'));
    assert.equal(replacements.length, 2, `expected both fetch paths, found ${replacements.length}`);
    for (const argument of replacements) {
      assert.match(
        argument,
        /localOnly/,
        `a fetched window is written without the carried bubbles: setMessages(conversationId,${argument}`,
      );
    }
  });

  it('derives those bubbles from the helper, not by hand', () => {
    const calls = source().match(/carryOverLocalOnly\(/g) || [];
    assert.equal(calls.length, 2, `expected one call per fetch path, found ${calls.length}`);
    assert.doesNotMatch(
      source(),
      /status === 'failed'/,
      "ChatPanel filters on status itself again; the rule belongs in one place.",
    );
  });
});
