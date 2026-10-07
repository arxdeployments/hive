import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  MAX_PASSWORD_BYTES,
  MIN_PASSWORD_LENGTH,
  PASSWORD_CHANGE_CLOSE_CODE,
  PASSWORD_CHANGE_REQUIRED,
  announcePasswordChangeRequired,
  changePasswordErrorMessage,
  isPasswordChangeRequiredError,
  onPasswordChangeRequired,
  passwordChangeProblem,
  settleSessionAfterChangeElsewhere,
} from './passwordChange.js';

/**
 * Run by Node's own test runner (`npm run test:unit`). Nothing here touches the
 * DOM.
 *
 * Batch 73: an admin reset sets must_change_password and the API now refuses the
 * account everywhere else until it is cleared. The client side of that has three
 * pure parts worth pinning down — recognising the refusal (and ONLY the refusal),
 * passing it from the modules that see it to the provider that acts on it, and
 * the form's own checks — and they are all here.
 */

/** A minimal axios-shaped error carrying a response status and body. */
const axiosError = (status, data) => ({ response: { status, data } });

describe('the wire contract', () => {
  it('uses the code and close code the backend sends', () => {
    // Restated rather than imported from anywhere: these are the two values the
    // backend, the iOS client and this one were all built against, and a typo in
    // either is a refusal nobody recognises.
    assert.equal(PASSWORD_CHANGE_REQUIRED, 'PASSWORD_CHANGE_REQUIRED');
    assert.equal(PASSWORD_CHANGE_CLOSE_CODE, 4403);
    // Never the auth-expiry close: both clients refresh and reconnect on 4001,
    // which succeeds for a flagged account and would loop.
    assert.notEqual(PASSWORD_CHANGE_CLOSE_CODE, 4001);
    assert.equal(MIN_PASSWORD_LENGTH, 10);
    assert.equal(MAX_PASSWORD_BYTES, 72);
  });
});

describe('isPasswordChangeRequiredError', () => {
  it('recognises the coded 403', () => {
    assert.equal(
      isPasswordChangeRequiredError(
        axiosError(403, { detail: 'You must change your password before continuing.', code: PASSWORD_CHANGE_REQUIRED }),
      ),
      true,
    );
  });

  it('ignores a 403 without the code — a role or org refusal must not lock the app', () => {
    assert.equal(isPasswordChangeRequiredError(axiosError(403, { detail: 'Superadmin access required' })), false);
    assert.equal(isPasswordChangeRequiredError(axiosError(403, { code: 'SOMETHING_ELSE' })), false);
  });

  it('ignores the code on any other status', () => {
    assert.equal(isPasswordChangeRequiredError(axiosError(401, { code: PASSWORD_CHANGE_REQUIRED })), false);
    assert.equal(isPasswordChangeRequiredError(axiosError(400, { code: PASSWORD_CHANGE_REQUIRED })), false);
  });

  it('survives errors with no response or no body', () => {
    assert.equal(isPasswordChangeRequiredError(new Error('Network Error')), false);
    assert.equal(isPasswordChangeRequiredError({ response: { status: 403 } }), false);
    assert.equal(isPasswordChangeRequiredError({ response: { status: 403, data: null } }), false);
    assert.equal(isPasswordChangeRequiredError(undefined), false);
    assert.equal(isPasswordChangeRequiredError(null), false);
  });
});

describe('the announcement registry', () => {
  it('calls every subscriber, once per announcement', () => {
    const a = mock.fn();
    const b = mock.fn();
    const offA = onPasswordChangeRequired(a);
    const offB = onPasswordChangeRequired(b);
    try {
      announcePasswordChangeRequired();
      announcePasswordChangeRequired();
      assert.equal(a.mock.callCount(), 2);
      assert.equal(b.mock.callCount(), 2);
    } finally {
      offA();
      offB();
    }
  });

  it('stops calling a subscriber once it unsubscribes', () => {
    const a = mock.fn();
    const off = onPasswordChangeRequired(a);
    announcePasswordChangeRequired();
    off();
    announcePasswordChangeRequired();
    assert.equal(a.mock.callCount(), 1);
    // An effect cleanup returns this; React ignores the value, but a second call
    // (StrictMode runs cleanups twice in development) must be harmless.
    assert.doesNotThrow(off);
    assert.equal(off(), undefined);
  });

  it('keeps going past a subscriber that throws', () => {
    // The announcement runs inside the axios interceptor and the socket's close
    // handler. A broken listener must not swallow the rest.
    const errorLog = mock.method(console, 'error', () => {});
    const after = mock.fn();
    const offBad = onPasswordChangeRequired(() => {
      throw new Error('boom');
    });
    const offAfter = onPasswordChangeRequired(after);
    try {
      assert.doesNotThrow(() => announcePasswordChangeRequired());
      assert.equal(after.mock.callCount(), 1);
      assert.equal(errorLog.mock.callCount(), 1);
    } finally {
      offBad();
      offAfter();
      errorLog.mock.restore();
    }
  });

  it('tells the subscribers present when it was made, not ones added during it', () => {
    // A listener that subscribes another mid-announcement must not have that one
    // fire for an event it was not registered for.
    const late = mock.fn();
    let offLate = null;
    const offEarly = onPasswordChangeRequired(() => {
      if (!offLate) offLate = onPasswordChangeRequired(late);
    });
    try {
      announcePasswordChangeRequired();
      assert.equal(late.mock.callCount(), 0);
      announcePasswordChangeRequired();
      assert.equal(late.mock.callCount(), 1);
    } finally {
      offEarly();
      offLate?.();
    }
  });

  it('tolerates a subscriber that unsubscribes while being called', () => {
    const calls = [];
    let offFirst = null;
    offFirst = onPasswordChangeRequired(() => {
      calls.push('first');
      offFirst();
    });
    const offSecond = onPasswordChangeRequired(() => calls.push('second'));
    try {
      announcePasswordChangeRequired();
      announcePasswordChangeRequired();
      assert.deepEqual(calls, ['first', 'second', 'second']);
    } finally {
      offSecond();
    }
  });
});

