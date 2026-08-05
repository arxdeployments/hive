/**
 * Shared building blocks for the chat header menus (ChatHeaderMenu,
 * CallButtonDropdown).
 *
 * Why a fixed-position surface instead of `absolute` inside the header: the
 * chat panel root is `overflow-hidden`, so an absolutely-positioned dropdown
 * hanging off the 64px header gets clipped after ~2 rows. These surfaces are
 * positioned in viewport coordinates and flip above the anchor (and shift
 * horizontally) when they would otherwise run off-screen.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { toast } from 'sonner';
import client from '../../api/client';

const EDGE = 8; // keep this far away from every viewport edge
const GAP = 6; // distance between anchor and surface

/** Enabled menu items, in DOM order — the arrow-key ring. */
const menuItemsOf = (root) =>
  root ? Array.from(root.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])')) : [];

/** FastAPI error bodies come in three shapes; collapse them to one string. */
export const apiError = (err, fallback) => {
  const d = err?.response?.data;
  return (
    (typeof d?.detail === 'string' && d.detail) ||
    (Array.isArray(d?.detail) && d.detail[0]?.msg) ||
    d?.message ||
    fallback
  );
};

/**
 * Clipboard write that also works where `navigator.clipboard` is missing
 * (non-secure origins, older WebViews). Resolves false when nothing was copied
 * so the caller can show the link instead of claiming success.
 */
export const copyText = async (text) => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
};

/** POST /api/calls/create-link, copy origin + url, toast. Returns the URL. */
export const createAndCopyCallLink = async (callType = 'video') => {
  try {
    const { data } = await client.post('/api/calls/create-link', { call_type: callType });
    const url = `${window.location.origin}${data?.url || `/call/${data?.code || ''}`}`;
    const copied = await copyText(url);
    toast.success(copied ? 'Call link copied to clipboard' : `Call link: ${url}`);
    return url;
  } catch (err) {
    toast.error(apiError(err, 'Failed to create call link'));
    return null;
  }
};

/**
 * Anchored, keyboard-navigable menu surface.
 *
 * Closes on Escape and on outside click; arrow keys / Home / End walk the
 * `role="menuitem"` descendants; Tab closes and hands focus back to the anchor.
 */
export const MenuSurface = ({
  open,
  anchorRef,
  onClose,
  align = 'right',
  label,
  testId,
  padded = true,
  className = '',
  children,
}) => {
  const surfaceRef = useRef(null);
  const focusedRef = useRef(false);
  const [pos, setPos] = useState(null);

  const measure = useCallback(() => {
    const anchor = anchorRef?.current;
    const surface = surfaceRef.current;
    if (!anchor || !surface) return;

    const a = anchor.getBoundingClientRect();
    const m = surface.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = a.bottom + GAP;
    let origin = 'top';
    if (top + m.height > vh - EDGE) {
      const above = a.top - GAP - m.height;
      if (above >= EDGE) {
        top = above;
        origin = 'bottom';
      } else {
        top = Math.max(EDGE, vh - EDGE - m.height);
      }
    }

    let left = align === 'left' ? a.left : a.right - m.width;
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - EDGE - m.width));

    setPos({
      top,
      left,
      maxHeight: Math.max(120, vh - 2 * EDGE),
      transformOrigin: `${origin} ${align}`,
    });
  }, [align, anchorRef]);

  // Measure before paint: the surface renders hidden at (-9999,-9999) for one
  // commit, so there is never a visible jump from the off-screen position.
  // The last position is kept on close — clearing it would teleport the surface
  // off-screen for its exit animation — and re-measured before the next paint.
  useLayoutEffect(() => {
    if (!open) {
      focusedRef.current = false;
      return;
    }
    measure();
  }, [open, measure]);

  useEffect(() => {
    if (!open) return undefined;
    const reposition = () => measure();
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose?.();
      }
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, measure, onClose]);

  // Focus the first item once, after it has a real position.
  useEffect(() => {
    if (!open || !pos || focusedRef.current) return;
    focusedRef.current = true;
    const items = menuItemsOf(surfaceRef.current);
    (items[0] || surfaceRef.current)?.focus({ preventScroll: true });
  }, [open, pos]);

  // Hand focus back to the trigger when the menu closes with focus still inside
  // it (Escape, Tab, item activation) — but not when the user clicked away.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    if (surfaceRef.current?.contains(document.activeElement)) {
      anchorRef?.current?.focus({ preventScroll: true });
    }
  }, [open, anchorRef]);

  const onKeyDown = (e) => {
    const items = menuItemsOf(surfaceRef.current);
    if (!items.length) return;
    const idx = items.indexOf(document.activeElement);
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        items[idx < 0 ? 0 : (idx + 1) % items.length].focus();
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        items[idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length].focus();
        break;
      case 'Home':
        e.preventDefault();
        items[0].focus();
        break;
      case 'End':
        e.preventDefault();
        items[items.length - 1].focus();
        break;
      case 'Enter':
      case ' ':
        // Activate explicitly rather than leaning on the button's native
        // Enter/Space handling: preventDefault stops the browser firing a
        // second click, and it keeps Space from scrolling the page behind.
        if (idx >= 0) {
          e.preventDefault();
          items[idx].click();
        }
        break;
      case 'Tab':
        e.preventDefault();
        onClose?.();
        break;
      default:
        break;
    }
  };

  return (
    <>
      {/* Outside-click catcher. Also makes a second click on the trigger a
          plain close rather than a close-then-reopen. Deliberately OUTSIDE
          AnimatePresence: inside it, it stays mounted for the whole exit
          animation and eats the user's next click. */}
      {open && <div className="fixed inset-0 z-40" onClick={onClose} aria-hidden="true" />}
      <AnimatePresence>
        {open && (
          <motion.div
            ref={surfaceRef}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ duration: 0.13, ease: [0.2, 0.8, 0.2, 1] }}
            onKeyDown={onKeyDown}
            data-testid={testId}
            style={{
              position: 'fixed',
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              maxHeight: pos?.maxHeight,
              transformOrigin: pos?.transformOrigin,
              visibility: pos ? 'visible' : 'hidden',
            }}
            className={`z-50 overflow-y-auto rounded-[8px] border border-[#2D2D2D] bg-[#1A1A1A] shadow-[0_18px_60px_rgba(0,0,0,0.55)] focus:outline-none ${
              padded ? 'py-1' : ''
            } ${className}`}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

/** One row of a MenuSurface. */
export const MenuItem = ({ icon: Icon, label, danger = false, disabled = false, onSelect, testId }) => (
  <button
    type="button"
    role="menuitem"
    tabIndex={-1}
    aria-disabled={disabled || undefined}
    onClick={() => {
      if (!disabled) onSelect?.();
    }}
    data-testid={testId}
    className={`flex w-full items-center gap-3 px-4 py-2.5 text-sm transition-colors focus:outline-none ${
      disabled
        ? 'cursor-not-allowed text-[#525252]'
        : danger
          ? 'text-[#EF4444] hover:bg-[#EF4444]/10 focus-visible:bg-[#EF4444]/10'
          : 'text-[#F5F5F5] hover:bg-[#2D2D2D] focus-visible:bg-[#2D2D2D]'
    }`}
  >
    {Icon && <Icon size={16} className="flex-shrink-0" />}
    <span className="flex-1 truncate text-left">{label}</span>
  </button>
);

export const MenuDivider = () => <div role="separator" className="my-1 h-px bg-[#2D2D2D]" />;
