/**
 * Shared building blocks for the Group Info / Contact Info panels.
 *
 * Both panels are the same shape (a two-column drawer whose left rail switches
 * the right pane), so the rail, the rows, the toggles and the empty/loading
 * states live here once instead of being duplicated and drifting apart.
 *
 * Palette is the "Obsidian Emerald" dark system — bg #0A0A0A, surfaces
 * #141414/#1A1A1A, borders #1F1F1F/#2D2D2D, text #F5F5F5, muted #A3A3A3,
 * primary #10B981, danger #EF4444.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';

/**
 * Escape the drawer's stacking/containing block.
 *
 * The drawer is a framer-motion element animating `x`, so it carries a
 * `transform`. A transform makes an element the containing block for its
 * `position: fixed` descendants — an overlay rendered inside the drawer would
 * be pinned to the drawer's 720px box instead of the viewport. Anything
 * full-screen that lives under the drawer must go through here.
 */
export const Portal = ({ children }) => {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.body);
};

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

/** Resolve a possibly-relative API media path into something <img src> can load. */
export const resolveMediaUrl = (url) => {
  if (!url) return null;
  return /^https?:\/\//i.test(url) ? url : `${backendUrl}${url}`;
};

/**
 * Only http(s) is allowed to become a clickable href. Link items come from
 * message text, so `javascript:` / `data:` must never survive into an anchor
 * even if something upstream stops filtering them.
 */
