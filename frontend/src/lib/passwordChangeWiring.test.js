/**
 * The wiring of the forced password change, batch 73.
 *
 * users.must_change_password was set on every admin reset, cleared by
 * change-password, and read nowhere — so an account stayed fully usable on a
 * temporary password the admin had been shown. The API now refuses such an
 * account (403 PASSWORD_CHANGE_REQUIRED, socket close 4403) and the web client
 * has to turn that into one screen and nothing else. lib/passwordChange.js holds
 * the logic and passwordChange.test.js drives it; this file pins the places that
 * logic has to be CALLED from, which is where a feature like this quietly stops
 * working while every test of the logic stays green.
 *
 * There is no component harness in this repo (no jsdom, no testing-library), so,
 * like readReceiptParity.test.js and pushEntryPoints.test.js, these read the
 * source. Comments are stripped first: several of these files discuss the very
 * calls asserted here, and a guard satisfied by its own explanation guards
 * nothing. Each assertion was checked by deleting or inverting the code it
 * guards and watching it fail.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SRC = join(import.meta.dirname, '..');
/** The text of a source file, by its path relative to `src/`. */
const read = (rel) => readFileSync(join(SRC, rel), 'utf8');

/** The source from `start` up to and including the next `closer`. */
function block(source, start, closer) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `not found: ${start}`);
  const to = source.indexOf(closer, from + start.length);
  assert.notEqual(to, -1, `no end for: ${start}`);
  return source.slice(from, to + closer.length);
}

/** Lines of `source` that are code, not comments, trimmed. */
const code = (source) => source.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/**') && !l.startsWith('{/*'));

/** Index of the first code line containing `needle`, or -1. */
const lineWith = (lines, needle) => lines.findIndex((l) => l.includes(needle));

describe('App.jsx: the session is gated on the flag', () => {
  const app = read('App.jsx');
  const shell = code(block(app, 'function App() {', '\nexport default App;'));

  it('wraps the socket, every call overlay and <Routes> in the gate, and leaves the Toaster outside', () => {
    const open = shell.indexOf('<PasswordChangeGate>');
    const close = shell.indexOf('</PasswordChangeGate>');
    assert.ok(open !== -1 && close !== -1, 'App renders no PasswordChangeGate');
    for (const inside of [
      '<RealtimeSession />',
      '<IncomingCallOverlay />',
      '<OutgoingCallScreen />',
      '<ActiveCallView />',
      '<MinimizedCallBanner />',
      '<CallAudioSink />',
      '<CallConnectivityWatcher />',
      '<Routes>',
      '</Routes>',
    ]) {
      const at = shell.indexOf(inside);
      assert.ok(at !== -1, `${inside} is no longer rendered by App`);
      assert.ok(open < at && at < close,
        `${inside} renders outside the password gate, so it runs for an account the API is refusing`);
    }
    // Exactly once each: a second copy outside the gate would undo the first.
    assert.equal(shell.filter((l) => l === '<RealtimeSession />').length, 1);
    assert.equal(shell.filter((l) => l === '<Routes>').length, 1);

    const toaster = lineWith(shell, '<Toaster');
    assert.ok(toaster > close, 'the Toaster is inside the gate: the forced screen cannot toast, and opening the gate drops toasts');
  });

  it('renders only the forced screen while the flag is set, and the session otherwise', () => {
    const gate = code(block(app, 'const PasswordChangeGate = ({ children }) => {', '\n};'));
    assert.ok(gate.includes('const required = Boolean(user?.must_change_password);'), 'the gate does not read the flag');
    assert.ok(gate.includes('if (!required || callInProgress) return children;'),
      'the gate does not hand back the session when nothing is required, or drops it under a live call');
    assert.ok(gate.includes('return <ForcedPasswordChange />;'), 'the gate never renders the forced screen');
    assert.ok(gate.indexOf('if (!required || callInProgress) return children;') < gate.indexOf('return <ForcedPasswordChange />;'));
  });

  it('ends a call in progress before the session unmounts', () => {
    const gate = code(block(app, 'const PasswordChangeGate = ({ children }) => {', '\n};'));
    assert.ok(gate.includes("const callInProgress = useCallStore((s) => s.callState !== 'idle');"),
      'the gate does not watch the call, so it unmounts the session over a live one');
    assert.ok(gate.includes('if (required && callInProgress) endCallForPasswordChange();'),
      'a call live when the gate closes is left running with no hang-up control on screen');
  });

  it('hangs up properly: leaves LiveKit, signals only over an open socket, and resets the call store', () => {
    const end = code(block(app, 'function endCallForPasswordChange() {', '\n}'));
    const idle = end.indexOf("if (call.callState === 'idle') return;");
    const leave = end.indexOf('livekitClient.leave();');
    const signal = end.indexOf('if (hasLiveCall(call) && call.callId && wsClient.isOpen()) {');
    const send = end.indexOf('wsClient.send({ type, call_id: call.callId });');
    const reset = end.indexOf('call.resetCall();');
    assert.ok(idle !== -1, 'the teardown runs with no call at all');
    assert.ok(leave !== -1, 'the LiveKit room is not left: the microphone stays published behind the forced screen');
    assert.ok(signal !== -1,
      'the hang-up frame is sent without checking the socket — send() RECONNECTS for a call frame on a closed one');
    assert.ok(send > signal, 'the other side is never told the call ended');
    // resetCall, not endCall: 'ended' is not idle, and RealtimeSession only drops
    // the socket for an idle call store.
    assert.ok(reset !== -1, 'the call store is not reset, so RealtimeSession keeps the socket for it');
    assert.ok(!end.some((l) => l.includes('endCall()')), 'endCall leaves the store in "ended", which is not idle');
    assert.ok(idle < leave && leave < reset && send < reset);
    for (const frame of ["'call:cancel'", "'call:decline'", "'call:end'"]) {
      assert.ok(end.some((l) => l.includes(frame)), `${frame} is not sent for its state`);
    }
  });
});

