/**
 * A message that arrives over the socket while a newest-page fetch is in flight is
 * not on that page. Replacing the thread with the page deleted it, and the thread
 * was then marked read. See carryOverLiveArrivals.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { carryOverLiveArrivals, heldIds, mergeByTime } from './carryOverLiveArrivals.js';
import { ARRIVED_LIVE } from '../stores/chatStore.js';

const msg = (_id, second, extra = {}) => ({
  _id,
  created_at: `2026-10-01T08:00:${String(second).padStart(2, '0')}Z`,
  ...extra,
});

/** The `_id`s of `rows`, in order, for comparing results. */
const ids = (rows) => rows.map((m) => m._id);

/** A message as the store's live paths add it: socket arrivals and this tab's own sends. */
const live = (_id, second, extra = {}) => msg(_id, second, { ...extra, [ARRIVED_LIVE]: true });

describe('carryOverLiveArrivals', () => {
  it('keeps a message that arrived after the request went out', () => {
    const existing = [msg('m1', 1), live('m3-live', 3)];
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
    const existing = [msg('m1', 1), live('m4-mine', 4, { status: 'sent' })];
    const fetched = [msg('m1', 1)];

    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m1', 'temp-4']))), ['m4-mine']);
  });

  it('keeps live arrivals when the page is empty', () => {
    assert.deepEqual(ids(carryOverLiveArrivals([live('m1', 1)], [], new Set())), ['m1']);
  });

  it('keeps a distinct message that shares the page\'s newest timestamp', () => {
    // Date has millisecond precision, so two messages can parse to the same time
    // (CodeRabbit, PR #111).
    const existing = [msg('m2', 2), live('m2-twin', 2)];
    const fetched = [msg('m1', 1), msg('m2', 2)];

    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m2']))), ['m2-twin']);
  });

  it('keeps an arrival stamped before the page\'s newest row', () => {
    // The server stamps created_at before it commits, so a media send stamped
    // first can commit after a later-stamped message, and after the page was read.
    // Batch 72's timestamp rule dropped it, and the thread was marked read
    // (review of PR #112).
    const existing = [msg('m1', 1), msg('m3', 3), live('m2-late', 2)];
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

  it('does not carry history paged in while the request was out', () => {
    // A scroll up during a jump prepends older rows: new ids, but older than the
    // page. Carried as arrivals they were stitched under the newest page
    // (CodeRabbit, review of 1fbc1de).
    const existing = [msg('h1', 0), msg('h2', 0), msg('m1', 1), live('m2-live', 2)];
    const fetched = [msg('m1', 1), msg('m3', 3)];

    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m1']))), ['m2-live']);
  });

  it('leaves a row older than the whole page to paging back, keeping the history cursor', () => {
    // A late-committed message older than the page's oldest row merged to the top,
    // and loadMore pages back from the top row: everything between that message
    // and the page was skipped (CodeRabbit, review of 70495a4).
    const existing = [msg('m5', 5), live('m0-late', 0)];
    const fetched = [msg('m2', 2), msg('m5', 5)];
    const carried = carryOverLiveArrivals(existing, fetched, new Set(['m5']));
    assert.deepEqual(carried, []);
    assert.equal(mergeByTime(fetched, carried)[0]._id, 'm2', 'the page no longer starts the window');
  });

  it('keeps an arrival anywhere inside the page, even above every row the thread held', () => {
    // The thread held one recent row; the page reaches further back. An arrival
    // stamped inside the page's range belongs to it, wherever it sat (CodeRabbit,
    // review of 70495a4, against the old position rule).
    const existing = [live('m3-late', 3), msg('m8', 8)];
    const fetched = [msg('m1', 1), msg('m8', 8)];
    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['m8']))), ['m3-late']);
  });

  it('tells paged history from an arrival when both share the page\'s millisecond', () => {
    // A system-message batch is stamped a microsecond apart, so paged-in history
    // can share the page's oldest millisecond and pass any time bound. Only the
    // store's live marker separates the two (CodeRabbit, review of 83e02cc).
    const stamp = (i) => `2026-10-01T08:00:00.412${String(i).padStart(3, '0')}Z`;
    const pagedIn = { _id: 'sys-older', created_at: stamp(0) };
    const arrival = { _id: 'arrived', created_at: stamp(3), [ARRIVED_LIVE]: true };
    const fetched = [{ _id: 'sys-1', created_at: stamp(1) }, { _id: 'sys-2', created_at: stamp(2) }];
    const existing = [pagedIn, fetched[0], fetched[1], arrival];
    assert.deepEqual(ids(carryOverLiveArrivals(existing, fetched, new Set(['sys-1', 'sys-2']))), ['arrived']);
  });

  it('carries only what the store marked as arriving live', () => {
    const existing = [msg('m1', 1), msg('unmarked', 3), live('marked', 3)];
    assert.deepEqual(ids(carryOverLiveArrivals(existing, [msg('m1', 1)], new Set(['m1']))), ['marked']);
  });

  it('carries every new row when the thread held nothing', () => {
    assert.deepEqual(ids(carryOverLiveArrivals([live('a', 1), live('b', 2)], [], new Set())), ['a', 'b']);
  });
});

describe('mergeByTime', () => {
  it('places an arrival among the page by time, leaving the page in its order', () => {
    const fetched = [msg('m1', 1), msg('m3', 3)];
    assert.deepEqual(ids(mergeByTime(fetched, [live('m2-late', 2)])), ['m1', 'm2-late', 'm3']);
  });

  it('keeps the page first on a tie, and puts later or undated arrivals last', () => {
    const fetched = [msg('m2', 2)];
    assert.deepEqual(ids(mergeByTime(fetched, [msg('twin', 2)])), ['m2', 'twin']);
    assert.deepEqual(ids(mergeByTime(fetched, [msg('m9', 9)])), ['m2', 'm9']);
    assert.deepEqual(ids(mergeByTime(fetched, [{ _id: 'undated' }])), ['m2', 'undated']);
  });

  it('returns the page itself when nothing arrived', () => {
    const fetched = [msg('m1', 1)];
    assert.equal(mergeByTime(fetched, []), fetched);
  });
});
