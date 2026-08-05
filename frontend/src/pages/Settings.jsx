import { useState, useEffect } from 'react';
import { ArrowLeft, Bell, BellOff, Keyboard, Type, Lock, Eye, EyeOff } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { PageTransition } from '../components/common/PageTransition';
import client from '../api/client';
import { enablePushNotifications, disablePushNotifications } from '../lib/pwa';

const FONT_PX = { small: '14px', medium: '16px', large: '18px' };
const FONT_SCALE = { small: 0.9, medium: 1, large: 1.12 };

// Apply the chosen font size app-wide by scaling the root <html> font-size
// (drives rem-based Tailwind sizing) plus a CSS var / body class hook.
export function applyFontSize(size) {
  const key = FONT_PX[size] ? size : 'medium';
  const root = document.documentElement;
  root.style.fontSize = FONT_PX[key];
  root.style.setProperty('--rx-font-scale', String(FONT_SCALE[key]));
  document.body.classList.remove('font-small', 'font-medium', 'font-large');
  document.body.classList.add(`font-${key}`);
}

const extractError = (err, fallback) => {
  const d = err?.response?.data;
  if (!d) return fallback;
  if (typeof d.detail === 'string') return d.detail;
  if (Array.isArray(d.detail) && d.detail[0]?.msg) return d.detail[0].msg;
  if (typeof d.message === 'string') return d.message;
  return fallback;
};

// Track 36x20 with a 16px knob and a 2px inset — the standard compact switch,
// and the same geometry as InfoPanelPrimitives' Switch so the app has one
// answer for what a toggle looks like.
//
// Sized in PIXELS, not rem. It was `w-10 h-5` (2.5rem x 1.25rem) with the knob
// offset by a hard-coded `left: 22px`, so the track scaled with the root
// font-size — which this very page changes, via the Appearance setting — while
// the knob's travel did not. The two drifted apart: at Small the knob pushed
// past the track's right edge, and the whole control grew out of proportion with
// the rows around it. A switch is chrome, not body text; it should not resize
// with the message font at all.
const TRACK_W = 36;
const TRACK_H = 20;
const KNOB = 16;
const INSET = (TRACK_H - KNOB) / 2;

