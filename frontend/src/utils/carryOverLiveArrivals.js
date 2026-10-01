/**
 * The messages a newest-page replace must not delete because they arrived while
 * its fetch was in flight.
 *
 * fetchMessages replaces the conversation's array with the page it fetched. The
 * server chose that page when the request reached it, so a message committed after
 * that — and delivered over the socket, which appends it to the open thread — is
 * newer than everything on the page and not on it. The replace deleted it, and then
 * the thread was marked read: the sender saw Read on a message the thread no longer
 * showed. CodeRabbit raised it against batch 71's web port of parity item 34.
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
 * @returns {Array<object>} the server messages from `existing` that are newer than
 *   every row in `fetched` and absent from it, in their existing order.
 */
export function carryOverLiveArrivals(existing, fetched) {
  const page = fetched || [];
  const onPage = new Set(page.map((m) => m._id));
  const times = page.map((m) => Date.parse(m.created_at)).filter(Number.isFinite);
  const newest = times.length ? Math.max(...times) : -Infinity;
  return (existing || []).filter((m) => (
    m._id
    && !LOCAL_ONLY_STATUSES.has(m.status)
    && !onPage.has(m._id)
    && Date.parse(m.created_at) > newest
  ));
}
