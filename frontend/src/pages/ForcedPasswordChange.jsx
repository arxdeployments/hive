import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { KeyRound, Loader2, LogOut } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../contexts/AuthContext';
import { FloatingInput } from '../components/common/FloatingInput';
import client, { refreshSession, sessionRejected, setSignOutReason } from '../api/client';
import {
  MIN_PASSWORD_LENGTH,
  changePasswordErrorMessage,
  passwordChangeProblem,
  settleSessionAfterChangeElsewhere,
} from '../lib/passwordChange';
import { rebindPushAfterReset } from '../lib/pwa';

/**
 * The only screen an account with a pending password change can reach (batch 73).
 *
 * An admin reset leaves the account on a temporary password the admin has seen,
 * and the API now refuses it everywhere until its owner picks a new one. App.jsx
 * renders this in place of the whole session — no socket, no conversation list,
 * no call overlays, no push — so nothing here may reach for any of that either:
 * no avatar (that is a GET under /api/media), no profile fetch beyond /me.
 * The one exception is the push re-bind below, and it runs only after /me has
 * said the flag is clear, when the API has stopped refusing the account.
 *
 * WHY THE SUBMIT IS THREE REQUESTS
 *
 * 1. GET /api/auth/me first. change-password is one of the credential paths
 *    client.js never refreshes for, because its 401 means "wrong current
 *    password". So if the 15-minute access cookie lapsed while the user read the
 *    email with their temporary password in it, posting straight away would come
 *    back 401 and be reported as a mistyped password that was typed perfectly.
 *    /me is an ordinary protected route: its 401 refreshes and replays, so after
 *    it the access cookie is fresh — or the session really is over and client.js
 *    has already sent them to sign in, which is the right outcome too.
 *    Its answer is read, not just awaited (batch 73 review): if the flag is
 *    already clear, the password was changed in another tab or on another
 *    device, the temporary password is no longer the current one, and posting it
 *    would only be refused as wrong. The account is usable, so the screen lets
 *    the user in without posting anything — as iOS does.
 * 2. POST /api/auth/change-password, which verifies the temporary password,
 *    clears the flag, and — when this session predates the reset — issues a fresh
 *    one so finishing here does not sign them out a quarter of an hour later.
 * 3. GET /api/auth/me again, and leave this screen only if the SERVER now says
 *    must_change_password is false. Clearing the flag locally on the strength of
 *    a 200 would let the app back in on the client's word, and the first request
 *    it made would be refused and bring the user straight back here.
 *
 * WHY PUSH IS RE-BOUND ON THE WAY OUT
 *
 * The reset deleted this account's push_subscriptions rows on the server, but
 * the browser still holds its subscription, so RealtimeSession's heal finds one
 * and never sends it again: Settings shows push on and nothing arrives (batch 73
 * review). Both exits from this screen therefore re-register it first. It is
 * fired and forgotten — it never throws, and a push problem must never keep
 * somebody out of the app they have just earned their way back into.
 */
