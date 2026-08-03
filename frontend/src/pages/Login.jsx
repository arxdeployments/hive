import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../contexts/AuthContext';
import { FloatingInput } from '../components/common/FloatingInput';
import { takeSignOutReason } from '../api/client';

/**
 * Why the previous session ended, if it ended rather than being left.
 *
 * Landing on a blank login form with no explanation is the whole complaint this
 * answers: the user cannot tell whether they were signed out, timed out, or the
 * app broke. Read once and cleared, so a later deliberate visit to /login is
 * not haunted by a stale notice.
 */
const SIGNOUT_COPY = {
  expired: 'Your session expired. Please sign in again.',
  inactive: 'Your account is no longer active. Contact your administrator.',
};

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [signedOutReason, setSignedOutReason] = useState(null);
  const { login } = useAuth();

  useEffect(() => { setSignedOutReason(takeSignOutReason()); }, []);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const user = await login(email, password);
      // Silent login - no toast needed
      if (user.role === 'superadmin') {
        navigate('/admin');
      } else {
        navigate('/chat');
      }
    } catch (err) {
      const status = err.response?.status;
      const detail = err.response?.data?.detail;

      if (status === 429) {
        toast.error('Too many attempts. Try again in 60 seconds.');
        setError('rate_limited');
      } else if (status === 401) {
        // The server's own wording when it gives one — a 401 from /login can
        // also mean "Account is deactivated", which is not a typo the user can
        // fix by retyping their password.
        toast.error(detail || 'Invalid email or password');
        setError('invalid');
      } else {
        toast.error('Something went wrong. Please try again.');
        setError('server');
      }
    } finally {
      setLoading(false);
    }
  };

  const isDisabled = !email || !password || loading;

  return (
    <div className="relative min-h-screen bg-[#0A0A0A] overflow-hidden flex items-center justify-center">
      {/* Animated gradient background */}
      <div className="absolute inset-0 opacity-60"
        style={{
          background: `
            radial-gradient(600px circle at 20% 20%, rgba(16,185,129,0.15), transparent 55%),
            radial-gradient(700px circle at 80% 30%, rgba(16,185,129,0.08), transparent 60%),
            radial-gradient(800px circle at 50% 90%, rgba(255,255,255,0.03), transparent 60%)
          `,
          animation: 'gradientMove 18s ease-in-out infinite alternate',
        }}
      />
      <div className="absolute inset-0 bg-[#0A0A0A]/40" />

      <style>{`
        @keyframes gradientMove {
          0% { background-position: 0% 0%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 100%; }
        }
      `}</style>

      {/* Login Card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative z-10 w-full max-w-md mx-4"
      >
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-8 shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)]">
          {/* Logo */}
          <div className="text-center mb-8">
            <h1
              className="text-4xl font-bold text-[#F5F5F5] tracking-tight"
              style={{ textShadow: '0 0 40px rgba(16,185,129,0.3)' }}
            >
              RxHive
            </h1>
            <p className="text-[#A3A3A3] text-sm mt-2">Enterprise Messaging</p>
          </div>

          {signedOutReason && (
            <div
              data-testid="signout-notice"
              className="mb-5 px-4 py-3 rounded-[6px] bg-[#F59E0B]/10 border border-[#F59E0B]/30 text-[13px] text-[#F59E0B]"
            >
              {SIGNOUT_COPY[signedOutReason] || SIGNOUT_COPY.expired}
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-5">
            <FloatingInput
              label="Email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={error === 'invalid'}
              disabled={loading}
              data-testid="login-email-input"
            />

            <FloatingInput
              label="Password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={error === 'invalid'}
              disabled={loading}
              data-testid="login-password-input"
            />

            <button
              type="submit"
              disabled={isDisabled}
              data-testid="login-submit-button"
              className={`w-full h-[46px] rounded-[6px] text-sm font-medium transition-all duration-200 flex items-center justify-center
                ${isDisabled
                  ? 'bg-[#10B981]/50 text-[#0A0A0A]/70 cursor-not-allowed'
                  : 'bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] hover:scale-[1.02] active:scale-[0.98]'
                }
              `}
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
