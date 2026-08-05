/**
 * Chat header call controls — WhatsApp parity.
 *
 * direct: two plain buttons, voice + video, no dropdown. They keep the
 *   `header-voice-call-btn` / `header-video-call-btn` test ids the calling E2E
 *   suite drives, so those specs keep working unchanged.
 * group:  one video button (still `header-video-call-btn`) with a chevron; the
 *   chevron opens the call panel — group name + "Select people", big Voice and
 *   Video buttons, then "Send call link" and "Schedule call".
 *
 * Actions are reported through `onAction(name)`: voice | video | select-people |
 * send-call-link | schedule-call. `send-call-link` and `schedule-call` are also
 * carried out here (create-link + clipboard, and the shared ScheduleCallModal) —
 * the integrator should not repeat them.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronDown, ChevronRight, Link2, Phone, Video } from 'lucide-react';
import { ScheduleCallModal } from '../calls/CallsTab';
import { MenuItem, MenuSurface, createAndCopyCallLink } from './menuKit';

const iconBtn = (disabled) =>
  `rounded-[6px] transition-colors ${
    disabled
      ? 'cursor-not-allowed text-[#A3A3A3]/30'
      : 'text-[#A3A3A3] hover:bg-[#1A1A1A] hover:text-[#F5F5F5]'
  }`;

export const CallButtonDropdown = ({ conversation, onAction, type, disabled = false }) => {
  const [open, setOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const triggerRef = useRef(null);

  // `cross_org` conversations are groups; only a DM gets the two-button layout.
  const isDirect = (type || conversation?.type) === 'direct';
  const displayName = conversation?.name || 'Group';

  const emit = useCallback((name) => onAction?.(name), [onAction]);

  const handle = useCallback(
    (action) => {
      setOpen(false);
      if (action === 'send-call-link') createAndCopyCallLink('video');
      if (action === 'schedule-call') setScheduleOpen(true);
      emit(action);
    },
    [emit]
  );

  const participantIds = useMemo(
    () => (conversation?.participants || []).map((p) => p.user_id).filter(Boolean),
    [conversation?.participants]
  );

  // A DM's call buttons are plain — no dropdown, so nothing here can schedule.
  if (isDirect) {
    return (
      <>
        <button
          type="button"
          onClick={() => !disabled && emit('voice')}
          aria-disabled={disabled || undefined}
          aria-label="Voice call"
          title="Voice call"
          data-testid="header-voice-call-btn"
          className={`p-2 ${iconBtn(disabled)}`}
        >
          <Phone size={18} />
        </button>
        <button
          type="button"
          onClick={() => !disabled && emit('video')}
          aria-disabled={disabled || undefined}
          aria-label="Video call"
          title="Video call"
          data-testid="header-video-call-btn"
          className={`p-2 ${iconBtn(disabled)}`}
        >
          <Video size={18} />
        </button>
      </>
    );
  }

  return (
    <>
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => !disabled && emit('video')}
          aria-disabled={disabled || undefined}
          aria-label="Video call"
          title="Video call"
          data-testid="header-video-call-btn"
          className={`py-2 pl-2 pr-1 ${iconBtn(disabled)}`}
        >
          <Video size={18} />
        </button>
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((o) => !o)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setOpen(true);
            }
          }}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Call options"
          title="Call options"
          data-testid="call-dropdown-trigger"
          className={`py-2 pl-0.5 pr-2 ${iconBtn(false)}`}
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <MenuSurface
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        align="right"
        label="Call options"
        testId="call-dropdown"
        padded={false}
        className="w-[288px]"
      >
        {/* Who is being called */}
        <button
          type="button"
          role="menuitem"
          tabIndex={-1}
          onClick={() => handle('select-people')}
          data-testid="call-dropdown-select-people"
          className="flex w-full items-center gap-3 px-3 py-3 text-left transition-colors hover:bg-[#2D2D2D] focus:outline-none focus-visible:bg-[#2D2D2D]"
        >
          <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[#10B981]/10 text-sm font-medium text-[#10B981]">
            {displayName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-[#F5F5F5]">{displayName}</p>
            <p className="text-xs text-[#A3A3A3]">Select people</p>
          </div>
          <ChevronRight size={16} className="flex-shrink-0 text-[#A3A3A3]" />
        </button>

        {/* Start now */}
        <div className="flex gap-2 border-t border-[#2D2D2D] px-3 py-3">
          {[
            { action: 'voice', label: 'Voice', icon: Phone },
            { action: 'video', label: 'Video', icon: Video },
          ].map(({ action, label, icon: Icon }) => (
            <button
              key={action}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => handle(action)}
              data-testid={`call-dropdown-${action}`}
              className="flex flex-1 flex-col items-center gap-1.5 rounded-[8px] border border-[#2D2D2D] bg-[#141414] py-3 text-sm text-[#F5F5F5] transition-colors hover:border-[#10B981]/30 hover:bg-[#2D2D2D] focus:outline-none focus-visible:border-[#10B981]/60"
            >
              <Icon size={20} className="text-[#10B981]" />
              {label}
            </button>
          ))}
        </div>

        {/* Later */}
        <div className="border-t border-[#2D2D2D] py-1">
          <MenuItem
            icon={Link2}
            label="Send call link"
            onSelect={() => handle('send-call-link')}
            testId="call-dropdown-send-call-link"
          />
          <MenuItem
            icon={Calendar}
            label="Schedule call"
            onSelect={() => handle('schedule-call')}
            testId="call-dropdown-schedule-call"
          />
        </div>
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

export default CallButtonDropdown;