export default function ForcedPasswordChange() {
  const { user, logout, updateUser } = useAuth();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState('');

  /**
   * Whether this session outlived a password change made somewhere else.
   *
   * The first /me can report the change already made, and WHERE it was made
   * decides what happens next (CodeRabbit, review of 1fbc1de; iOS asks the same
   * question in AuthStore.releaseAfterChangeElsewhere). Another tab in this
   * browser shares the cookie jar, so its change kept or re-issued this very
   * session. Another device's change revoked this browser's refresh token: /me
   * still answers on the 15-minute access cookie, and letting the user in would
   * end at that cookie's expiry as an unexplained "session expired". One refresh
   * tells the two apart. Refused, the session is over and the user is told why;
   * undelivered, nothing was learned, so they stay here and can try again.
   *
   * @returns {Promise<boolean>} true to let the user in
   */
  const sessionSurvivedChangeElsewhere = async () => {
    const verdict = await settleSessionAfterChangeElsewhere(refreshSession, sessionRejected);
    if (verdict.outcome === 'survived') return true;
    if (verdict.outcome === 'ended') {
      setSignOutReason('password_changed');
      await logout();
      navigate('/login');
    } else {
      setError(verdict.message);
    }
    return false;
  };

  /**
   * Validate the form, then run the three-request sequence described above: /me,
   * change-password, /me again. The user is let in only when /me itself says the
   * flag is clear; otherwise the error is shown here, unless a change made on
   * another device has ended the session (sessionSurvivedChangeElsewhere).
   */
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting || signingOut) return;
    const problem = passwordChangeProblem({ current, next, confirm });
    if (problem) {
      setError(problem);
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      let before = null;
      try {
        ({ data: before } = await client.get('/api/auth/me'));
      } catch (err) {
        setError(err?.response
          ? 'Could not confirm your session. Please try again.'
          : 'Could not reach the server. Check your connection and try again.');
        return;
      }
      if (before?.must_change_password === false) {
        // Changed already, in another tab or on another device (batch 73 review).
        // Posting the temporary password now would be refused as wrong and tell
        // the user they mistyped a password that has simply stopped being theirs.
        // Strictly `=== false`: a body without the field says nothing, and the
        // change goes ahead as normal.
        if (!(await sessionSurvivedChangeElsewhere())) return;
        rebindPushAfterReset();
        toast.info('Your password was already changed');
        updateUser(before);
        return;
      }

      try {
        await client.post('/api/auth/change-password', {
          current_password: current,
          new_password: next,
        });
      } catch (err) {
        setError(changePasswordErrorMessage(err));
        return;
      }

      let confirmed = null;
      try {
        ({ data: confirmed } = await client.get('/api/auth/me'));
      } catch {
        confirmed = null;
      }
      if (confirmed?.must_change_password !== false) {
        // The password HAS changed by now, so sending the form again would post
        // the old temporary password as the current one and be told it is wrong.
        // A reload asks /me afresh, which is the one thing still missing.
        setError('Your password was changed, but the server has not confirmed it yet. Reload the page to continue.');
        return;
      }
      // Before the gate opens, and not awaited — see WHY PUSH IS RE-BOUND above.
      rebindPushAfterReset();
      toast.success('Password changed');
      // From the server's own answer, not a local edit: App.jsx's gate reads this
      // and puts the normal routes back.
      updateUser(confirmed);
    } finally {
      setSubmitting(false);
    }
  };

  /** Sign out from the forced screen and go to /login, ignoring repeat clicks. */
  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      navigate('/login');
    } finally {
      setSigningOut(false);
    }
  };

  const busy = submitting || signingOut;

  // Scrolls itself. index.css locks html, body and #root to the viewport with
  // overflow hidden (the chat needs that), so a centred card taller than a phone
  // screen — three fields, the explanation and two buttons — was simply cut off
  // top and bottom with no way to reach Sign out. The backdrop is fixed so it
  // does not scroll away with the form.
  return (
    <div
      data-testid="forced-password-screen"
      className="relative flex-1 min-h-0 overflow-y-auto bg-[#0A0A0A]"
    >
      <div className="pointer-events-none fixed inset-0 opacity-60"
        style={{
          background: `
            radial-gradient(600px circle at 20% 20%, rgba(16,185,129,0.15), transparent 55%),
            radial-gradient(700px circle at 80% 30%, rgba(16,185,129,0.08), transparent 60%),
            radial-gradient(800px circle at 50% 90%, rgba(255,255,255,0.03), transparent 60%)
          `,
        }}
      />
      <div className="pointer-events-none fixed inset-0 bg-[#0A0A0A]/40" />

      <div className="relative z-10 min-h-full flex items-center justify-center py-8">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
        className="w-full max-w-md mx-4"
      >
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-8 shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)]">
          <div className="text-center mb-6">
            <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-[#10B981]/10 border border-[#10B981]/30 flex items-center justify-center">
              <KeyRound size={22} className="text-[#10B981]" />
            </div>
            <h1 className="text-xl font-semibold text-[#F5F5F5]">Choose a new password</h1>
            {user?.email && (
              <p className="text-xs text-[#525252] mt-1">Signed in as {user.email}</p>
            )}
          </div>

          <div className="mb-5 px-4 py-3 rounded-[6px] bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[13px] text-[#F59E0B] leading-relaxed">
            Your administrator reset your password. Enter the temporary password
            they gave you, then choose a new one that only you know. You can use
            RxHive again as soon as it is changed.
          </div>

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <FloatingInput
              label="Temporary password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              disabled={busy}
              data-testid="forced-current-password"
            />
            <FloatingInput
              label="New password"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              disabled={busy}
              data-testid="forced-new-password"
            />
            <FloatingInput
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              disabled={busy}
              data-testid="forced-confirm-password"
            />
            <p className="text-xs text-[#A3A3A3]">
              At least {MIN_PASSWORD_LENGTH} characters, with both letters and numbers.
            </p>

            {error && (
              <div
                role="alert"
                data-testid="forced-password-error"
                className="px-4 py-3 rounded-[6px] bg-[#EF4444]/10 border border-[#EF4444]/30 text-[13px] text-[#EF4444]"
              >
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              data-testid="forced-password-submit"
              className={`w-full h-[46px] rounded-[6px] text-sm font-medium transition-all duration-200 flex items-center justify-center
                ${busy
                  ? 'bg-[#10B981]/50 text-[#0A0A0A]/70 cursor-not-allowed'
                  : 'bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] hover:scale-[1.02] active:scale-[0.98]'
                }
              `}
            >
              {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Change password'}
            </button>
          </form>

          <button
            type="button"
            onClick={handleSignOut}
            disabled={busy}
            data-testid="forced-password-signout"
            className="mt-3 w-full h-10 flex items-center justify-center gap-2 rounded-[6px] text-sm text-[#A3A3A3] bg-[#1A1A1A] border border-[#2D2D2D] hover:text-[#F5F5F5] hover:bg-[#2D2D2D] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {signingOut ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogOut size={14} />}
            Sign out
          </button>
        </div>
      </motion.div>
      </div>
    </div>
  );
}