describe('api/client.js: a coded 403 announces, and does nothing else', () => {
  const client = read('api/client.js');
  const interceptor = block(client, 'client.interceptors.response.use(', '\n);');
  const lines = code(interceptor);

  it('announces on the code and still rejects', () => {
    const branch = code(block(interceptor, 'if (isPasswordChangeRequiredError(error)) {', '\n    }'));
    assert.deepEqual(branch, [
      'if (isPasswordChangeRequiredError(error)) {',
      'announcePasswordChangeRequired();',
      'return Promise.reject(error);',
      '}',
    ], 'the PASSWORD_CHANGE_REQUIRED branch does more, or less, than announce and reject');
  });

  it('does it before, and instead of, the refresh-and-sign-out path', () => {
    const branch = lines.indexOf('if (isPasswordChangeRequiredError(error)) {');
    const refresh = lineWith(lines, 'await refreshSession();');
    const signOut = lineWith(lines, "window.location.href = '/login';");
    assert.ok(branch !== -1 && refresh !== -1 && signOut !== -1, 'the interceptor changed shape; re-check this guard');
    assert.ok(branch < refresh && branch < signOut,
      'a refused account can reach the refresh or the sign-out: it must do neither');
    assert.match(client, /import\s*\{[^}]*\bannouncePasswordChangeRequired\b[^}]*\bisPasswordChangeRequiredError\b[^}]*\}\s*from\s*'\.\.\/lib\/passwordChange'/);
  });
});

