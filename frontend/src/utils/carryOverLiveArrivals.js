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
  const onPage = new Set((fetched || []).map((m) => m._id));
  return (existing || []).filter((m) => (
    m._id
    && !LOCAL_ONLY_STATUSES.has(m.status)
    && !onPage.has(m._id)
    && !heldAtRequest.has(m._id)
  ));
}

/** The ids `messages` holds now, for `carryOverLiveArrivals` once the page lands. */
export function heldIds(messages) {
  return new Set((messages || []).map((m) => m._id));
}
