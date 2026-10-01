/**
 * A message that arrives over the socket while a newest-page fetch is in flight is
 * not on that page. Replacing the thread with the page deleted it, and the thread
 * was then marked read. See carryOverLiveArrivals.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { carryOverLiveArrivals, heldIds } from './carryOverLiveArrivals.js';

const msg = (_id, second, extra = {}) => ({
  _id,
  created_at: `2026-10-01T08:00:${String(second).padStart(2, '0')}Z`,
  ...extra,
});

const ids = (rows) => rows.map((m) => m._id);

describe('carryOverLiveArrivals', () => {
  it('keeps a message that arrived after the request went out', () => {
    const existing = [msg('m1', 1), msg('m3-live', 3)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m1']))), ['m3-live']);
  });

  it('does not keep a message the page already carries', () => {
    const existing = [msg('m1', 1), msg('m2', 2)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched, new Set(['m1'])), []);
  });

  it('does not keep the old window\'s rows, held before the request went out', () => {
    const existing = [msg('m-older', 0), msg('m1', 1)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched, heldIds(existing)), []);
  });

  it('leaves unsent bubbles to carryOverLocalOnly', () => {
    const existing = [msg('temp-1', 9, { status: 'sending' }), msg('temp-2', 9, { status: 'failed' })];
    const fetched = [msg('m1', 1)];

    assert.deepEqual(carryOverLiveArrivals(existing, fetched, new Set()), []);
  });

  it('keeps my own send, acknowledged during the fetch, that the page does not have yet', () => {
    // The ack re-keys the bubble from its temp id to the server's.
    const existing = [msg('m1', 1), msg('m4-mine', 4, { status: 'sent' })];
    const fetched = [msg('m1', 1)];

    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m1', 'temp-4']))), ['m4-mine']);
  });

  it('keeps live arrivals when the page is empty', () => {
    assert.deepEqual(ids(carryOverLiveArrivals([msg('m1', 1)], [], new Set())), ['m1']);
  });

  it('keeps a distinct message that shares the page\'s newest timestamp', () => {
    // Date has millisecond precision, so two messages can parse to the same time
    // (CodeRabbit, PR #111).
    const existing = [msg('m2', 2), msg('m2-twin', 2)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m2']))), ['m2-twin']);
  });

  it('keeps an arrival stamped before the page\'s newest row', () => {
    // The server stamps created_at before it commits, so a media send stamped
    // first can commit after a later-stamped message, and after the page was read.
    // Batch 72's timestamp rule dropped it, and the thread was marked read
    // (review of PR #112).
    const existing = [msg('m1', 1), msg('m3', 3), msg('m2-late', 2)];
    const fetched = [msg('m1', 1), msg('m3', 3)];

    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m1']))), ['m2-late']);
  });

  it('does not carry a system-message batch\'s rows from above the page', () => {
    // One row per member, a microsecond apart: all 61 parse to the same millisecond.
    // Batch 72's at-or-after rule carried the 11 that fell off the page under its
    // newest row (review of PR #112).
    const batch = Array.from({ length: 61 }, (_, i) => ({
      _id: `s${i}`,
      created_at: `2026-10-01T08:00:00.412${String(i).padStart(3, '0')}Z`,
    }));

    assert.deepEqual(carryOverLiveArrivals(batch, batch.slice(11), heldIds(batch)), []);
  });
});
