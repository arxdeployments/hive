/**
 * Put one optimistically-removed row back, without touching anything else.
 *
 * The pattern this replaces is the usual one:
 *
 *     const previous = messages;
 *     setMessages((prev) => prev.filter((m) => m._id !== id));
 *     try { await toggle(id); } catch { setMessages(previous); }
 *
 * The removal is functional and correct. The rollback is not: it restores a
 * SNAPSHOT of the whole list taken before the click, so it also undoes
 * everything that happened in between. Two ways that bites, both reproduced:
 *
 *   Two rows unstarred quickly, the FIRST request failing after the second
 *   succeeded — the first rollback restores its snapshot, which still contains
 *   the second row, and a message the server really did un-star reappears.
 *
 *       start                         [a, b, c]
 *       optimistic unstar a           [b, c]
 *       optimistic unstar b           [c]        (b succeeds)
 *       unstar a fails, rollback      [a, b, c]  <- b is back
 *
 *   A reload landing between the click and the failure — the snapshot predates
 *   it, so the rollback throws the fresh rows away.
 *
 *       optimistic unstar a           [b]
 *       reload brings in z            [a, b, z]
 *       unstar a fails, rollback      [a, b]     <- z is gone
 *
 * Restoring the single row instead leaves every other change alone. The index
 * is where it was, so a restored row does not jump to the end of a list the
 * user is looking at; it is clamped because the list may have shortened.
 */

/**
 * @param {Array<object>} rows - the current list.
 * @param {object} row - the row that was removed optimistically.
 * @param {number} index - where it sat before removal.
 * @param {(row: object) => unknown} identify - stable id for a row.
 * @returns {Array<object>} `rows` with `row` back in place, or `rows` unchanged
 *   if it is already there or there is nothing to restore.
 */
export function restoreRemovedRow(rows, row, index, identify = (r) => r._id) {
  const current = rows || [];
  if (!row) return current;
  const id = identify(row);
  if (current.some((r) => identify(r) === id)) return current;
  const at = Math.max(0, Math.min(index, current.length));
  const next = [...current];
  next.splice(at, 0, row);
  return next;
}
