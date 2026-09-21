/**
 * The rollback half of an optimistic remove.
 *
 * StarredSection removed a row functionally and rolled back with a snapshot of
 * the whole list, taken before the click. Both reproduced against that code:
 *
 *   Two un-stars in quick succession, the FIRST failing after the second
 *   succeeded — the first rollback restores a snapshot that still contains the
 *   second row, and a message the server really did un-star comes back.
 *
 *   A reload landing between the click and the failure — the snapshot predates
 *   it, so the rollback throws the fetched rows away.
 *
 * Restoring the single row leaves every other change in place.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { restoreRemovedRow } from './restoreRemovedRow.js';

const ids = (rows) => rows.map((r) => r._id).join(',');

describe('restoreRemovedRow puts back one row and nothing else', () => {
  it('restores it where it was, not at the end', () => {
    const rows = [{ _id: 'a' }, { _id: 'c' }];
    assert.equal(ids(restoreRemovedRow(rows, { _id: 'b' }, 1)), 'a,b,c');
  });

  it('keeps another row that was un-starred meanwhile', () => {
    // The snapshot rollback resurrected it: [a,b,c] -> remove a -> remove b ->
    // a fails -> restore [a,b,c], and b is back despite succeeding.
    const afterBoth = [{ _id: 'c' }];
    const restored = restoreRemovedRow(afterBoth, { _id: 'a' }, 0);
    assert.equal(ids(restored), 'a,c');
  });

  it('keeps rows a reload brought in while the request was in flight', () => {
    const afterReload = [{ _id: 'b' }, { _id: 'z' }];
    assert.equal(ids(restoreRemovedRow(afterReload, { _id: 'a' }, 0)), 'a,b,z');
  });

  it('does nothing when the row is already back', () => {
    // A reload that re-fetched it, say. Restoring again would show it twice.
    const rows = [{ _id: 'a' }, { _id: 'b' }];
    assert.equal(restoreRemovedRow(rows, { _id: 'a' }, 0), rows);
  });

  it('does nothing when there was no row to restore', () => {
    const rows = [{ _id: 'a' }];
    assert.equal(restoreRemovedRow(rows, null, 0), rows);
  });

  it('clamps an index the list has since outgrown', () => {
    // splice() already clamps a too-large index, so these two pass either way —
    // they are here to document the shape, not to prove the clamp.
    assert.equal(ids(restoreRemovedRow([{ _id: 'x' }], { _id: 'a' }, 9)), 'x,a');
    assert.equal(ids(restoreRemovedRow([], { _id: 'a' }, 4)), 'a');
  });

  it('treats a negative index as the front, not as an offset from the end', () => {
    // This is the case the clamp is actually for. splice(-1, 0, row) counts
    // BACKWARDS, so an unclamped -1 would drop the row second-to-last instead
    // of first — and -1 is exactly what findIndex returns when it misses.
    assert.equal(ids(restoreRemovedRow([{ _id: 'x' }, { _id: 'y' }], { _id: 'a' }, -1)), 'a,x,y');
  });

  it('tolerates a missing list', () => {
    assert.equal(ids(restoreRemovedRow(undefined, { _id: 'a' }, 0)), 'a');
  });
});

/**
 * Wiring, in the style of components/chat/chatRequestOrdering.test.js. The rule
 * being right is worth nothing if the component stops calling it, and there is
 * no component harness here to mount StarredSection in.
 */
describe('StarredSection uses both rules', () => {
  const source = () =>
    readFileSync(
      join(import.meta.dirname, '..', 'components', 'chat', 'info', 'StarredSection.jsx'),
      'utf8',
    );

  it('rolls back through the helper, not a snapshot', () => {
    assert.match(source(), /restoreRemovedRow\(/, 'StarredSection no longer restores the row.');
    assert.doesNotMatch(
      source(),
      /const previous = messages;/,
      'the whole-list snapshot is back; it undoes anything that happened in flight.',
    );
  });

  it('orders its loads through the shared ticket', () => {
    // The same race MediaLinksDocsSection next door was fixed for: switching
    // conversations leaves one thread's starred messages under another's header.
    const src = source();
    assert.match(src, /import\s*\{[^}]*\bcreateRequestTicket\b[^}]*\}\s*from/, 'no request ticket.');
    assert.match(src, /\.take\(\)/, 'nothing takes a ticket, so nothing is ordered.');
    assert.match(
      src,
      /isCurrent\(ticket\)\)\s*return;\s*(?:\/\/[^\n]*\n\s*)*setMessages\(data/,
      'the success path writes without checking its ticket is still current.',
    );
  });
});