describe('services/websocket.js: a 4403 close stands the socket down', () => {
  const socket = read('services/websocket.js');
  const onClose = block(socket, '  async _onClose(event) {', '\n  }\n');
  const lines = code(onClose);

  it('stops every way back and announces, without refreshing', () => {
    const branch = code(block(onClose, 'if (event.code === PASSWORD_CHANGE_CLOSE_CODE) {', '\n    }'));
    assert.ok(branch.includes('this._intentionalClose = true;'), 'the backoff timer still reconnects after a 4403');
    assert.ok(branch.includes('this._active = false;'), 'wake() and the backoff still treat the socket as wanted after a 4403');
    assert.ok(branch.includes('announcePasswordChangeRequired();'), 'the app is never told why the socket closed');
    assert.equal(branch.at(-2), 'return;', 'a 4403 falls through into the reconnect below it');
    assert.ok(!branch.some((l) => l.includes('refreshSession') || l.includes('_scheduleReconnect') || l.includes('this.connect(')),
      'a 4403 refreshes or reconnects — which succeeds for a flagged account, and loops');
  });

  it('is decided before the 4001 refresh-and-reconnect', () => {
    const forced = lines.indexOf('if (event.code === PASSWORD_CHANGE_CLOSE_CODE) {');
    const expiry = lines.indexOf('if (event.code === 4001) {');
    const reconnect = lines.lastIndexOf('this._scheduleReconnect();');
    assert.ok(forced !== -1 && expiry !== -1 && reconnect !== -1, '_onClose changed shape; re-check this guard');
    assert.ok(forced < expiry && forced < reconnect);
    assert.match(socket, /import\s*\{[^}]*\bPASSWORD_CHANGE_CLOSE_CODE\b[^}]*\bannouncePasswordChangeRequired\b[^}]*\}\s*from\s*'\.\.\/lib\/passwordChange'/);
  });

  it('ignores a LiveKit join that fails after its call was torn down', () => {
    // Batch 73 review. The gate ends the call, then the in-flight token POST is
    // refused with the same 403 — and every onFatal ends or resets the call. Run
    // against a call that is already gone, that moved an idle store back to
    // 'ended' (holding the session up again), toasted over the forced screen, and
    // sent call:end into send()'s reconnect branch.
    const join = code(block(socket, 'function joinLiveKit(callId, context, onFatal) {', '\n}\n'));
    const guard = join.indexOf('if (useCallStore.getState().callId !== callId) {');
    const toast = join.indexOf('handleCallJoinError(err, context);');
    const fatal = join.indexOf('onFatal(err);');
    assert.ok(guard !== -1, 'a join failure is reported and acted on whether or not its call still exists');
    assert.ok(toast !== -1 && fatal !== -1, 'joinLiveKit changed shape; re-check this guard');
    assert.ok(guard < toast && guard < fatal, 'the toast or onFatal runs before the call is checked');
    const bail = join.indexOf('return;', guard);
    assert.ok(bail !== -1 && bail < toast, 'the torn-down check does not stop the failure handling');
    // Every join goes through it: one direct joinCall would skip the check.
    assert.deepEqual(code(socket).filter((l) => l.includes('.joinCall(')), ['.joinCall(callId)'],
      'websocket.js joins LiveKit somewhere other than joinLiveKit, past the torn-down check');
    for (const context of ["'resume'", "'group_started'", "'group_join'", "'accepted'"]) {
      assert.ok(code(socket).some((l) => l.startsWith('joinLiveKit(') && l.includes(context)),
        `the ${context} join no longer goes through joinLiveKit`);
    }
  });

  it('reconnects for an unsendable call frame only while the socket is wanted', () => {
    // Batch 73 review: send()'s loud branch called connect(), which sets _active
    // back to true — so a call:end for a torn-down call reopened the socket the
    // 4403 (or a sign-out) had just stood down.
    const sendBody = code(block(socket, '  send(data) {', '\n  }\n'));
    const branch = sendBody.indexOf('if (loud.includes(data.type) && this._active) {');
    const reconnect = sendBody.indexOf('this.connect();');
    assert.ok(branch !== -1, 'send() reconnects for a call frame even after the socket was stood down');
    assert.ok(reconnect > branch, 'the reconnect is not inside the guarded branch');
    assert.equal(sendBody.filter((l) => l.includes('this.connect()')).length, 1,
      'send() has a second, unguarded way to reconnect');
  });

  it('does not resume calls for a tapped notification while inactive', () => {
    const handler = code(block(socket, "if (event.data?.type !== 'rxhive:incoming-call') return;", '      });'));
    const guard = handler.indexOf('if (!this._active) return;');
    const resume = handler.indexOf('this._resumeCallState();');
    assert.ok(resume !== -1, 'the handler changed shape; re-check this guard');
    assert.ok(guard !== -1 && guard < resume,
      'a tapped call notification fetches /api/calls/active while signed out or gated');
  });
});