describe('passwordChangeProblem', () => {
  const ok = { current: 'Temp-Pass-123', next: 'BrandNew2026x', confirm: 'BrandNew2026x' };

  it('accepts a password the backend would accept', () => {
    assert.equal(passwordChangeProblem(ok), null);
    // Exactly the minimum, and exactly the byte cap.
    assert.equal(passwordChangeProblem({ ...ok, next: 'abcdefghi1', confirm: 'abcdefghi1' }), null);
    const atCap = `${'a'.repeat(MAX_PASSWORD_BYTES - 1)}1`;
    assert.equal(passwordChangeProblem({ ...ok, next: atCap, confirm: atCap }), null);
  });

  it('wants all three fields', () => {
    for (const blank of ['current', 'next', 'confirm']) {
      assert.equal(passwordChangeProblem({ ...ok, [blank]: '' }), 'Fill in all three fields.', blank);
    }
    assert.equal(passwordChangeProblem({ current: undefined, next: undefined, confirm: undefined }), 'Fill in all three fields.');
  });

  it('wants the confirmation to match', () => {
    assert.equal(passwordChangeProblem({ ...ok, confirm: 'BrandNew2026y' }), 'The new passwords do not match.');
  });

  it('refuses the temporary password as the new one', () => {
    // The whole point of the screen: someone else knows the temporary password.
    assert.equal(
      passwordChangeProblem({ current: 'Temp-Pass-123', next: 'Temp-Pass-123', confirm: 'Temp-Pass-123' }),
      'Choose a password different from your temporary one.',
    );
  });

  it('enforces the minimum length, counted the way the server counts it', () => {
    assert.equal(
      passwordChangeProblem({ ...ok, next: 'abcdefgh1', confirm: 'abcdefgh1' }),
      `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    // Nine code points that are sixteen UTF-16 units. JavaScript's .length says
    // 16 and would wave this through; Python's len says 9 and refuses it.
    const astral = `${'\u{1F600}'.repeat(7)}a1`;
    assert.equal([...astral].length, 9);
    assert.ok(astral.length >= MIN_PASSWORD_LENGTH);
    assert.equal(
      passwordChangeProblem({ ...ok, next: astral, confirm: astral }),
      `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  });

  it('enforces the 72-byte cap in UTF-8 bytes, not characters', () => {
    const tooLong = `${'a'.repeat(MAX_PASSWORD_BYTES)}1`;
    assert.equal(passwordChangeProblem({ ...ok, next: tooLong, confirm: tooLong }), 'Your new password is too long.');
    // 30 characters, but each é is two bytes: 60 + 13 = 73 bytes.
    const accented = `${'\u00e9'.repeat(30)}abcdefghijkl1`;
    assert.ok([...accented].length < MAX_PASSWORD_BYTES);
    assert.equal(passwordChangeProblem({ ...ok, next: accented, confirm: accented }), 'Your new password is too long.');
  });

  it('wants letters and numbers', () => {
    const noDigit = 'abcdefghijkl';
    const noLetter = '1234567890123';
    const neither = '!!!!!!!!!!!!';
    for (const pw of [noDigit, noLetter, neither]) {
      assert.equal(
        passwordChangeProblem({ ...ok, next: pw, confirm: pw }),
        'Your new password must contain both letters and numbers.',
        pw,
      );
    }
    // ASCII letters only, like the backend's [A-Za-z]: an accented letter alone
    // does not count, so the client must not promise the server will take it.
    const accentedOnly = `${'\u00e9'.repeat(10)}1`;
    assert.equal(
      passwordChangeProblem({ ...ok, next: accentedOnly, confirm: accentedOnly }),
      'Your new password must contain both letters and numbers.',
    );
  });

  it('counts any Unicode decimal digit, the way the server and iOS do', () => {
    // Batch 73 review: the backend's re.search(r"\d") on a str matches every
    // Unicode Nd digit, and iOS checks .decimalDigits, so both accept these. An
    // ASCII-only /\d/ here refused them, stopping a password the API would take.
    for (const digit of ['\uff13', '\u0663', '\u0969']) { // fullwidth 3, Arabic-Indic 3, Devanagari 3
      const pw = `abcdefghij${digit}`;
      assert.equal(passwordChangeProblem({ ...ok, next: pw, confirm: pw }), null, `U+${digit.codePointAt(0).toString(16)}`);
    }
    // Still a digit, not just any number-like character: a superscript or a Roman
    // numeral is No/Nl, not Nd, and Python's \d does not match those either.
    for (const notDigit of ['\u00b2', '\u2163']) { // superscript 2, Roman numeral four
      const pw = `abcdefghij${notDigit}`;
      assert.equal(
        passwordChangeProblem({ ...ok, next: pw, confirm: pw }),
        'Your new password must contain both letters and numbers.',
        `U+${notDigit.codePointAt(0).toString(16)}`,
      );
    }
  });

  it('reports the first problem, in the order the form reads', () => {
    // Blank beats everything else, mismatch beats length.
    assert.equal(passwordChangeProblem({ current: '', next: 'a', confirm: 'b' }), 'Fill in all three fields.');
    assert.equal(passwordChangeProblem({ current: 'x', next: 'a', confirm: 'b' }), 'The new passwords do not match.');
    assert.equal(passwordChangeProblem({ current: 'a', next: 'a', confirm: 'a' }), 'Choose a password different from your temporary one.');
  });
});

describe('changePasswordErrorMessage', () => {
  it('names a 401 as the temporary password being wrong', () => {
    assert.equal(
      changePasswordErrorMessage(axiosError(401, { detail: 'Current password is incorrect' })),
      'That temporary password is not right.',
    );
  });

  it('shows a 400 detail verbatim', () => {
    assert.equal(
      changePasswordErrorMessage(axiosError(400, { detail: 'Choose a password different from your current one.' })),
      'Choose a password different from your current one.',
    );
    assert.equal(
      changePasswordErrorMessage(axiosError(400, { detail: 'Password must contain both letters and numbers' })),
      'Password must contain both letters and numbers',
    );
    // A 400 with no usable sentence still says something.
    assert.equal(changePasswordErrorMessage(axiosError(400, {})), 'That password was not accepted.');
  });

  it('names a 429 as too many attempts', () => {
    assert.equal(
      changePasswordErrorMessage(axiosError(429, { detail: 'Too many requests' })),
      'Too many attempts. Wait a minute, then try again.',
    );
  });

  it('tells a dropped request from a refusal', () => {
    assert.equal(
      changePasswordErrorMessage(new Error('Network Error')),
      'Could not reach the server. Check your connection and try again.',
    );
  });

  it('falls back to a string for anything else', () => {
    assert.equal(changePasswordErrorMessage(axiosError(500, {})), 'Could not change your password. Please try again.');
    // A validation list is collapsed to its readable half, never rendered whole.
    assert.equal(
      changePasswordErrorMessage(axiosError(422, { detail: [{ loc: ['body'], msg: 'Field required', type: 'missing' }] })),
      'Field required',
    );
  });
});

describe('settleSessionAfterChangeElsewhere', () => {
  // The forced screen asks this when the first /me shows the password already
  // changed (CodeRabbit, reviews of 1fbc1de and 70495a4).
  const rejected = (err) => err?.response?.status === 401 || err?.response?.status === 403;
  const failingWith = (err) => () => Promise.reject(err);

  it('lets a session in when its refresh succeeds', async () => {
    assert.deepEqual(await settleSessionAfterChangeElsewhere(() => Promise.resolve({}), rejected), { outcome: 'survived' });
  });

  it('ends a session whose refresh is refused', async () => {
    for (const status of [401, 403]) {
      const verdict = await settleSessionAfterChangeElsewhere(failingWith({ response: { status } }), rejected);
      assert.deepEqual(verdict, { outcome: 'ended' }, `a ${status} did not end the session`);
    }
  });

  it('decides nothing when the refresh could not be answered, and says which', async () => {
    const noConnection = await settleSessionAfterChangeElsewhere(failingWith(new Error('Network Error')), rejected);
    assert.equal(noConnection.outcome, 'unknown');
    assert.match(noConnection.message, /Could not reach the server/);
    for (const status of [429, 502]) {
      const verdict = await settleSessionAfterChangeElsewhere(failingWith({ response: { status } }), rejected);
      assert.equal(verdict.outcome, 'unknown', `a ${status} ended or kept the session`);
      assert.match(verdict.message, /Could not confirm your session/);
    }
  });

  it('asks exactly once', async () => {
    const refresh = mock.fn(() => Promise.resolve({}));
    await settleSessionAfterChangeElsewhere(refresh, rejected);
    assert.equal(refresh.mock.callCount(), 1);
  });
});
