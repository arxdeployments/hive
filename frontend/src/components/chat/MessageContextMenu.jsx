/**
 * MessageContextMenu — the WhatsApp-style per-message menu.
 *
 * ---------------------------------------------------------------------------
 * PARENT CONTRACT (ChatPanel owns the parent side — this file never edits it)
 * ---------------------------------------------------------------------------
 *
 *   <MessageContextMenu
 *     message={msg}                        // message the menu was opened on
 *     isOwn={msg.sender_id === myUserId}   // is this my own bubble?
 *     isGroup={conversation?.type === 'group'}  // OPTIONAL - falls back to the chat store
 *     position={{ x, y }}                  // viewport coords of the click / long-press /
 *                                          // chevron press (what onContextMenu(e, msg) gave you)
 *     onAction={(action, message, meta) => {}}
 *     onClose={() => setContextMenu(null)}
 *   />
 *
 * onAction(actionName, message[, meta]) — `actionName` is exactly one of:
 *
 *   reply | react | star | pin | forward | copy |
 *   reply-privately | message-user | report | select
 *
 * (plus `edit` and `info`, carried over from the previous menu — see the note below.)
 *
 * Division of labour (important — do not duplicate the network calls):
 *
 *   star / pin   THIS component issues POST /api/conversations/messages/{id}/star (or /pin),
 *                optimistically patches `is_starred` / `is_pinned` on the message in the chat
 *                store, and rolls the patch back if the request fails. It then emits
 *                onAction('star'|'pin', message, { starred }|{ pinned }) purely as a
 *                notification. The parent must NOT re-issue the request — these endpoints are
 *                toggles, so a second call would undo the first.
 *   copy         THIS component writes to the clipboard and toasts, then emits 'copy'.
 *   report       THIS component shows the confirm dialog (no backend), then emits 'report'.
 *
 *   Everything else is emitted for the parent to carry out:
 *     reply             -> set the composer's reply target
 *     react             -> open the reaction picker
 *     forward           -> open the forward modal
 *     reply-privately   -> POST /api/conversations/direct { user_id: message.sender_id },
 *                          open that DM and pre-fill the composer quoting `message`
 *     message-user      -> same DM open, without the quote
 *     select            -> enter multi-select mode
 *
 * Two extra rows are carried over from the menu this replaced, because ChatPanel still
 * wires them and nothing else can reach them (the inline edit bar and MessageInfoModal
 * would become dead UI otherwise). Both are OWN-message only, so they never appear next
 * to the group-only block above — which is what the reference screenshots show:
 *   edit  -> own, non-deleted text/image/file message; parent opens its inline editor
 *   info  -> own message; parent opens MessageInfoModal
 *
 * Conditional rules baked in here:
 *   - Copy shows for text messages only.
 *   - Reply privately / Message <Sender> / Report show in GROUP chats only, and never on
 *     your own messages.
 *   - Star/Pin labels flip to Unstar/Unpin from message.is_starred / message.is_pinned.
 *
 * Message deletion (Delete for me / Delete for everyone) was removed as a
 * feature; neither action nor its DELETE endpoint exists any more.
 *
 * data-testids: `message-menu` on the surface, `message-menu-<action>` on every row.
 * (The hover trigger itself is `message-menu-trigger`, and lives in MessageBubble.)
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  Reply, SmilePlus, Star, StarOff, Pin, PinOff, Forward, Copy,
  MessageCircle, Flag, ListChecks, Pencil, Info,
} from 'lucide-react';
import { toast } from 'sonner';
import client from '../../api/client';
import useChatStore from '../../stores/chatStore';
import { apiError } from '../../utils/helpers';

const EDGE_GAP = 8;

/**
 * Patch one message in the store while preserving identity for every other row —
 * the store's render contract is reference equality (see chatStore's header), so a
 * blind `.map()` that hands out fresh objects would re-render the whole thread.
 */
const patchMessage = (conversationId, messageId, patch) => {
  const store = useChatStore.getState();
  const convId = conversationId || store.activeConversationId;
  const list = convId ? store.messages[convId] : null;
  if (!list) return;
  let changed = false;
  const next = list.map((m) => {
    if (m._id !== messageId) return m;
    changed = true;
    return { ...m, ...patch };
  });
  if (changed) store.setMessages(convId, next);
};

