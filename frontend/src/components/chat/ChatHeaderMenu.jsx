/**
 * The chat header's 3-dots menu — WhatsApp parity.
 *
 * Two shapes behind one component:
 *   group  — Group info · Search · Select messages · Mute · Exit group
 *            --- Open in new window · Close chat
 *   direct — Contact info · Search · Select messages · Mute
 *            --- New group call · Send call link · Schedule call
 *            --- Open in new window · Close chat
 *
 * Every choice is reported through `onAction(name, payload?)`. Three of them are
 * also *carried out* here, because they are pure side effects with no state the
 * integrator owns:
 *   mute            -> PUT /api/conversations/{id}/mute, then onAction('mute', {is_muted})
 *   new-window      -> window.open('/chat?c=<id>')
 *   send-call-link  -> POST /api/calls/create-link + clipboard
 *   schedule-call   -> opens the shared ScheduleCallModal
 * The action still fires for those, so the integrator can log/react — but it
 * must NOT re-run the request or open a second scheduling modal.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  BellOff,
  Calendar,
  CheckSquare,
  ExternalLink,
  Info,
  Link2,
  LogOut,
  MoreVertical,
  Pin,
  PinOff,
  Search,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import client from '../../api/client';
import useChatStore from '../../stores/chatStore';
import { ScheduleCallModal } from '../calls/CallsTab';
import { MenuDivider, MenuItem, MenuSurface, apiError, createAndCopyCallLink } from './menuKit';

export const ChatHeaderMenu = ({ type, conversation, onAction, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [mutePending, setMutePending] = useState(false);
  const [pinPending, setPinPending] = useState(false);
  // Mute is a toggle we own until the store catches up; null = trust the prop.
  const [mutedOverride, setMutedOverride] = useState(null);
  const triggerRef = useRef(null);

  const convId = conversation?._id;
  const serverMuted = !!conversation?.is_muted;
  const isPinned = !!conversation?.is_pinned;
  // `cross_org` groups are groups: anything that isn't a DM gets the group menu.
  const isDirect = (type || conversation?.type) === 'direct';
  const isMuted = mutedOverride ?? serverMuted;

  useEffect(() => {
    setMutedOverride(null);
  }, [convId, serverMuted]);

  const emit = useCallback((name, payload) => onAction?.(name, payload), [onAction]);

  const toggleMute = useCallback(async () => {
    if (!convId || mutePending) return;
    setMutePending(true);
    try {
      const { data } = await client.put(`/api/conversations/${convId}/mute`);
      const next = typeof data?.is_muted === 'boolean' ? data.is_muted : !isMuted;
      setMutedOverride(next);
      toast.success(next ? 'Notifications muted' : 'Notifications unmuted');
      emit('mute', { is_muted: next });
    } catch (err) {
      toast.error(apiError(err, 'Failed to update notifications'));
    } finally {
      setMutePending(false);
    }
  }, [convId, mutePending, isMuted, emit]);

  /**
   * Pin / unpin THIS chat for me.
   *
   * PUT /pin already existed server-side, fully per-user, and had zero frontend
   * callers — this is the missing entry point. The store action re-sorts, because
   * updateConversation does not and the row would otherwise keep its position
   * until the next inbound message.
   *
   * The server's 400 detail is surfaced verbatim: hitting the pin cap is a
   * message worth reading, not a generic failure.
   */
  const togglePin = useCallback(async () => {
    if (!convId || pinPending) return;
    setPinPending(true);
    try {
      const { data } = await client.put(`/api/conversations/${convId}/pin`);
      const next = typeof data?.is_pinned === 'boolean' ? data.is_pinned : !isPinned;
      useChatStore.getState().setConversationPinned(convId, next, data?.pin_order ?? null);
      toast.success(next ? 'Chat pinned' : 'Chat unpinned');
      emit('pin', { is_pinned: next, pin_order: data?.pin_order ?? null });
    } catch (err) {
      toast.error(apiError(err, 'Failed to update pin'));
    } finally {
      setPinPending(false);
    }
  }, [convId, pinPending, isPinned, emit]);

  const handle = useCallback(
    (action) => {
      setOpen(false);
      switch (action) {
        case 'mute':
          // Emits from inside, once the server has confirmed the new value.
          toggleMute();
          return;
        case 'pin':
          togglePin();
          return;
        case 'new-window':
          if (convId) {
            window.open(
              `${window.location.origin}/chat?c=${encodeURIComponent(convId)}`,
              '_blank',
              'noopener,noreferrer'
            );
          }
          break;
        case 'send-call-link':
          createAndCopyCallLink('video');
          break;
        case 'schedule-call':
          setScheduleOpen(true);
          break;
        default:
          break;
      }
      emit(action);
    },
    [convId, emit, toggleMute, togglePin]
  );

  const items = useMemo(() => {
    const mute = {
      action: 'mute',
      label: isMuted ? 'Unmute notifications' : 'Mute notifications',
      icon: isMuted ? Bell : BellOff,
      disabled: mutePending,
    };
    const pin = {
      action: 'pin',
      label: isPinned ? 'Unpin chat' : 'Pin chat',
      icon: isPinned ? PinOff : Pin,
      disabled: pinPending,
    };
    const tail = [
      { divider: true },
      { action: 'new-window', label: 'Open in new window', icon: ExternalLink },
      { action: 'close', label: 'Close chat', icon: X },
    ];

    if (isDirect) {
      return [
        { action: 'info', label: 'Contact info', icon: Info },
        { action: 'search', label: 'Search', icon: Search },
        { action: 'select', label: 'Select messages', icon: CheckSquare },
        pin,
        mute,
        { divider: true },
        { action: 'new-group-call', label: 'New group call', icon: Users },
        { action: 'send-call-link', label: 'Send call link', icon: Link2 },
        { action: 'schedule-call', label: 'Schedule call', icon: Calendar },
        ...tail,
      ];
    }
    return [
      { action: 'info', label: 'Group info', icon: Info },
      { action: 'search', label: 'Search', icon: Search },
      { action: 'select', label: 'Select messages', icon: CheckSquare },
      pin,
      mute,
      { action: 'exit', label: 'Exit group', icon: LogOut, danger: true },
      ...tail,
    ];
  }, [isDirect, isMuted, mutePending, isPinned, pinPending]);

  const participantIds = useMemo(
    () => (conversation?.participants || []).map((p) => p.user_id).filter(Boolean),
    [conversation?.participants]
  );

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Chat menu"
        aria-disabled={disabled || undefined}
        title="Menu"
        data-testid="chat-header-menu-trigger"
        className={`rounded-[6px] p-2 transition-colors ${
          disabled
            ? 'cursor-not-allowed text-[#A3A3A3]/30'
            : 'text-[#A3A3A3] hover:bg-[#1A1A1A] hover:text-[#F5F5F5]'
        }`}
      >
        <MoreVertical size={18} />
      </button>

      <MenuSurface
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        align="right"
        label={isDirect ? 'Chat options' : 'Group options'}
        testId="chat-header-menu"
        className="w-[232px]"
      >
        {items.map((item, i) =>
          item.divider ? (
            <MenuDivider key={`sep-${i}`} />
          ) : (
            <MenuItem
              key={item.action}
              icon={item.icon}
              label={item.label}
              danger={item.danger}
              disabled={item.disabled}
              onSelect={() => handle(item.action)}
              testId={`chat-header-menu-${item.action}`}
            />
          )
        )}
      </MenuSurface>

      <ScheduleCallModal
        isOpen={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        participantIds={participantIds}
        defaultTitle={conversation?.name || ''}
      />
    </>
  );
};

export default ChatHeaderMenu;
