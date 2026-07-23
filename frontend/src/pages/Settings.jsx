import React, { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Bell, BellOff, Keyboard, Type } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { PageTransition } from '../components/common/PageTransition';

const Toggle = ({ checked, onChange }) => (
  <button onClick={() => onChange(!checked)}
    className={`w-10 h-5 rounded-full transition-colors ${checked ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'} relative`}>
    <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
      style={{ left: checked ? '22px' : '2px' }} />
  </button>
);

export default function SettingsPage() {
  const navigate = useNavigate();
  const [notifSound, setNotifSound] = useState(() => localStorage.getItem('rxhive_notif_sound') !== 'false');
  const [desktopNotif, setDesktopNotif] = useState(() => localStorage.getItem('rxhive_desktop_notif') !== 'false');
  const [enterSends, setEnterSends] = useState(() => localStorage.getItem('rxhive_enter_sends') !== 'false');
  const [fontSize, setFontSize] = useState(() => localStorage.getItem('rxhive_font_size') || 'medium');

  useEffect(() => { localStorage.setItem('rxhive_notif_sound', notifSound); }, [notifSound]);
  useEffect(() => { localStorage.setItem('rxhive_desktop_notif', desktopNotif); }, [desktopNotif]);
  useEffect(() => { localStorage.setItem('rxhive_enter_sends', enterSends); }, [enterSends]);
  useEffect(() => { localStorage.setItem('rxhive_font_size', fontSize); }, [fontSize]);

  const handleDesktopNotif = (val) => {
    if (val && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    setDesktopNotif(val);
  };

  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      <div className="max-w-[500px] mx-auto p-6">
        <button onClick={() => navigate('/chat')}
          className="flex items-center gap-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] mb-6 transition-colors">
          <ArrowLeft size={16} /> Back to Chat
        </button>

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
                  <Toggle checked={notifSound} onChange={setNotifSound} />
                </div>
                <div className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <BellOff size={18} className="text-[#A3A3A3]" />
                    <div><p className="text-sm text-[#F5F5F5]">Desktop Notifications</p>
                      <p className="text-xs text-[#525252]">Show browser notifications</p></div>
                  </div>
                  <Toggle checked={desktopNotif} onChange={handleDesktopNotif} />
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
                  <Toggle checked={enterSends} onChange={setEnterSends} />
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
                  {[{ key: 'small', label: 'Small', size: '13px' }, { key: 'medium', label: 'Medium', size: '14px' }, { key: 'large', label: 'Large', size: '16px' }].map(opt => (
                    <button key={opt.key} onClick={() => setFontSize(opt.key)}
                      className={`flex-1 py-2 rounded-[6px] text-sm transition-colors ${
                        fontSize === opt.key ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30' : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3]'
                      }`}>{opt.label}</button>
                  ))}
                </div>
              </div>
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
