/**
 * The forced password change, batch 73: everything about it that is not React.
 *
 * WHY THIS EXISTS
 *
 * Every admin password reset set users.must_change_password, a successful
 * POST /api/auth/change-password cleared it, and nothing read it in between. The
 * admin is SHOWN the temporary password, so the account stayed fully usable with
 * a password somebody else knows, for as long as its owner never thought to
 * change it. The API now refuses an account in that state on every route except
 * the handful needed to get out of it, answering 403 with
 * `code: "PASSWORD_CHANGE_REQUIRED"`, and closes its socket with 4403. This
 * module is how the rest of the web client recognises both and says so.
 *
 * Same constraints as pushTeardown.js: nothing here reaches api/client.js — that
 * module reads `import.meta.env` at module scope, which Node's own test runner
 * cannot evaluate — and every relative import carries its `.js`, so
 * `npm run test:unit` can load this file. client.js, websocket.js and the
 * AuthProvider all import from here rather than from each other, which is also
 * what keeps the signal free of an import cycle.
 */

import { apiError } from '../utils/helpers.js';

/** The `code` the API puts beside `detail` on the 403 (CodedHTTPException). */
export const PASSWORD_CHANGE_REQUIRED = 'PASSWORD_CHANGE_REQUIRED';

/**
 * The WebSocket close code for the same refusal.
 *
 * Deliberately not 4001. Both clients answer 4001 by refreshing the session and
 * reconnecting, and a refresh SUCCEEDS for a flagged account (it has to — the
 * user still needs a session to change the password from), so a 4001 would
 * reconnect, be refused, and go round again for as long as the tab stayed open.
 */
export const PASSWORD_CHANGE_CLOSE_CODE = 4403;

/** The backend's policy (core/security.py enforce_password_policy), restated. */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_BYTES = 72;

/**
 * Whether an axios error is the API refusing this account until it changes its
 * password.
 *
 * The code is what decides. A bare 403 is still what a role or org check answers,
 * and treating every one of those as "change your password" would lock an org
 * admin who opened a superadmin page out of the whole app. The status is checked
 * as well so that only the refusal itself counts, not some other response whose
 * body happens to carry the same word.
 */
export const isPasswordChangeRequiredError = (err) =>
  err?.response?.status === 403 && err.response.data?.code === PASSWORD_CHANGE_REQUIRED;

/**
 * Who is listening for the refusal.
 *
 * A registry rather than a direct call into the AuthProvider because the two
 * places that notice it — the axios interceptor and the socket — are plain
 * modules that live outside React and are evaluated long before any provider
 * mounts. They announce; whoever owns the session decides what that means.
 */
const listeners = new Set();

/**
 * Be told whenever the API refuses this session for a pending password change.
 *
 * @param {() => void} callback
 * @returns {() => void} unsubscribe, shaped to be returned from a useEffect
 */
export function onPasswordChangeRequired(callback) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/**
 * Tell every listener. Safe to call any number of times: a screen that fires six
 * requests at once gets six refusals, and each one announces.
 *
 * A listener that throws is logged and skipped rather than allowed to stop the
 * rest, because the announcement comes from inside the axios interceptor and the
 * socket's close handler — one broken subscriber must not turn into a rejected
 * request that never reaches its caller, or a close that never finishes.
 */
export function announcePasswordChangeRequired() {
  for (const callback of [...listeners]) {
    try {
      callback();
    } catch (err) {
      console.error('[auth] password-change listener failed', err);
    }
  }
}

/** UTF-8 length, which is what bcrypt and the backend's 72-byte cap count. */
const utf8Bytes = (value) => new TextEncoder().encode(value).length;

/**
 * The first thing wrong with the forced-change form, or null if it can be sent.
 *
 * Mirrors the backend rather than inventing a stricter rule: the API is the
 * authority and re-checks all of it, so the point here is only to answer the
 * common mistakes without a round trip. Length is counted in code points, as
 * Python's `len` counts them, not in UTF-16 units — `'😀'.length` is 2 in
 * JavaScript and 1 on the server, and the two must agree about what is too short.
 * The letter class is ASCII on purpose, matching the backend's `[A-Za-z]`.
 *
 * The digit class is NOT ASCII, for the same reason (batch 73 review). Python's
 * `re.search(r"\d", ...)` on a str matches any Unicode decimal digit (category
 * Nd) — a fullwidth ３ or an Arabic-Indic ٣ counts on the server, and iOS's
 * `.decimalDigits` agrees. JavaScript's `\d` is ASCII 0-9 only, so with it this
 * form refused passwords the API and the iPhone app both accept, sending the user
 * to invent a new one for no reason. `\p{Nd}` with the `u` flag is the same
 * category the server uses.
 *
 * @param {{ current: string, next: string, confirm: string }} fields
 * @returns {string|null}
 */
export function passwordChangeProblem({ current, next, confirm }) {
  if (!current || !next || !confirm) {
    return 'Fill in all three fields.';
  }
  if (next !== confirm) {
    return 'The new passwords do not match.';
  }
  if (next === current) {
    return 'Choose a password different from your temporary one.';
  }
  if ([...next].length < MIN_PASSWORD_LENGTH) {
    return `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (utf8Bytes(next) > MAX_PASSWORD_BYTES) {
    return 'Your new password is too long.';
  }
  if (!/[A-Za-z]/.test(next) || !/\p{Nd}/u.test(next)) {
    return 'Your new password must contain both letters and numbers.';
  }
  return null;
}

/**
 * What to show when POST /api/auth/change-password fails.
 *
 * 401 is the route's answer to a wrong current password, and on this screen the
 * current password is the temporary one, so it is named that way. It cannot mean
 * a lapsed access cookie: change-password is one of the credential paths
 * client.js never refreshes for, which is why the screen proves the session with
 * GET /api/auth/me first. 400 is the backend's own sentence (the password policy,
 * or "Choose a password different from your current one.") and is shown as is.
 */
export function changePasswordErrorMessage(err) {
  const status = err?.response?.status;
  if (status === 401) return 'That temporary password is not right.';
  if (status === 429) return 'Too many attempts. Wait a minute, then try again.';
  if (status === 400) return apiError(err, 'That password was not accepted.');
  if (!err?.response) return 'Could not reach the server. Check your connection and try again.';
  return apiError(err, 'Could not change your password. Please try again.');
}

/**
 * Whether this session outlived a password change made somewhere else, asked
 * with one refresh (CodeRabbit, reviews of 1fbc1de and 70495a4).
 *
 * Another tab in the same browser shares the cookie jar, so its change kept or
 * re-issued this very session and the refresh succeeds. Another device's change
 * revoked this browser's refresh token, so the refresh is refused — and the
 * server answers that 401 without treating the revoked token as stolen, so asking
 * costs no other session. Anything else (no connection, 429, 5xx) says nothing
 * either way.
 *
 * @param {() => Promise<unknown>} refresh - POST /api/auth/refresh.
 * @param {(err: unknown) => boolean} isRejected - the server refused the session.
 * @returns {Promise<{ outcome: 'survived' | 'ended' | 'unknown', message?: string }>}
 */
export async function settleSessionAfterChangeElsewhere(refresh, isRejected) {
  try {
    await refresh();
    return { outcome: 'survived' };
  } catch (err) {
    if (isRejected(err)) return { outcome: 'ended' };
    return {
      outcome: 'unknown',
      message: err?.response
        ? 'Could not confirm your session. Please try again.'
        : 'Could not reach the server. Check your connection and try again.',
    };
  }
}
