/**
 * The messages a newest-page replace must not delete because they arrived while
 * its fetch was in flight.
 *
 * fetchMessages replaces the conversation's array with the page it fetched. The
 * server chose that page when the request reached it, so a message committed after
 * that — and delivered over the socket, which appends it to the open thread — is
 * not on it. The replace deleted it, and then the thread was marked read: the
 * sender saw Read on a message the thread no longer showed. CodeRabbit raised it
 * against batch 71's web port of parity item 34.
 *
 * Decided by identity, not by time: a row the thread did NOT hold when the request
 * went out arrived meanwhile, so it is kept unless the page has it. A row it DID
 * hold was on the server by then, so the page has it if it is newer than the
 * page's oldest row, and otherwise it is the old window, which the page replaces.
 *
 * Batch 72 compared timestamps (at or after the page's newest), and review of
 * PR #112 found both ways that is wrong:
 *  - The server stamps created_at before it commits (services/messaging.py,
 *    send_message), so a media send stamped before the page's newest row can
 *    commit after the page was read. Its time said "older"; it was dropped, and
 *    the thread marked read.
 *  - A system-message batch (group create, add members) stamps one row per member
 *    a microsecond apart, and Date keeps milliseconds. With more than a page of
 *    them, the rows that fell off the page compared EQUAL to its newest and were
 *    carried under it: "You created the group" drawn below the newest message.
 *
 * A new id is not always an arrival, though, and the page's own range tells them
 * apart: an arrival is never older than the page's oldest row. Anything older is
 * history — rows paged in while the request was out (prependMessages, from a scroll
 * up during a jump), or a message so late-committed that it predates the whole
 * page — and paging back brings it in, in its place. Carried as an arrival, older
 * history was stitched under the newest page (CodeRabbit, review of 1fbc1de), and
 * a row older than the page merged to the very top, where loadMore takes the
 * oldest row as its `before` cursor and would have skipped everything between the
 * two (CodeRabbit, review of 70495a4). Bounded by the page, every kept arrival
 * merges after the page's first row, so that cursor stays the page's own.
 *
 * Kept arrivals are placed among the page's rows by time (`mergeByTime`), not
 * stacked after them: a send stamped before the page's newest row but committed
 * after the page was read belongs between them, where the server will put it.
 *
 * iOS keeps the same rows (ChatStore.threadAfterFetch, "live rows"); this is that
 * rule for the web, beside carryOverLocalOnly, which keeps what the server has
 * never seen at all.
 *
 * Not for a jump's slice: rows newer than a slice of old history are the old
 * newest end of the thread, not live arrivals, and stitching them on would draw
 * one list with an invisible gap. Callers pass that case nothing.
 */
const LOCAL_ONLY_STATUSES = new Set(['sending', 'failed']);

/**
 * @param {Array<object>} existing - the window being replaced, oldest first.
 * @param {Array<object>} fetched - the newest page the server returned, oldest first.
 * @param {Set<string>} heldAtRequest - the ids the thread held when the request
 *   went out.
 * @returns {Array<object>} the server messages from `existing` that arrived after
 *   the request went out and are absent from `fetched`, in their existing order.
 */
export function carryOverLiveArrivals(existing, fetched, heldAtRequest) {
  const page = fetched || [];
  const onPage = new Set(page.map((m) => m._id));
  // The page's oldest instant; -Infinity for an empty page, which bounds nothing.
  const times = page.map((m) => Date.parse(m.created_at)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : -Infinity;
  return (existing || []).filter((m) => (
    m._id
    && !LOCAL_ONLY_STATUSES.has(m.status)
    && !onPage.has(m._id)
    && !heldAtRequest.has(m._id)
    // Not older than the page: anything older is history (see above). An undated
    // row is not judged by a time it does not have.
    && !(Date.parse(m.created_at) < oldest)
  ));
}

/**
 * `fetched` with `arrivals` placed among its rows in time order, oldest first.
 *
 * Each arrival goes after the last row that is not later than it, so equal times
 * keep the page's own rows first, and the page's order (the server's, by
 * created_at and id) is never disturbed: only the arrivals move.
 *
 * @param {Array<object>} fetched - the page, oldest first.
 * @param {Array<object>} arrivals - from carryOverLiveArrivals, in held order.
 * @returns {Array<object>}
 */
export function mergeByTime(fetched, arrivals) {
  if (!arrivals.length) return fetched;
  const out = [...fetched];
  for (const m of arrivals) {
    const at = Date.parse(m.created_at);
    let i = out.length;
    if (Number.isFinite(at)) {
      while (i > 0 && Date.parse(out[i - 1].created_at) > at) i -= 1;
    }
    out.splice(i, 0, m);
  }
  return out;
}

/** The ids `messages` holds now, for `carryOverLiveArrivals` once the page lands. */
export function heldIds(messages) {
  return new Set((messages || []).map((m) => m._id));
}