describe('pages/ForcedPasswordChange.jsx: the submit sequence', () => {
  const screen = read('pages/ForcedPasswordChange.jsx');
  const submit = code(block(screen, 'const handleSubmit = async (e) => {', '\n  };'));

  const FIRST_ME = "({ data: before } = await client.get('/api/auth/me'));";

  it('proves the session with /me before posting, and asks /me again after', () => {
    const firstMe = submit.indexOf(FIRST_ME);
    const change = lineWith(submit, "await client.post('/api/auth/change-password', {");
    const secondMe = lineWith(submit, "({ data: confirmed } = await client.get('/api/auth/me'));");
    assert.ok(firstMe !== -1,
      'change-password is posted without a refreshing call first, so a lapsed access cookie reads as a wrong password');
    assert.ok(change !== -1 && secondMe !== -1, 'the submit changed shape; re-check this guard');
    assert.ok(firstMe < change && change < secondMe);
  });

  it('checks the form first and leaves the forced state only on the server\'s word', () => {
    const check = lineWith(submit, 'const problem = passwordChangeProblem({ current, next, confirm });');
    const firstMe = submit.indexOf(FIRST_ME);
    assert.ok(check !== -1 && check < firstMe, 'the form is sent without the client-side checks');
    const refuse = submit.indexOf('if (problem) {');
    assert.ok(refuse > check && refuse < firstMe, 'a problem the checks found does not stop the submit');
    assert.deepEqual(submit.slice(refuse + 1, refuse + 3), ['setError(problem);', 'return;'],
      'a problem the checks found is not shown, or the submit carries on past it');
    const verdict = submit.indexOf('if (confirmed?.must_change_password !== false) {');
    const leave = submit.indexOf('updateUser(confirmed);');
    assert.ok(verdict !== -1, 'the screen leaves the forced state without /me saying the flag is clear');
    assert.ok(leave > verdict, 'the auth state is updated before the server confirmed the change');
    assert.ok(!submit.some((l) => l.includes('setMustChangePassword(false)')), 'the flag is cleared on the client\'s word');
  });

  it('re-binds push on a boot that finds a held session released, as after a reload', () => {
    // Batch 73 review: "Reload the page to continue" (a lost confirmation) left the
    // form without re-binding push, and the heal that runs after it never re-sends
    // a subscription the browser still holds.
    const auth = code(block(read('contexts/AuthContext.jsx'), '  const checkAuth = useCallback(async () => {', '\n  }, []);'));
    const held = auth.indexOf('const wasHeld = cachedUser()?.must_change_password === true;');
    const asked = auth.indexOf("const { data } = await client.get('/api/auth/me');");
    const rebind = auth.indexOf('if (wasHeld && data?.must_change_password === false) rebindPushAfterReset();');
    assert.ok(held !== -1 && held < asked, 'the held state is not read from the mirror before /me overwrites it');
    assert.ok(rebind > asked, 'a boot that finds the password changed does not re-bind push');
  });

  it('lets the user in without posting when the first /me says it was already changed', () => {
    // Batch 73 review: the answer was awaited and thrown away, so a password
    // changed in another tab or on another device posted the old temporary one
    // and reported it as mistyped. iOS enters the app with zero POSTs here
    // (PasswordChangeGateTests); so must this.
    const firstMe = submit.indexOf(FIRST_ME);
    const already = submit.indexOf('if (before?.must_change_password === false) {');
    const change = lineWith(submit, "await client.post('/api/auth/change-password', {");
    assert.ok(already !== -1, 'the first /me is not consulted, so a change made elsewhere is posted again');
    assert.ok(firstMe < already && already < change, 'the already-changed check is not between the first /me and the POST');
    const branch = submit.slice(already, submit.indexOf('}', already) + 1);
    const enter = branch.indexOf('updateUser(before);');
    assert.ok(enter !== -1, 'the already-changed branch does not let the user in on the server\'s answer');
    assert.equal(branch.at(-2), 'return;', 'the already-changed branch falls through into the POST');
    const rebind = branch.indexOf('rebindPushAfterReset();');
    assert.ok(rebind !== -1 && rebind < enter,
      'leaving through the already-changed branch does not re-bind push before the gate opens');
    // CodeRabbit, review of 1fbc1de: a change made on another device revoked this
    // browser's refresh token, so the session is proven with one refresh first.
    const proven = branch.indexOf('if (!(await sessionSurvivedChangeElsewhere())) return;');
    assert.ok(proven !== -1 && proven < rebind && proven < enter,
      'the already-changed branch lets the user in without proving the session survived the change');
  });

  it('proves the session with one refresh, and signs out saying why when it was refused', () => {
    const helper = code(block(screen, '  const sessionSurvivedChangeElsewhere = async () => {', '\n  };'));
    const refresh = helper.indexOf('await refreshSession();');
    const refused = helper.indexOf('if (sessionRejected(err)) {');
    assert.ok(refresh !== -1 && refused > refresh, 'the session is not proven by a refresh');
    const why = helper.indexOf("setSignOutReason('password_changed');");
    const out = helper.indexOf('await logout();');
    assert.ok(why > refused && out > why, 'a refused session is not signed out with the password-change reason');
    assert.ok(helper.includes("navigate('/login');"), 'a refused session stays on the forced screen');
    assert.match(read('pages/Login.jsx'), /password_changed: 'Your password was changed\. Sign in with your new password\.'/,
      'the sign-in page has no sentence for this reason');
  });

  it('re-binds push once the server confirms the change, before the gate opens, without waiting on it', () => {
    // Batch 73 review: the reset deleted the server's push rows but the browser
    // kept its subscription, so the heal never re-sent it and push stayed dead.
    const verdict = submit.indexOf('if (confirmed?.must_change_password !== false) {');
    const leave = submit.indexOf('updateUser(confirmed);');
    const rebind = submit.lastIndexOf('rebindPushAfterReset();');
    assert.ok(rebind !== -1, 'a completed change never re-binds push');
    assert.ok(verdict < rebind && rebind < leave,
      'push is re-bound before the server confirmed the change, or after the gate has opened');
    assert.equal(submit.filter((l) => l.includes('rebindPushAfterReset(')).length, 2,
      'the re-bind is missing from one exit, or runs somewhere else as well');
    assert.ok(!submit.some((l) => l.includes('await rebindPushAfterReset')),
      'the submit waits on the re-bind, so a slow push service holds the user on this screen');
    assert.match(screen, /import\s*\{\s*rebindPushAfterReset\s*\}\s*from\s*'\.\.\/lib\/pwa'/);
  });

  it('touches nothing the gate keeps closed', () => {
    const body = code(screen);
    for (const forbidden of ['/api/media', 'avatar', '/api/conversations', '/api/calls', 'wsClient']) {
      assert.ok(!body.some((l) => l.includes(forbidden)), `the forced screen reaches for ${forbidden}`);
    }
  });

  it('carries the test ids the e2e spec drives', () => {
    for (const id of [
      'forced-password-screen', 'forced-current-password', 'forced-new-password', 'forced-confirm-password',
      'forced-password-submit', 'forced-password-signout', 'forced-password-error',
    ]) {
      assert.ok(screen.includes(`data-testid="${id}"`), `missing data-testid="${id}"`);
    }
  });
});

