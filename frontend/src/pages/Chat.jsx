import React, { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ChatSidebar } from '../components/chat/ChatSidebar';
import { ChatPanel } from '../components/chat/ChatPanel';
import { ChatErrorBoundary } from '../components/shared/ErrorBoundary';
import useChatStore from '../stores/chatStore';
import useCallStore from '../stores/callStore';
import { useAuth } from '../contexts/AuthContext';
import wsClient from '../services/websocket';

export default function Chat() {
  // Narrow selectors. This component renders the whole chat surface, so
  // subscribing to the entire store re-mounted-through-rendered both panes on
  // every message, receipt, presence ping and keystroke-driven typing event.
  // The unread total is selected as a number, not the conversations array, so
  // the title effect only reruns when the number actually changes.
  const activeConversationId = useChatStore(s => s.activeConversationId);
  const setActiveConversation = useChatStore(s => s.setActiveConversation);
  const totalUnread = useChatStore(
    s => s.conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0)
  );
  const { user } = useAuth();
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  const [showMessages, setShowMessages] = useState(false);
  const [notifAsked, setNotifAsked] = useState(false);

  // Connect the realtime socket once we have a session. Auth rides in the
  // httpOnly cookie sent with the WS handshake — there is no token in JS, so
  // gating this on localStorage would silently never connect.
  // Keyed on the user id, not the object: checkAuth() mints a new object on
  // every profile refresh, which would otherwise cycle the socket needlessly.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return undefined;
    wsClient.connect();
    return () => {
      // Do NOT tear the socket down while a call is live. disconnect() sets
      // _intentionalClose, which suppresses the reconnect entirely — so
      // navigating /chat -> /settings mid-call left LiveKit media up but
      // signalling permanently down: a hang-up from the mini window was queued
      // and never sent, and the peer's call:ended never arrived. The mini window
      // is deliberately reachable from every route, so the socket has to outlive
      // this one.
      if (useCallStore.getState().callState === 'idle') {
        wsClient.disconnect();
      }
    };
  }, [userId]);

  // FIX: iOS virtual keyboard viewport lock
  useEffect(() => {
    if (window.visualViewport) {
      const handleResize = () => {
        const vh = window.visualViewport.height;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
        window.scrollTo(0, 0);
      };
      const handleScroll = () => { window.scrollTo(0, 0); };
      window.visualViewport.addEventListener('resize', handleResize);
      window.visualViewport.addEventListener('scroll', handleScroll);
      handleResize();
      return () => {
        window.visualViewport.removeEventListener('resize', handleResize);
        window.visualViewport.removeEventListener('scroll', handleScroll);
      };
    }
  }, []);

  // FIX: Prevent touchmove scroll on everything except scrollable areas
  useEffect(() => {
    const preventScroll = (e) => {
      let target = e.target;
      while (target && target !== document.body) {
        if (target.classList.contains('scrollable-area')) return;
        target = target.parentElement;
      }
      e.preventDefault();
    };
    document.addEventListener('touchmove', preventScroll, { passive: false });
    return () => document.removeEventListener('touchmove', preventScroll);
  }, []);

  // Browser notification permission
  useEffect(() => {
    if (notifAsked || typeof Notification === 'undefined') return;
    const asked = localStorage.getItem('rxhive_notif_asked');
    if (asked) { setNotifAsked(true); return; }
    // Show in-app banner after 2s
    const timer = setTimeout(() => {
      if (Notification.permission === 'default') {
        setNotifAsked(false); // Will show banner
      } else {
        setNotifAsked(true);
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [notifAsked]);

  const handleEnableNotifications = () => {
    if (typeof Notification !== 'undefined') {
      Notification.requestPermission();
    }
    localStorage.setItem('rxhive_notif_asked', 'true');
    setNotifAsked(true);
  };

  const handleDismissNotifications = () => {
    localStorage.setItem('rxhive_notif_asked', 'true');
    setNotifAsked(true);
  };

  // Update document title with unread count
  useEffect(() => {
    document.title = totalUnread > 0 ? `RxHive (${totalUnread})` : 'RxHive';
    // OS-level badge (installed PWA / macOS dock / Android launcher). Guarded:
    // unsupported on Firefox and older Safari, and setAppBadge rejects rather
    // than throwing synchronously.
    if ('setAppBadge' in navigator) {
      const p = totalUnread > 0 ? navigator.setAppBadge(totalUnread) : navigator.clearAppBadge();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }, [totalUnread]);

  // A notification click cannot open the right chat by URL alone when it just
  // focuses an existing tab, so sw.js postMessages the conversation id instead.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const onMessage = (event) => {
      if (event.data?.type !== 'rxhive:open-conversation') return;
      const convId = event.data.convId;
      if (convId) setActiveConversation(convId);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [setActiveConversation]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl+K / Cmd+K -> Focus search
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector('[data-testid="conversation-search"]');
        if (searchInput) searchInput.focus();
      }
      // Ctrl+N / Cmd+N -> New chat
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        const newChatBtn = document.querySelector('[data-testid="new-chat-button"]');
        if (newChatBtn) newChatBtn.click();
      }
      // Escape -> Close modals/search
      if (e.key === 'Escape') {
        // Let individual components handle Escape
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setShowMessages(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Stable: these reach every conversation row through the sidebar, so a fresh
  // identity per render defeats the rows' memoisation.
  const handleSelectConversation = useCallback((convId) => {
    setActiveConversation(convId);
    if (isMobile) setShowMessages(true);
  }, [setActiveConversation, isMobile]);

  const handleBack = useCallback(() => {
    setShowMessages(false);
    setActiveConversation(null);
  }, [setActiveConversation]);

  const showNotifBanner = !notifAsked && typeof Notification !== 'undefined' && Notification.permission === 'default' && !localStorage.getItem('rxhive_notif_asked');

  return (
    <div className="h-screen h-[100dvh] bg-[#0A0A0A] flex flex-col overflow-hidden">
      {/* Notification Permission Banner */}
      {showNotifBanner && (
        <div className="bg-[#141414] border-b border-[#1F1F1F] px-4 py-2 flex items-center justify-center gap-4 text-sm flex-shrink-0">
          <span className="text-[#A3A3A3]">Enable notifications to stay updated on new messages</span>
          <button onClick={handleEnableNotifications}
            className="px-3 py-1 bg-[#10B981] text-[#0A0A0A] rounded-[6px] text-xs font-medium hover:bg-[#059669] transition-colors">
            Enable
          </button>
          <button onClick={handleDismissNotifications}
            className="px-3 py-1 text-[#A3A3A3] hover:text-[#F5F5F5] text-xs transition-colors">
            Not now
          </button>
        </div>
      )}

      {/* Main Chat Layout */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {isMobile ? (
          <AnimatePresence mode="wait">
            {showMessages && activeConversationId ? (
              <motion.div
                key="messages"
                initial={{ x: '100%' }}
                animate={{ x: 0 }}
                exit={{ x: '100%' }}
                transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
                className="w-full h-full"
              >
                <ChatPanel
                  conversationId={activeConversationId}
                  onBack={handleBack}
                  isMobile={true}
                />
              </motion.div>
            ) : (
              <motion.div
                key="sidebar"
                initial={{ x: '-100%' }}
                animate={{ x: 0 }}
                exit={{ x: '-100%' }}
                transition={{ duration: 0.25, ease: [0.2, 0.8, 0.2, 1] }}
                className="w-full h-full"
              >
                <ChatSidebar
                  onSelectConversation={handleSelectConversation}
                  isMobile={true}
                />
              </motion.div>
            )}
          </AnimatePresence>
        ) : (
          <>
            <div className="w-[300px] lg:w-[360px] flex-shrink-0 h-full">
              <ChatErrorBoundary>
                <ChatSidebar
                  onSelectConversation={handleSelectConversation}
                  isMobile={false}
                />
              </ChatErrorBoundary>
            </div>
            <ChatErrorBoundary>
              <ChatPanel
                conversationId={activeConversationId}
                onBack={handleBack}
                isMobile={false}
              />
            </ChatErrorBoundary>
          </>
        )}
      </div>
    </div>
  );
}
