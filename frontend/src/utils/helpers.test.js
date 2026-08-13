import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apiError } from './helpers.js';

/**
 * Run by `npm run test:unit`. Nothing here touches the DOM.
 *
 * apiError is the one place standing between a FastAPI error body and
 * toast.error(), and sonner renders what it is handed straight into the tree —
 * under a <Toaster> mounted above the router, so a non-string does not spoil a
 * toast, it drops the whole SPA to the top-level error boundary. That makes
 * "always returns a string" the property worth pinning down, for every shape the
 * API answers in and every shape a caller might pass.
 */
describe('apiError', () => {
  const withData = (data) => ({ response: { data } });

  it('prefers a string detail', () => {
    assert.equal(apiError(withData({ detail: 'Email already in use' }), 'fb'), 'Email already in use');
  });

  it('reads the first msg out of a pydantic validation list', () => {
    const err = withData({ detail: [{ loc: ['body', 'display_name'], msg: 'String should have at least 2 characters', type: 'too_short' }] });
    assert.equal(apiError(err, 'fb'), 'String should have at least 2 characters');
  });

  it('falls back to message for the routes that answer that way', () => {
    assert.equal(apiError(withData({ message: 'Rate limited' }), 'fb'), 'Rate limited');
  });

  it('keeps detail ahead of message', () => {
    assert.equal(apiError(withData({ detail: 'first', message: 'second' }), 'fb'), 'first');
  });

  it('uses the caller fallback when the body carries nothing usable', () => {
    for (const data of [undefined, null, {}, { detail: null }, { detail: [] }, { detail: [{ loc: ['x'] }] }, { message: 42 }]) {
      assert.equal(apiError(withData(data), 'Failed to save'), 'Failed to save', `for ${JSON.stringify(data)}`);
    }
  });

  it('uses the caller fallback when there is no response at all', () => {
    for (const err of [undefined, null, new Error('Network Error'), {}, 'nope']) {
      assert.equal(apiError(err, 'Failed to save'), 'Failed to save');
    }
  });

  // The regression: `fallback` was returned unchecked, so a caller that passed
  // an object handed one to toast.error() and React threw inside <Toaster>.
  it('returns a string even when the caller fallback is not one', () => {
    for (const bad of [undefined, null, {}, [], 42, true, { detail: 'x' }, () => {}]) {
      const out = apiError(new Error('boom'), bad);
      assert.equal(typeof out, 'string', `for ${String(bad)}`);
      assert.ok(out.length > 0);
    }
  });

  it('treats an empty-string fallback as no fallback', () => {
    const out = apiError(new Error('boom'), '');
    assert.equal(typeof out, 'string');
    assert.ok(out.length > 0);
  });

  // The shape that started it: an array reaching toast.error() unflattened.
  it('never returns a non-string for any body shape', () => {
    const bodies = [
      { detail: [{ msg: 'a' }, { msg: 'b' }] },
      { detail: [{ msg: null }] },
      { detail: { nested: 'object' } },
      { detail: 42 },
      { message: ['array'] },
      { detail: ['bare string in a list'] },
    ];
    for (const data of bodies) {
      assert.equal(typeof apiError(withData(data), 'fb'), 'string', `for ${JSON.stringify(data)}`);
    }
  });
});