const MenuRow = ({ item, onSelect }) => {
  const Icon = item.icon;
  return (
    <button
      type="button"
      role="menuitem"
      onClick={() => onSelect(item.action)}
      data-testid={`message-menu-${item.action}`}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm text-left transition-colors outline-none ${
        item.danger
          ? 'text-[#EF4444] hover:bg-[#EF4444]/10 focus-visible:bg-[#EF4444]/10'
          : 'text-[#F5F5F5] hover:bg-[#2D2D2D] focus-visible:bg-[#2D2D2D]'
      }`}
    >
      <Icon size={16} className="flex-shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
};

export const MessageContextMenu = ({ message, isOwn, isGroup, position, onAction, onClose }) => {
  const menuRef = useRef(null);
  const [coords, setCoords] = useState(null);
  const [view, setView] = useState('menu'); // 'menu' | 'report'

  // `isGroup` is optional so this menu stays correct even if the parent doesn't pass it:
  // fall back to the conversation the message belongs to.
  const conversation = useChatStore((s) => {
    const convId = message?.conversation_id || s.activeConversationId;
    return convId ? s.conversations.find((c) => c._id === convId) : undefined;
  });

  const close = useCallback(() => { if (onClose) onClose(); }, [onClose]);

  // Escape / scroll / resize all dismiss. Outside clicks are caught by the backdrop below.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    const onScroll = (e) => {
      // Ignore scrolling *inside* the menu (long menus can scroll on short viewports).
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
    // The backdrop swallows wheel events before anything can scroll, so `scroll`
    // alone would never fire for a trackpad flick over the message list.
    window.addEventListener('wheel', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('wheel', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [close]);

  const isText = message?.type === 'text';
  const isStarred = !!message?.is_starred;
  const isPinned = !!message?.is_pinned;
  // Optimistic bubbles carry temp ids and don't exist server-side yet.
  const isPending = !!message?.temp_id && message.temp_id === message?._id;

  const groupChat = typeof isGroup === 'boolean'
    ? isGroup
    : conversation?.type === 'group' || conversation?.type === 'cross_org';

  const senderName = message?.sender_name || 'sender';
  const canEdit = !!isOwn && !message?.is_deleted && ['text', 'image', 'file'].includes(message?.type);

  const sections = useMemo(() => {
    const primary = [
      { action: 'reply', icon: Reply, label: 'Reply' },
      { action: 'react', icon: SmilePlus, label: 'React' },
      { action: 'star', icon: isStarred ? StarOff : Star, label: isStarred ? 'Unstar' : 'Star' },
      { action: 'pin', icon: isPinned ? PinOff : Pin, label: isPinned ? 'Unpin' : 'Pin' },
      { action: 'forward', icon: Forward, label: 'Forward' },
      isText && { action: 'copy', icon: Copy, label: 'Copy' },
      // Own-message extras (see header note) — appended so the six items above
      // keep exactly the order and position the design calls for.
      canEdit && { action: 'edit', icon: Pencil, label: 'Edit' },
      isOwn && { action: 'info', icon: Info, label: 'Message info' },
    ].filter(Boolean);

    // Group-only, and never on your own messages.
    const social = (groupChat && !isOwn) ? [
      { action: 'reply-privately', icon: Reply, label: 'Reply privately' },
      { action: 'message-user', icon: MessageCircle, label: `Message ${senderName}` },
      { action: 'report', icon: Flag, label: 'Report' },
    ] : [];

    // Message deletion was removed as a feature, so this section no longer holds
    // anything destructive — Select is all that is left of it. Kept as its own
    // section so the divider above it, and therefore the menu's visual rhythm,
    // is unchanged.
    const trailing = [
      { action: 'select', icon: ListChecks, label: 'Select messages' },
    ];

    return [primary, social, trailing].filter((s) => s.length > 0);
  }, [isText, isStarred, isPinned, groupChat, isOwn, senderName, canEdit]);

  /**
   * Flip instead of clip: measure the rendered menu and mirror it back across the
   * anchor point on whichever axis would overflow the viewport.
   */
  const itemCount = sections.reduce((n, s) => n + s.length, 0);
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el || !position) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = position.x;
    let flippedX = false;
    if (left + width > vw - EDGE_GAP) { left = position.x - width; flippedX = true; }
    if (left < EDGE_GAP) left = EDGE_GAP;

    let top = position.y;
    let flippedY = false;
    if (top + height > vh - EDGE_GAP) { top = position.y - height; flippedY = true; }
    if (top < EDGE_GAP) top = EDGE_GAP;

    setCoords({ left, top, flippedX, flippedY });
  }, [position?.x, position?.y, itemCount, view]);

  const toggleFlag = useCallback((kind) => {
    const isStar = kind === 'star';
    const field = isStar ? 'is_starred' : 'is_pinned';
    const resultKey = isStar ? 'starred' : 'pinned';
    const previous = !!message[field];
    const optimistic = !previous;
    const convId = message.conversation_id;

    if (isPending) {
      toast.error('Message is still sending');
      return;
    }

    patchMessage(convId, message._id, { [field]: optimistic });

    // Both paths are written out in full rather than interpolating `kind` into
    // the URL: scripts/check_contracts.py matches literal client.<verb>('…')
    // paths against the FastAPI route table, and a computed last segment is
    // invisible to it — exactly the drift this project has shipped before.
    const request = isStar
      ? client.post(`/api/conversations/messages/${message._id}/star`)
      : client.post(`/api/conversations/messages/${message._id}/pin`);
    request
      .then(({ data }) => {
        const value = typeof data?.[resultKey] === 'boolean' ? data[resultKey] : optimistic;
        patchMessage(convId, message._id, { [field]: value });
        if (onAction) onAction(kind, message, { [resultKey]: value });
      })
      .catch((err) => {
        patchMessage(convId, message._id, { [field]: previous });
        // Surface the server's own detail. Hitting the 50-pin cap returns a 400
        // with "This conversation already has N pinned messages…", which the
        // generic string below turned into something indistinguishable from a
        // network error — the user had no idea why the pin refused.
        toast.error(apiError(err, isStar
          ? `Failed to ${optimistic ? 'star' : 'unstar'} message`
          : `Failed to ${optimistic ? 'pin' : 'unpin'} message`));
      });
  }, [message, isPending, onAction]);

  const handleSelect = useCallback((action) => {
    if (action === 'report') {
      setView('report'); // stays open; confirm below emits the action
      return;
    }

    if (action === 'copy') {
      const text = message.content || '';
      const done = () => toast.success('Message copied');
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => toast.error('Failed to copy'));
      } else {
        done();
      }
      if (onAction) onAction('copy', message);
      close();
      return;
    }

    if (action === 'star' || action === 'pin') {
      toggleFlag(action);
      close();
      return;
    }

    if (onAction) onAction(action, message);
    close();
  }, [message, onAction, close, toggleFlag]);

  const confirmReport = useCallback(() => {
    if (onAction) onAction('report', message);
    toast.success('Report sent to your administrator');
    close();
  }, [message, onAction, close]);

  /**
   * Move focus INTO the menu once it has been positioned.
   *
   * Without this the roving navigation below never runs at all:
   * `handleMenuKeyDown` is bound to the menu element, so it only sees keys while
   * focus is already inside it — and nothing ever put it there. The whole
   * arrow-key implementation was unreachable, so a keyboard user could open the
   * menu and then not use it.
   *
   * Waits for `coords`, which the layout effect above sets after measuring: the
   * menu is rendered off-screen until then, and focusing a node the browser is
   * about to move causes a visible jump.
   */
  const restoreFocusRef = useRef(null);
  const focusedForRef = useRef(null);
  useEffect(() => {
    if (!position || !coords) {
      // Closed — hand focus back to whatever opened it, if that is still around.
      const opener = restoreFocusRef.current;
      restoreFocusRef.current = null;
      focusedForRef.current = null;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
      return;
    }
    if (focusedForRef.current === position) return;
    focusedForRef.current = position;
    restoreFocusRef.current = document.activeElement;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [position, coords]);

  /**
   * Hand focus back on unmount, not on a "closed" render.
   *
   * ChatPanel mounts this conditionally (`{contextMenu && <MessageContextMenu …/>}`),
   * so closing the menu destroys the element outright and the closed branch above
   * never runs for a real close — it only ever fires on the first pass, before
   * `coords` is measured. Focus was therefore left on <body>: a keyboard user who
   * opened the menu and picked a row, or pressed Escape, was dropped back to the
   * top of the document and had to tab through the whole thread to return.
   *
   * Safe against the actions that open something else (forward, info, react):
   * React runs an unmounting subtree's cleanup before the incoming subtree's
   * effects, so a modal that traps focus on mount still wins.
   */
  useEffect(() => () => {
    const opener = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
      opener.focus({ preventScroll: true });
    }
  }, []);

  /**
   * The confirm view replaces the row that had focus, which drops focus to <body>
   * mid-dialog. The effect above cannot cover this: it is keyed on `position`,
   * and choosing Report changes only `view`, so it bails at the identity check.
   *
   * Cancel rather than Report — the destructive control should not be one blind
   * Enter away for someone who cannot see which view they just landed in.
   */
  const reportCancelRef = useRef(null);
  useEffect(() => {
    if (view !== 'report') return;
    reportCancelRef.current?.focus({ preventScroll: true });
  }, [view]);

  // Roving focus so the menu is usable from the keyboard.
  const handleMenuKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    const rows = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []);
    if (rows.length === 0) return;
    e.preventDefault();
    const current = rows.indexOf(document.activeElement);
    let next = 0;
    if (e.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % rows.length;
    else if (e.key === 'ArrowUp') next = current <= 0 ? rows.length - 1 : current - 1;
    else if (e.key === 'End') next = rows.length - 1;
    rows[next].focus();
  };

  if (!position || !message) return null;

  const originX = coords?.flippedX ? 'right' : 'left';
  const originY = coords?.flippedY ? 'bottom' : 'top';

  return createPortal(
    <>
      {/* Outside click / right-click elsewhere dismisses. */}
      <div
        className="fixed inset-0 z-40"
        onClick={close}
        onContextMenu={(e) => { e.preventDefault(); close(); }}
        data-testid="message-menu-backdrop"
      />
      <motion.div
        ref={menuRef}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.1 }}
        role="menu"
        aria-label="Message options"
        tabIndex={-1}
        onKeyDown={handleMenuKeyDown}
        data-testid="message-menu"
        className="fixed z-50 min-w-[200px] max-w-[280px] max-h-[80vh] overflow-y-auto bg-[#1A1A1A] border border-[#2D2D2D] rounded-[8px] shadow-lg py-1"
        style={{
          top: coords ? coords.top : position.y,
          left: coords ? coords.left : position.x,
          transformOrigin: `${originY} ${originX}`,
          // Hidden for the single layout pass in which we measure it.
          visibility: coords ? 'visible' : 'hidden',
        }}
      >
        {view === 'report' ? (
          <div className="p-4 w-[260px]" data-testid="message-menu-report-confirm">
            <p className="text-sm text-[#F5F5F5] mb-1.5">Report {senderName}?</p>
            <p className="text-xs text-[#A3A3A3] mb-4 leading-relaxed">
              This message will be forwarded to your administrator. {senderName} will not be notified.
            </p>
            <div className="flex justify-end gap-2">
              <button
                ref={reportCancelRef}
                type="button"
                onClick={close}
                data-testid="message-menu-report-cancel"
                className="px-3 py-1.5 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#2D2D2D] rounded-[6px] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmReport}
                data-testid="message-menu-report-submit"
                className="px-3 py-1.5 text-sm font-medium bg-[#EF4444] text-white rounded-[6px] hover:opacity-90 transition-all"
              >
                Report
              </button>
            </div>
          </div>
        ) : (
          sections.map((items, i) => (
            <div key={items[0].action} role="group">
              {i > 0 && <div className="my-1 h-px bg-[#2D2D2D]" />}
              {items.map((item) => (
                <MenuRow key={item.action} item={item} onSelect={handleSelect} />
              ))}
            </div>
          ))
        )}
      </motion.div>
    </>,
    document.body
  );
};