const Toggle = ({ checked, onChange, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={!!checked}
    aria-label={label}
    onClick={() => onChange(!checked)}
    style={{ width: TRACK_W, height: TRACK_H }}
    className={`relative shrink-0 rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-[#10B981]/40 ${
      checked ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'
    }`}
  >
    <span
      aria-hidden="true"
      style={{
        width: KNOB,
        height: KNOB,
        top: INSET,
        left: INSET,
        // Travel is derived, so the knob can never overshoot the track however
        // the constants above are tuned.
        transform: `translateX(${checked ? TRACK_W - KNOB - INSET * 2 : 0}px)`,
      }}
      className="absolute rounded-full bg-white shadow-sm transition-transform duration-200"
    />
  </button>
);

export default function SettingsPage() {
  const navigate = useNavigate();
  const [notifSound, setNotifSound] = useState(() => localStorage.getItem('rxhive_notif_sound') !== 'false');
  const [desktopNotif, setDesktopNotif] = useState(() => localStorage.getItem('rxhive_desktop_notif') !== 'false');
  const [notifBusy, setNotifBusy] = useState(false);
  const [enterSends, setEnterSends] = useState(() => localStorage.getItem('rxhive_enter_sends') !== 'false');
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('rxhive_font_size') || 'medium');

  // Change password
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswords, setShowPasswords] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  useEffect(() => { localStorage.setItem('rxhive_notif_sound', notifSound); }, [notifSound]);
  useEffect(() => { localStorage.setItem('rxhive_desktop_notif', desktopNotif); }, [desktopNotif]);
  useEffect(() => { localStorage.setItem('rxhive_enter_sends', enterSends); }, [enterSends]);

  // Persist AND apply the font size (runs on mount too, so the setting takes effect app-wide).
  useEffect(() => {
    localStorage.setItem('rxhive_font_size', fontSize);
    applyFontSize(fontSize);
  }, [fontSize]);

  /**
   * Desktop notifications toggle.
   *
   * This used to only flip a localStorage flag and request permission — it never
   * subscribed. enablePushNotifications() had ZERO call sites in the entire repo,
   * so pushManager.subscribe() never ran, no PushSubscription row was ever
   * created, and the server's push fan-out always short-circuited on an empty
   * subscription set. The toggle read as "on" while push was completely inert.
   *
   * Optimistic with rollback: if subscribing throws (unsupported browser, denied
   * permission, VAPID not provisioned server-side) the switch goes back off
   * rather than lying about the state. The thrown message is shown verbatim
   * because each one is separately actionable.
   *
   * Called straight from the toggle's onChange so Notification.requestPermission()
   * still runs inside the user gesture — Safari rejects it otherwise.
   */
  const handleDesktopNotif = async (val) => {
    if (notifBusy) return;
    setNotifBusy(true);
    setDesktopNotif(val);
    try {
      if (val) {
        await enablePushNotifications();
        toast.success('Desktop notifications enabled');
      } else {
        await disablePushNotifications();
        toast.success('Desktop notifications disabled');
      }
    } catch (err) {
      setDesktopNotif(!val);
      toast.error(err?.message || 'Could not change notification settings');
    } finally {
      setNotifBusy(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      toast.error('Enter your current and new password');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('New passwords do not match');
      return;
    }
    if (newPassword === currentPassword) {
      toast.error('New password must be different from the current one');
      return;
    }
    setChangingPassword(true);
    try {
      await client.post('/api/auth/change-password', {
        current_password: currentPassword,
        new_password: newPassword,
      });
      toast.success('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      toast.error(extractError(err, 'Failed to change password'));
    } finally {
      setChangingPassword(false);
    }
  };

  const pwInputClass =
    'w-full h-10 pl-10 pr-10 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#525252] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all';

  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      <div className="max-w-[500px] mx-auto p-6">
        <button onClick={() => navigate('/chat')}
          data-testid="settings-back"
          className="flex items-center gap-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] mb-6 transition-colors">
          <ArrowLeft size={16} /> Back to Chat
        </button>

        {/* Sign out is NOT here. It lives in the profile drawer, which is the
            account surface — one home for it, not two. */}
        <h1 className="text-2xl font-bold text-[#F5F5F5] mb-8">Settings</h1>

        <PageTransition>
          <div className="space-y-8">
            {/* Notifications */}
            <section>
              <h2 className="text-sm font-medium text-[#A3A3A3] uppercase tracking-wider mb-4">Notifications</h2>
              <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] divide-y divide-[#1F1F1F]">
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <Bell size={18} className="text-[#A3A3A3]" />
                    <div><p className="text-sm text-[#F5F5F5]">Notification Sound</p>
                      <p className="text-xs text-[#525252]">Play a sound for new messages</p></div>
                  </div>
                  <Toggle checked={notifSound} onChange={setNotifSound} label="Notification sound" />
                </div>
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <BellOff size={18} className="text-[#A3A3A3]" />
                    <div><p className="text-sm text-[#F5F5F5]">Desktop Notifications</p>
                      <p className="text-xs text-[#525252]">Show browser notifications</p></div>
                  </div>
                  <Toggle checked={desktopNotif} onChange={handleDesktopNotif} label="Desktop notifications" />
                </div>
              </div>
            </section>

            {/* Chat */}
            <section>
              <h2 className="text-sm font-medium text-[#A3A3A3] uppercase tracking-wider mb-4">Chat</h2>
              <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Keyboard size={18} className="text-[#A3A3A3]" />
                    <div><p className="text-sm text-[#F5F5F5]">Enter Key Sends Message</p>
                      <p className="text-xs text-[#525252]">{enterSends ? 'Enter sends, Shift+Enter for new line' : 'Enter for new line, Ctrl+Enter sends'}</p></div>
                  </div>
                  <Toggle checked={enterSends} onChange={setEnterSends} label="Enter key sends message" />
                </div>
              </div>
            </section>

            {/* Appearance */}
            <section>
              <h2 className="text-sm font-medium text-[#A3A3A3] uppercase tracking-wider mb-4">Appearance</h2>
              <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-4">
                <div className="flex items-center gap-3 mb-3">
                  <Type size={18} className="text-[#A3A3A3]" />
                  <p className="text-sm text-[#F5F5F5]">Message Font Size</p>
                </div>
                <div className="flex gap-2">
                  {[{ key: 'small', label: 'Small' }, { key: 'medium', label: 'Medium' }, { key: 'large', label: 'Large' }].map(opt => (
                    <button key={opt.key} onClick={() => setFontSize(opt.key)}
                      data-testid={`font-size-${opt.key}`}
                      className={`flex-1 py-2 rounded-[6px] text-sm transition-colors ${
                        fontSize === opt.key ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30' : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3]'
                      }`}>{opt.label}</button>
                  ))}
                </div>
              </div>
            </section>

            {/* Security */}
            <section>
              <h2 className="text-sm font-medium text-[#A3A3A3] uppercase tracking-wider mb-4">Security</h2>
              <form onSubmit={handleChangePassword}
                className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <Lock size={18} className="text-[#A3A3A3]" />
                    <div><p className="text-sm text-[#F5F5F5]">Change Password</p>
                      <p className="text-xs text-[#525252]">Update the password you use to sign in</p></div>
                  </div>
                  <button type="button" onClick={() => setShowPasswords(s => !s)}
                    className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
                    aria-label={showPasswords ? 'Hide passwords' : 'Show passwords'}>
                    {showPasswords ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>

                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
                  <input
                    type={showPasswords ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Current password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    data-testid="current-password"
                    className={pwInputClass}
                  />
                </div>

                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
                  <input
                    type={showPasswords ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="New password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    data-testid="new-password"
                    className={pwInputClass}
                  />
                </div>

                <div className="relative">
                  <Lock size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
                  <input
                    type={showPasswords ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    data-testid="confirm-password"
                    className={pwInputClass}
                  />
                </div>

                <button
                  type="submit"
                  disabled={changingPassword}
                  data-testid="change-password-submit"
                  className="w-full h-10 rounded-[6px] bg-[#10B981] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors">
                  {changingPassword ? 'Updating…' : 'Update Password'}
                </button>
              </form>
            </section>

            {/* About */}
            <section className="text-center pt-4">
              <p className="text-xs text-[#525252]">RxHive v1.0</p>
              <p className="text-xs text-[#525252] mt-1">Enterprise Messaging Platform</p>
            </section>
          </div>
        </PageTransition>
      </div>
    </div>
  );
}
