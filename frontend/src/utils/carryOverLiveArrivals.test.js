/**
 * A message that arrives over the socket while a newest-page fetch is in flight is
 * newer than everything on that page and not on it. Replacing the thread with the
 * page deleted it, and the thread was then marked read. See carryOverLiveArrivals.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { carryOverLiveArrivals } from './carryOverLiveArrivals.js';

const msg = (_id, second, extra = {}) => ({
  _id,
  created_at: `2026-10-01T08:00:${String(second).padStart(2, '0')}Z`,
  ...extra,
});

describe('carryOverLiveArrivals', () => {
  it('keeps a message that arrived after the server chose the page', () => {
    const existing = [msg('m1', 1), msg('m3-live', 3)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched).map((m) => m._id), ['m3-live']);
  });

  it('does not keep a message the page already carries', () => {
    const existing = [msg('m1', 1), msg('m2', 2)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched), []);
  });

  it('does not keep the old window\'s rows from before the page', () => {
    const existing = [msg('m-older', 0), msg('m1', 1)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched), []);
  });

  it('leaves unsent bubbles to carryOverLocalOnly', () => {
    const existing = [msg('temp-1', 9, { status: 'sending' }), msg('temp-2', 9, { status: 'failed' })];
    const fetched = [msg('m1', 1)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched), []);
  });

  it('keeps my own acknowledged send that the page does not have yet', () => {
    const existing = [msg('m1', 1), msg('m4-mine', 4, { status: 'sent' })];
    const fetched = [msg('m1', 1)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched).map((m) => m._id), ['m4-mine']);
  });

  it('keeps live arrivals when the page is empty', () => {
    assert.deepEqual(carryOverLiveArrivals([msg('m1', 1)], []).map((m) => m._id), ['m1']);
  });

  it('ignores a row with no usable timestamp rather than guessing', () => {
    assert.deepEqual(carryOverLiveArrivals([{ _id: 'mx' }], [msg('m1', 1)]), []);
  });
});
