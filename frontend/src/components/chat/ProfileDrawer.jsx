import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Pencil, Camera, Mail, Building2, FolderTree, LogOut } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import client from '../../api/client';
import { transcodeImage } from '../../utils/mediaQuality';
import { toast } from 'sonner';
import { useModalDialog } from '../../hooks/useModalDialog';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

export const ProfileDrawer = ({ isOpen, onClose }) => {
  const { user, checkAuth, logout } = useAuth();
  const navigate = useNavigate();
  const [signingOut, setSigningOut] = useState(false);
  const { titleId, dialogProps } = useModalDialog({ isOpen, onClose });

  const handleSignOut = async () => {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await logout();
      toast.success('Signed out');
      navigate('/login');
    } finally {
      // Not reset on success — the route change unmounts this — but a failed
      // logout still clears local state, so the button must not stay stuck.
      setSigningOut(false);
    }
  };
  const [profile, setProfile] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [editingAbout, setEditingAbout] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAbout, setNewAbout] = useState('');

  useEffect(() => {
    if (isOpen && user) {
      client.get('/api/auth/me').then(r => setProfile(r.data)).catch(() => {});
    }
  }, [isOpen, user]);

  const handleSaveName = async () => {
    if (!newName.trim()) return;
    try {
      const { data } = await client.put('/api/users/profile', { display_name: newName.trim() });
      setProfile(prev => ({ ...prev, name: data.display_name, display_name: data.display_name }));
      setEditingName(false);
      toast.success('Name updated');
      checkAuth();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to update'); }
  };

  const handleSaveAbout = async () => {
    try {
      const { data } = await client.put('/api/users/profile', { about: newAbout.trim() });
      setProfile(prev => ({ ...prev, about: data.about }));
      setEditingAbout(false);
      toast.success('About updated');
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed to update'); }
  };

  const handleAvatarUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // The SECOND raw upload path, and the worse of the two: it had no size
      // check at all, so a 40 MB photo was pushed at the server and only bounced
      // by the backend limit. Routed through the same transcode the composer
      // uses, at Standard — an avatar is displayed at 96px and there is nothing
      // an HD original buys here.
      const outgoing = await transcodeImage(file, 'standard');
      const formData = new FormData();
      formData.append('file', outgoing);
      // Cookie-authenticated upload via the shared client (no Bearer token exists).
      const { data: uploadData } = await client.post('/api/upload', formData);
      if (uploadData.file_url) {
        await client.put('/api/users/profile', { avatar_url: uploadData.file_url });
        setProfile(prev => ({ ...prev, avatar_url: uploadData.file_url }));
        toast.success('Avatar updated');
        checkAuth();
      }
    } catch { toast.error('Failed to upload avatar'); }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
        <motion.div
          initial={{ x: '-100%' }} animate={{ x: 0 }} exit={{ x: '-100%' }}
          transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
          onClick={(e) => e.stopPropagation()}
          {...dialogProps}
          className="absolute left-0 top-0 h-full w-full sm:w-[360px] bg-[#0F0F0F] border-r border-[#1F1F1F] shadow-2xl overflow-y-auto outline-none"
          data-testid="profile-drawer"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F1F1F]">
            <h3 id={titleId} className="text-base font-semibold text-[#F5F5F5]">Profile</h3>
            <button onClick={onClose} aria-label="Close profile"
              className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] transition-colors">
              <X size={18} />
            </button>
          </div>

          <div className="p-6 space-y-6">
            {/* Avatar */}
            <div className="flex justify-center">
              {/* The wrapping label is the only affordance here — unlike the
                  composer's file inputs, which have their own visible buttons and
                  are correctly `hidden`. `display: none` therefore took this input
                  out of the tab order and left avatar upload mouse-only, so it is
                  visually hidden but focusable instead, and the camera scrim now
                  answers focus the way it answers hover (as MessageBubble's menu
                  trigger does). Named explicitly because the label's own contents
                  are an alt="" image or a single initial. */}
              <label className="relative cursor-pointer group rounded-full focus-within:ring-2 focus-within:ring-[#10B981] focus-within:ring-offset-2 focus-within:ring-offset-[#0F0F0F]">
                <div className="w-[120px] h-[120px] rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-4xl font-bold overflow-hidden">
                  {profile?.avatar_url ? (
                    <img src={profile.avatar_url.startsWith('http') ? profile.avatar_url : `${backendUrl}${profile.avatar_url}`}
                      alt="" className="w-full h-full object-cover" />
                  ) : (
                    (profile?.name || user?.name || 'U').charAt(0).toUpperCase()
                  )}
                </div>
                <div className="absolute inset-0 rounded-full bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <Camera size={24} className="text-white" />
                </div>
                <input type="file" accept="image/*" aria-label="Change profile photo"
                  className="sr-only" onChange={handleAvatarUpload} />
              </label>
            </div>

            {/* Name */}
            <div>
              {/* The caption lives inside each branch. Hoisted out, its `for`
                  pointed at an input that only exists while editing, so for most
                  of this drawer's life it named nothing. */}
              {editingName ? (
                <>
                  <label htmlFor="profiledrawer-01-display-name" className="text-xs text-[#A3A3A3] mb-1.5 block">Display Name</label>
                  <input id="profiledrawer-01-display-name" type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingName(false); }}
                    autoFocus maxLength={50}
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none" />
                </>
              ) : (
                <>
                  <p className="text-xs text-[#A3A3A3] mb-1.5">Display Name</p>
                  <div className="flex items-center justify-between">
                    <p className="text-lg text-[#F5F5F5]">{profile?.name || user?.name}</p>
                    <button onClick={() => { setNewName(profile?.name || user?.name || ''); setEditingName(true); }}
                      aria-label="Edit display name"
                      className="p-1.5 text-[#A3A3A3] hover:text-[#10B981] transition-colors">
                      <Pencil size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* About */}
            <div>
              {editingAbout ? (
                <>
                  <label htmlFor="profiledrawer-02-about" className="text-xs text-[#A3A3A3] mb-1.5 block">About</label>
                  <textarea id="profiledrawer-02-about" value={newAbout} onChange={(e) => setNewAbout(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSaveAbout(); } if (e.key === 'Escape') setEditingAbout(false); }}
                    autoFocus maxLength={140} rows={2}
                    className="w-full px-4 py-2 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none resize-none" />
                </>
              ) : (
                <>
                  <p className="text-xs text-[#A3A3A3] mb-1.5">About</p>
                  <div className="flex items-center justify-between">
                    <p className="text-sm text-[#A3A3A3]">{profile?.about || "Hey there! I'm using RxHive"}</p>
                    <button onClick={() => { setNewAbout(profile?.about || ''); setEditingAbout(true); }}
                      aria-label="Edit about"
                      className="p-1.5 text-[#A3A3A3] hover:text-[#10B981] transition-colors">
                      <Pencil size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* Info */}
            <div className="space-y-3 pt-4 border-t border-[#1F1F1F]">
              <div className="flex items-center gap-3">
                <Mail size={16} className="text-[#A3A3A3]" />
                <div>
                  <p className="text-xs text-[#A3A3A3]">Email</p>
                  <p className="text-sm text-[#F5F5F5]">{profile?.email || user?.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <Building2 size={16} className="text-[#A3A3A3]" />
                <div>
                  <p className="text-xs text-[#A3A3A3]">Organization</p>
                  <p className="text-sm text-[#F5F5F5]">{profile?.org_name || 'N/A'}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <FolderTree size={16} className="text-[#A3A3A3]" />
                <div>
                  <p className="text-xs text-[#A3A3A3]">Department</p>
                  <p className="text-sm text-[#F5F5F5]">{profile?.dept_name || 'N/A'}</p>
                </div>
              </div>
            </div>

            {/* Sign out.
                Also on the Settings page. Deliberate duplication rather than an
                oversight: this drawer is the account surface — it is where your
                name, photo and organization live — and signing out is an account
                action, so people look for it here first. The two share no state;
                each owns its own in-flight flag. */}
            <div className="pt-4 mt-4 border-t border-[#1F1F1F]">
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                data-testid="profile-logout-button"
                className="w-full flex items-center justify-center gap-2 h-10 rounded-[6px] border border-[#EF4444]/40 text-[#EF4444] hover:bg-[#EF4444]/10 disabled:opacity-50 text-sm font-medium transition-colors"
              >
                <LogOut size={16} />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