describe('lib/pwa.js: the post-reset re-bind is wired to the real helpers', () => {
  // The rules are tested in pushRestore.test.js against injected fakes, which
  // proves nothing if the binder hands them the wrong things.
  const binder = code(block(read('lib/pwa.js'), 'export async function rebindPushAfterReset() {', '\n}\n'));

  it('passes the real preference, permission, subscribe and teardown', () => {
    for (const wiring of [
      'return rebindPushSubscription({',
      'pushSupported: pushSupported(),',
      "getPermission: () => (typeof Notification === 'undefined' ? 'default' : Notification.permission),",
      'wantsPush: wantsDesktopNotifications,',
      'subscribe: subscribeToPush,',
      'tearDown: () => tearDownPush({ nav: navigator, api: client }),',
    ]) {
      assert.ok(binder.includes(wiring), `rebindPushAfterReset no longer passes: ${wiring}`);
    }
  });
});

describe('contexts/AuthContext.jsx: the announcement moves the session', () => {
  const auth = read('contexts/AuthContext.jsx');
  const lines = code(auth);

  it('subscribes for the life of the provider', () => {
    assert.ok(lines.includes(
      'useEffect(() => onPasswordChangeRequired(() => setMustChangePassword(true)), [setMustChangePassword]);',
    ), 'nothing listens for the refusal, so a 403 or a 4403 changes nothing on screen');
  });

  it('sets the flag in state and in the localStorage mirror, and only on a signed-in user', () => {
    const setter = code(block(auth, 'const setMustChangePassword = useCallback((required) => {', '\n  }, []);'));
    assert.ok(setter.includes('if (!prev || Boolean(prev.must_change_password) === required) return prev;'),
      'an announcement with nobody signed in invents a user, or every repeat costs a render');
    assert.ok(setter.includes("localStorage.setItem('user', JSON.stringify(next));"),
      'the mirror is not updated, so an offline boot forgets the flag and renders the app');
    const update = code(block(auth, 'const updateUser = useCallback((next) => {', '\n  }, []);'));
    assert.ok(update.includes("localStorage.setItem('user', JSON.stringify(next));"));
    assert.ok(update.includes('setUser(next);'));
    assert.ok(lineWith(lines, 'updateUser, setMustChangePassword }}>') !== -1, 'the provider does not expose them');
  });
});

describe('admin reset surfaces say what happens next', () => {
  const NEXT = 'They will be asked to choose a new password the next time they sign in.';

  for (const page of ['pages/admin/Users.jsx', 'pages/OrgAdmin/OrgAdminUsers.jsx']) {
    it(`${page} tells the admin the user must choose a new password`, () => {
      const source = read(page);
      // Twice: the toast that fades, and the panel that stays.
      assert.ok(source.split(NEXT).length - 1 >= 2, `${page} does not say the user will have to change it`);
    });
  }

  it('the org-admin portal will not reset the admin\'s own password', () => {
    const lines = code(read('pages/OrgAdmin/OrgAdminUsers.jsx'));
    assert.ok(lines.includes('const isSelf = Boolean(editUser && me?.id && editUser._id === me.id);'),
      'the drawer cannot tell the admin\'s own row from anyone else\'s');
    assert.ok(lines.includes('<button onClick={handleResetPw} disabled={isSelf}'),
      'Reset Password stays live on the admin\'s own row, inviting the 400');
  });
});