export const safeHref = (url) => (/^https?:\/\//i.test(url || '') ? url : null);

export const initialsOf = (name) => {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

export const formatBytes = (bytes) => {
  const n = Number(bytes);
  if (!n || Number.isNaN(n)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
};

export const formatDateTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (sameDay) return time;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
  }
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}, ${time}`;
};

export const formatLongDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
};

/** "July 2026" bucket label — media/doc lists group by month like WhatsApp does. */
export const monthLabel = (iso) => {
  if (!iso) return 'Earlier';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Earlier';
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

export const groupByMonth = (items) => {
  const buckets = [];
  const index = new Map();
  for (const item of items) {
    const label = monthLabel(item.created_at);
    if (!index.has(label)) {
      index.set(label, { label, items: [] });
      buckets.push(index.get(label));
    }
    index.get(label).items.push(item);
  }
  return buckets;
};

export const Avatar = ({ name, src, size = 40, square = false, className = '' }) => {
  const resolved = resolveMediaUrl(src);
  return (
    <div
      className={`shrink-0 flex items-center justify-center bg-[#10B981]/10 text-[#10B981] font-semibold overflow-hidden ${
        square ? 'rounded-[10px]' : 'rounded-full'
      } ${className}`}
      style={{ width: size, height: size, fontSize: Math.max(11, Math.round(size / 2.6)) }}
      aria-hidden="true"
    >
      {resolved ? (
        <img src={resolved} alt="" className="w-full h-full object-cover" />
      ) : (
        initialsOf(name)
      )}
    </div>
  );
};

export const LoadingState = ({ label = 'Loading…' }) => (
  <div className="flex flex-col items-center justify-center py-16 gap-3" role="status">
    <Loader2 size={22} className="text-[#10B981] animate-spin" />
    <p className="text-xs text-[#A3A3A3]">{label}</p>
  </div>
);

export const EmptyState = ({ icon: Icon, title, hint }) => (
  <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
    {Icon && (
      <div className="w-12 h-12 rounded-full bg-[#141414] border border-[#1F1F1F] flex items-center justify-center mb-3">
        <Icon size={20} className="text-[#A3A3A3]" />
      </div>
    )}
    <p className="text-sm text-[#F5F5F5]">{title}</p>
    {hint && <p className="text-xs text-[#A3A3A3] mt-1 max-w-[280px]">{hint}</p>}
  </div>
);

export const SectionHeading = ({ children, className = '' }) => (
  <h4 className={`text-[11px] font-semibold uppercase tracking-[0.08em] text-[#A3A3A3] ${className}`}>
    {children}
  </h4>
);

/** Purely visual switch — the surrounding row owns the button semantics. */
export const Switch = ({ checked, disabled }) => (
  <span
    className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${
      checked ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'
    } ${disabled ? 'opacity-40' : ''}`}
  >
    <span
      className={`absolute top-0.5 left-0 h-4 w-4 rounded-full bg-white transition-transform ${
        checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
      }`}
    />
  </span>
);

export const ToggleRow = ({ label, description, checked, onChange, disabled, testId, busy }) => (
  <button
    type="button"
    role="switch"
    aria-checked={!!checked}
    aria-label={label}
    disabled={disabled || busy}
    data-testid={testId}
    onClick={() => onChange?.(!checked)}
    className={`w-full flex items-center justify-between gap-4 px-4 py-3 text-left rounded-[8px] transition-colors ${
      disabled ? 'cursor-not-allowed' : 'hover:bg-[#1A1A1A]'
    }`}
  >
    <span className="min-w-0">
      <span className={`block text-sm ${disabled ? 'text-[#A3A3A3]' : 'text-[#F5F5F5]'}`}>{label}</span>
      {description && <span className="block text-xs text-[#A3A3A3] mt-0.5">{description}</span>}
    </span>
    {busy ? <Loader2 size={16} className="text-[#10B981] animate-spin" /> : <Switch checked={checked} disabled={disabled} />}
  </button>
);

/** Full-width list row used for the Info section's action list. */
export const ActionRow = ({ icon: Icon, label, description, onClick, danger, disabled, testId, trailing }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-testid={testId}
    className={`w-full flex items-center gap-3 px-4 py-3 rounded-[8px] text-left transition-colors ${
      disabled ? 'opacity-50 cursor-not-allowed' : danger ? 'hover:bg-[#EF4444]/10' : 'hover:bg-[#1A1A1A]'
    }`}
  >
    {Icon && <Icon size={18} className={danger ? 'text-[#EF4444]' : 'text-[#A3A3A3]'} />}
    <span className="flex-1 min-w-0">
      <span className={`block text-sm ${danger ? 'text-[#EF4444]' : 'text-[#F5F5F5]'}`}>{label}</span>
      {description && <span className="block text-xs text-[#A3A3A3] mt-0.5 truncate">{description}</span>}
    </span>
    {trailing && <span className="text-xs text-[#A3A3A3] shrink-0">{trailing}</span>}
  </button>
);

/** The square icon-over-label buttons under the avatar (Audio/Video/Add/Search). */
export const QuickAction = ({ icon: Icon, label, onClick, disabled, testId }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-testid={testId}
    className={`flex-1 min-w-[68px] flex flex-col items-center gap-1.5 py-3 px-2 rounded-[10px] border transition-colors ${
      disabled
        ? 'border-[#1F1F1F] bg-[#141414] opacity-40 cursor-not-allowed'
        : 'border-[#1F1F1F] bg-[#141414] hover:border-[#10B981]/40 hover:bg-[#1A1A1A]'
    }`}
  >
    {Icon && <Icon size={18} className="text-[#10B981]" />}
    <span className="text-[11px] text-[#F5F5F5]">{label}</span>
  </button>
);

export const Card = ({ children, className = '' }) => (
  <div className={`bg-[#141414] border border-[#1F1F1F] rounded-[10px] ${className}`}>{children}</div>
);

export const Divider = () => <div className="h-px bg-[#1F1F1F]" />;

/** Small confirm dialog used for the destructive actions in both panels. */
export const ConfirmDialog = ({ open, title, body, confirmLabel, onConfirm, onCancel, danger = true, busy, testId }) => {
  if (!open) return null;
  return (
    <Portal>
      <div
        className="fixed inset-0 z-[70] flex items-center justify-center p-4"
        onClick={onCancel}
        role="presentation"
      >
        <div className="absolute inset-0 bg-black/70" />
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label={title}
          data-testid={testId}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-[380px] bg-[#141414] border border-[#1F1F1F] rounded-[10px] p-5 shadow-[0_18px_60px_rgba(0,0,0,0.6)]"
        >
          <h4 className="text-sm font-semibold text-[#F5F5F5]">{title}</h4>
          {body && <p className="text-sm text-[#A3A3A3] mt-2">{body}</p>}
          <div className="flex justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={busy}
              data-testid={testId ? `${testId}-confirm` : undefined}
              className={`px-4 py-2 text-sm font-medium rounded-[6px] transition-all disabled:opacity-60 flex items-center gap-2 ${
                danger ? 'bg-[#EF4444] text-white hover:opacity-90' : 'bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669]'
              }`}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
};
