import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Building2, MessageSquare } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Two-segment tab for flipping between the chat app and the organization admin
 * panel. Rendered in BOTH shells so the control is in the same place whichever
 * side you are on, rather than each side inventing its own affordance.
 *
 * WHO SEES IT
 *
 * Org admins only — `role === 'admin'` on the wire, which is `org_admin` in the
 * database (auth.wire_role renames it). Deliberately NOT super admins: a
 * superadmin row has org_id = NULL, so every chat read path returns nothing for
 * them (empty conversation list, empty contacts, 403 on creating one). Handing
 * them this tab would be a button to an empty app. Giving them a real chat
 * identity is a tenant-model decision, not a nav one.
 *
 * WHY IT NAVIGATES RATHER THAN RELOADS
 *
 * `navigate()` from react-router, never window.location. App.jsx mounts the call
 * overlays (IncomingCallOverlay, ActiveCallView, MinimizedCallBanner,
 * CallAudioSink) OUTSIDE <Routes> precisely so a call survives navigation, and
 * Chat.jsx refuses to disconnect the websocket while callState !== 'idle'. A
 * full page load would tear both down and drop a live call — the exact failure
 * that comment in Chat.jsx documents. It also costs nothing to preserve the open
 * conversation: chatStore is module-scoped zustand and outlives a route change.
 */

const TABS = [
  { key: 'chat', to: '/chat', label: 'Chat', icon: MessageSquare, match: (p) => p.startsWith('/chat') },
  { key: 'admin', to: '/org-admin', label: 'Admin', icon: Building2, match: (p) => p.startsWith('/org-admin') },
];

export const WorkspaceSwitcher = ({ compact = false, className = '' }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  if (user?.role !== 'admin') return null;

  return (
    <div
      role="tablist"
      aria-label="Switch between chat and admin"
      data-testid="workspace-switcher"
      className={`inline-flex items-center gap-0.5 p-0.5 rounded-[8px] bg-[#141414] border border-[#1F1F1F] ${className}`}
    >
      {TABS.map(({ key, to, label, icon: Icon, match }) => {
        const active = match(pathname);
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            // The label is the accessible name in compact mode too, where it is
            // visually hidden — an icon-only tab would otherwise announce as
            // "button, selected" with nothing to pin the state to.
            aria-label={compact ? label : undefined}
            title={compact ? label : undefined}
            onClick={() => { if (!active) navigate(to); }}
            data-testid={`workspace-switcher-${key}`}
            className={`flex items-center gap-1.5 rounded-[6px] text-xs font-medium transition-colors ${
              compact ? 'px-2 py-1.5' : 'px-2.5 py-1.5'
            } ${
              active
                ? 'bg-[#10B981]/15 text-[#10B981]'
                : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A]'
            }`}
          >
            <Icon size={15} />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
};

export default WorkspaceSwitcher;
