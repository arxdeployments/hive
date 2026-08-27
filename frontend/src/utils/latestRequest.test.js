import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRequestTicket } from './latestRequest.js';

/**
 * The ordering primitive behind the admin lists, run by `npm run test:unit`.
 *
 * Nothing here touches React or the DOM. Each test models an interleaving that
 * actually happens in those pages — an out-of-order search response, an
 * imperative refresh racing an effect load, and unmount — and asserts which of
 * them is allowed to write.
 */
describe('createRequestTicket', () => {
  it('lets a lone load write', () => {
    const ticket = createRequestTicket();
    const seq = ticket.take();
    assert.equal(ticket.isCurrent(seq), true);
  });

  it('rejects the older response when a slow prefix lands after a newer query', () => {
    // The real case: "an" is typed, then "anna". "an" matches far more rows and
    // answers second. Without this, the table settles on results for "an" while
    // the box reads "anna".
    const ticket = createRequestTicket();
    const an = ticket.take();
    const anna = ticket.take();

    assert.equal(ticket.isCurrent(anna), true, 'the newest query must be allowed to write');
    assert.equal(ticket.isCurrent(an), false, 'the superseded query must not');
  });

  it('orders an imperative refresh against an effect load, in both directions', () => {
    // A refresh fired after create is not inside any effect, so a per-effect flag
    // never covered it. It has to supersede, and be superseded by, effect loads.
    const ticket = createRequestTicket();

    const beforeCreate = ticket.take();
    const afterCreateRefresh = ticket.take();
    assert.equal(
      ticket.isCurrent(beforeCreate), false,
      'a load started before the create must not overwrite the refresh that followed it',
    );
    assert.equal(ticket.isCurrent(afterCreateRefresh), true);

    const keystroke = ticket.take();
    assert.equal(
      ticket.isCurrent(afterCreateRefresh), false,
      'the refresh must itself be superseded by a newer filter change',
    );
    assert.equal(ticket.isCurrent(keystroke), true);
  });

  it('disowns everything in flight on invalidate, without starting a load', () => {
    const ticket = createRequestTicket();
    const inFlight = ticket.take();
    ticket.invalidate();

    assert.equal(ticket.isCurrent(inFlight), false, 'unmount must stop a late setState');
    // And the next real load still works — invalidate is not a terminal state.
    const next = ticket.take();
    assert.equal(ticket.isCurrent(next), true);
  });

  it('keeps tickets from separate lists independent', () => {
    // Each page owns its own counter; one list reloading must not disown another.
    const users = createRequestTicket();
    const depts = createRequestTicket();
    const userLoad = users.take();
    depts.take();
    depts.take();
    assert.equal(users.isCurrent(userLoad), true);
  });
});
