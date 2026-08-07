import { useEffect, useId, useRef } from 'react';

/** Everything the browser will let a user Tab to, in DOM order. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Dialog semantics for the app's hand-rolled overlays.
 *
 * Six of them — New Conversation, Forward, New Group, Message Info, Profile and
 * Add to call — were plain `motion.div`s over a backdrop. No `role`, no
 * `aria-modal`, no name, no Escape, and no focus handling of any kind. The only
 * way out of any of them was clicking the backdrop, which a keyboard cannot do,
 * so opening one was a dead end: Tab walked off into the chat list behind it and
 * there was no way back or out short of a reload.
 *
 * WHY A HOOK AND NOT A <ModalShell> COMPONENT
 *
 * No two of these agree on the markup a shared shell would have to own. Three
 * centre a card at z-50 over black/60; AddParticipantsModal centres one at
 * z-[10000] because it has to clear the call screens at 9998/9999; ProfileDrawer
 * is not centred at all but slides a full-height panel in from the left; and
 * CreateGroupModal nests a second AnimatePresence for its two steps. A shell
 * general enough for all six ends up taking the class list, the z-index, the
 * backdrop tint and the whole motion config as props — the same markup behind
 * one more indirection — and re-indenting six files to thread it through is
 * exactly the diff that silently drops a Tailwind class and moves the UI. So
 * this owns only the BEHAVIOUR every dialog must have and none of them had, and
 * each overlay keeps its markup verbatim.
 *
 * Returns `panelRef` (spread onto the panel), `titleId` (put on its heading) and
 * `dialogProps` (spread onto the panel).
 */
export const useModalDialog = ({ isOpen, onClose }) => {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);
  const wasOpenRef = useRef(false);
  const titleId = useId();

  // CAPTURED DURING RENDER, on the false -> true edge, and this is load-bearing.
  // React applies `autoFocus` in the LAYOUT phase (commitMount), which runs
  // BEFORE any passive effect — so an effect that reads document.activeElement
  // would find the dialog's own search box already focused and save THAT as the
  // restore target. On close that node is detached, the restore is skipped and
  // focus collapses to <body>: precisely the defect this exists to fix. Render
  // runs before commit, so at this point focus is still on the trigger.
  // Idempotent under StrictMode's double render — the edge guard only fires once.
  if (isOpen && !wasOpenRef.current) {
    restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null;
  }
  wasOpenRef.current = isOpen;

  // onClose is an inline arrow at every call site, so it has a fresh identity on
  // every parent render. Parked in a ref so the effect below can depend on
  // `isOpen` alone rather than re-running — and re-binding — on each render.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const panel = panelRef.current;

    // Only when nothing inside has claimed focus for itself: several of these
    // panels autoFocus a field, and stealing focus back to the container would
    // undo it. Message Info has no field, which is why this runs at all.
    if (panel && !panel.contains(document.activeElement)) {
      panel.focus({ preventScroll: true });
    }

    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }
      if (e.key !== 'Tab') return;
      const el = panelRef.current;
      if (!el) return;
      // Recomputed per keypress rather than cached on open: these panels swap
      // their contents while up — New Group's two steps, and every contact list
      // that arrives from a debounced fetch.
      const items = Array.from(el.querySelectorAll(FOCUSABLE))
        .filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (items.length === 0) {
        // Nothing to move to; keep Tab inside rather than letting it walk out.
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // The container itself counts as "outside" for wrapping purposes. When
      // panel.focus() above has run, `active` IS the panel — and a plain
      // contains() check treats that as inside, so Shift+Tab walked backwards
      // out of the dialog into the page behind the backdrop. Four of the six
      // panels take container focus, so that was the common path, not the rare one.
      const outside = active === el || !el.contains(active);
      if (e.shiftKey) {
        if (outside || active === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (outside || active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      // Return focus to whatever opened this. Guarded on the node still being
      // in the document AND still focusable: a trigger can unmount while the
      // dialog is up (the conversation list re-renders under Profile), and
      // focusing a detached node silently does nothing, leaving <body> focused.
      const opener = restoreRef.current;
      restoreRef.current = null;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  return {
    panelRef,
    titleId,
    dialogProps: {
      ref: panelRef,
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleId,
      // So the container can receive focus when nothing inside claims it, while
      // staying out of the Tab order itself.
      tabIndex: -1,
    },
  };
};

export default useModalDialog;
