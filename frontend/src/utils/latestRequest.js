/**
 * Request ordering for a list that reloads while an earlier load is still open.
 *
 * The problem it solves, in one sentence: several loads are in flight at once and
 * nothing makes them come back in the order they were sent, so whichever response
 * lands LAST wins rather than whichever was asked for last.
 *
 * Every admin list here reloads on `[page, search, ...]`, and nothing is
 * debounced — each keystroke rewrites `search`, rebuilds the load callback and
 * re-runs the effect, so a five-character query is routinely racing the
 * two-character prefix typed before it. The short prefix matches far more rows
 * and answers slower, which is precisely the case where the loser wins: the table
 * and the "of N" total settle on a query the search box no longer contains, and
 * stay wrong until the next keystroke.
 *
 * A flag scoped to one effect run cannot cover it. That only disowns the run that
 * created it, and these lists also reload IMPERATIVELY after create, edit, bulk
 * and reset actions — calls made outside any effect, holding no flag, counting as
 * current unconditionally. One shared counter orders every call site against every
 * other one, in both directions: a slow pre-create load can no longer land after
 * the post-create refresh and drop the row just created back out of the table.
 *
 * Extracted rather than written a fourth time. pages/admin/Users.jsx had this
 * scheme inline and its three sibling lists did not, which is the same shape as
 * the two hand-rolled Math.random() password generators this directory already
 * had to consolidate: one copy gets fixed, the others keep the bug.
 */
export function createRequestTicket() {
  let current = 0;
  return {
    /** Start a load. The returned ticket is only good while it is the newest. */
    take() {
      current += 1;
      return current;
    },
    /** May this ticket's response write? False once anything newer has started. */
    isCurrent(ticket) {
      return ticket === current;
    },
    /**
     * Disown every load in flight without starting one.
     *
     * For unmount: a response that arrives after the component is gone must not
     * call setState. Also the honest way to abandon a load whose result is known
     * to be stale — a filter reset, say — without pretending a new one began.
     */
    invalidate() {
      current += 1;
    },
  };
}

export default createRequestTicket;
