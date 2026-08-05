import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, Video, Link2, Hash, Calendar, PhoneIncoming, PhoneOutgoing, PhoneMissed, X, Clock } from 'lucide-react';
import { formatRelativeTime } from '../../utils/helpers';
import client from '../../api/client';
import useCallStore from '../../stores/callStore';
import wsClient from '../../services/websocket';
import { useAuth } from '../../contexts/AuthContext';
import { toast } from 'sonner';


// Local datetime-local default: now + 1 hour, rounded, in the input's expected format.
const defaultScheduleTime = () => {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Exported so the chat header menus can schedule a call for the open
// conversation instead of duplicating this form. `participantIds` /
// `defaultTitle` default to the standalone Calls-tab behaviour.
export const ScheduleCallModal = ({
  isOpen,
  onClose,
  onScheduled,
  participantIds = [],
  defaultTitle = '',
}) => {
  const [title, setTitle] = useState(defaultTitle);
  const [startTime, setStartTime] = useState(defaultScheduleTime());
  const [callType, setCallType] = useState('video');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setTitle(defaultTitle);
      setStartTime(defaultScheduleTime());
      setCallType('video');
      setSaving(false);
    }
  }, [isOpen, defaultTitle]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { toast.error('Enter a title for the call'); return; }
    if (!startTime) { toast.error('Pick a date and time'); return; }
    const when = new Date(startTime);
    if (Number.isNaN(when.getTime())) { toast.error('Invalid date and time'); return; }
    if (when.getTime() < Date.now()) { toast.error('Pick a time in the future'); return; }

    setSaving(true);
    try {
      await client.post('/api/calls/schedule', {
        title: title.trim(),
        start_time: when.toISOString(),
        call_type: callType,
        participant_ids: participantIds,
      });
      toast.success('Call scheduled');
      onScheduled?.();
      onClose();
    } catch (err) {
      const d = err?.response?.data;
      const msg = (typeof d?.detail === 'string' && d.detail)
        || (Array.isArray(d?.detail) && d.detail[0]?.msg)
        || d?.message
        || 'Failed to schedule call';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
        data-testid="schedule-modal"
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
        <motion.form
          onSubmit={handleSubmit}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
          onClick={(e) => e.stopPropagation()}
          className="relative bg-[#141414] border border-[#1F1F1F] rounded-[12px] w-full max-w-[420px] shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)] flex flex-col overflow-hidden"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#1F1F1F]">
            <h3 className="text-lg font-semibold text-[#F5F5F5]">Schedule a Call</h3>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="px-5 py-4 space-y-4">
            <div>
              <label className="block text-xs text-[#A3A3A3] mb-1.5">Title</label>
              <input
                type="text"
                placeholder="e.g. Weekly sync"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
                data-testid="schedule-title"
                className="w-full h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#525252] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all"
              />
            </div>

            <div>
              <label className="block text-xs text-[#A3A3A3] mb-1.5">Date &amp; time</label>
              <input
                type="datetime-local"
                value={startTime}
                min={defaultScheduleTime()}
                onChange={(e) => setStartTime(e.target.value)}
                data-testid="schedule-time"
                className="w-full h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] [color-scheme:dark] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all"
              />
            </div>

            <div>
              <label className="block text-xs text-[#A3A3A3] mb-1.5">Call type</label>
              <div className="flex gap-2">
                {[
                  { key: 'voice', label: 'Voice' },
                  { key: 'video', label: 'Video' },
                ].map(({ key, label }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCallType(key)}
                    data-testid={`schedule-type-${key}`}
                    className={`flex-1 py-2 rounded-[6px] text-sm flex items-center justify-center gap-2 transition-colors ${
                      callType === key
                        ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30'
                        : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3]'
                    }`}
                  >
                    {key === 'video' ? <Video size={15} /> : <Phone size={15} />} {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[#1F1F1F]">
            <button
              type="button"
              onClick={onClose}
              className="px-4 h-9 rounded-[6px] bg-[#1A1A1A] border border-[#2D2D2D] text-sm text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              data-testid="schedule-submit"
              className="px-4 h-9 rounded-[6px] bg-[#10B981] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
            >
              {saving ? 'Scheduling…' : 'Schedule'}
            </button>
          </div>
        </motion.form>
      </motion.div>
    </AnimatePresence>
  );
};

export const CallsTab = () => {
  const { user } = useAuth();
  const { missedCallCount, setMissedCallCount } = useCallStore();
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [scheduled, setScheduled] = useState([]);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/api/calls/history', { params: { filter, limit: 30 } });
      setCalls(data.data || []);
    } catch {} finally { setLoading(false); }
  }, [filter]);

  const fetchScheduled = useCallback(async () => {
    try {
      const { data } = await client.get('/api/calls/scheduled');
      const list = Array.isArray(data) ? data : (data?.data || []);
      setScheduled(list);
    } catch { /* scheduled list is best-effort */ }
  }, []);

  useEffect(() => { fetchCalls(); }, [fetchCalls]);
  useEffect(() => { fetchScheduled(); }, [fetchScheduled]);

  useEffect(() => {
    client.get('/api/calls/missed-count').then(r => setMissedCallCount(r.data.count)).catch(() => {});
  }, [setMissedCallCount]);

  const handleCall = (call) => {
    const otherId = call.other_participant?.user_id;
    if (!otherId) return;
    wsClient.send({ type: 'call:initiate', callee_id: otherId, call_type: call.call_type || 'voice' });
    useCallStore.getState().initiateCall(null, call.call_type || 'voice');
  };

  const handleCreateLink = async () => {
    try {
      const { data } = await client.post('/api/calls/create-link', { call_type: 'video' });
      navigator.clipboard.writeText(`${window.location.origin}${data.url}`);
      toast.success('Call link copied to clipboard');
    } catch { toast.error('Failed to create link'); }
  };

  const formatDuration = (s) => {
    if (!s) return '';
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const formatScheduledTime = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', {
      weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  };

  // Group calls by date
  const groupedCalls = calls.reduce((acc, call) => {
    const d = new Date(call.started_at);
    const today = new Date();
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    let label;
    if (d.toDateString() === today.toDateString()) label = 'Today';
    else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday';
    else label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    if (!acc[label]) acc[label] = [];
    acc[label].push(call);
    return acc;
  }, {});

  const upcoming = scheduled
    .filter(s => {
      const t = new Date(s.start_time).getTime();
      return !Number.isNaN(t) && t >= Date.now() - 60 * 1000;
    })
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  return (
    <div className="flex-1 overflow-y-auto scrollable-area" data-testid="calls-tab">
      {/* Action Cards */}
      <div className="grid grid-cols-2 gap-2 p-3">
        {[
          { icon: Video, label: 'Start call', onClick: () => toast.info('Select a contact from the list below') },
          { icon: Link2, label: 'New call link', onClick: handleCreateLink },
          { icon: Hash, label: 'Call a number', onClick: () => toast.info('Dialer coming soon') },
          { icon: Calendar, label: 'Schedule call', onClick: () => setScheduleOpen(true) },
        ].map((item, i) => (
          <button key={i} onClick={item.onClick}
            data-testid={`call-action-${i}`}
            className="bg-[#141414] border border-[#1F1F1F] rounded-[12px] p-4 flex flex-col items-center gap-2 hover:bg-[#1A1A1A] transition-colors group">
            <item.icon size={24} className="text-[#A3A3A3] group-hover:text-[#10B981] transition-colors" />
            <span className="text-xs text-[#A3A3A3]">{item.label}</span>
          </button>
        ))}
      </div>

      {/* Upcoming scheduled calls */}
      {upcoming.length > 0 && (
        <div className="px-3 pb-1" data-testid="upcoming-calls">
          <p className="px-1 py-2 text-xs text-[#A3A3A3] font-medium uppercase tracking-wider">Upcoming</p>
          <div className="space-y-1.5">
            {upcoming.map((s, idx) => (
              <div key={s.call_id || s.id || idx}
                className="flex items-center gap-3 bg-[#141414] border border-[#1F1F1F] rounded-[10px] px-3 py-2.5">
                <div className="w-9 h-9 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] flex-shrink-0">
                  {s.call_type === 'video' ? <Video size={16} /> : <Phone size={16} />}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[#F5F5F5] truncate">{s.title || 'Scheduled call'}</p>
                  <div className="flex items-center gap-1.5 text-xs text-[#A3A3A3]">
                    <Clock size={11} />
                    <span className="truncate">{formatScheduledTime(s.start_time)}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="px-3 py-1 flex gap-1">
        {['all', 'missed', 'incoming', 'outgoing'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-medium capitalize transition-colors ${
              filter === f ? 'bg-[#10B981] text-white' : 'bg-[#1A1A1A] text-[#A3A3A3] hover:bg-[#2D2D2D]'
            }`}>{f}</button>
        ))}
      </div>

      {/* Call History */}
      {loading ? (
        <div className="p-4 space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3 px-3 py-2">
              <div className="w-11 h-11 rounded-full bg-[#1A1A1A] animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-4 w-32 bg-[#1A1A1A] rounded animate-pulse" />
                <div className="h-3 w-20 bg-[#1A1A1A] rounded animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ) : calls.length === 0 ? (
        <div className="text-center py-16">
          <Phone size={48} className="text-[#525252] mx-auto mb-4" />
          <p className="text-base text-[#A3A3A3]">No calls yet</p>
          <p className="text-sm text-[#525252]">Your call history will appear here</p>
        </div>
      ) : (
        <div className="px-1">
          {Object.entries(groupedCalls).map(([date, dateCalls]) => (
            <div key={date}>
              <p className="px-3 py-2 text-xs text-[#A3A3A3] font-medium">{date}</p>
              {dateCalls.map((call, idx) => {
                const isMissed = call.status === 'missed' && call.direction === 'incoming';
                const other = call.other_participant;
                return (
                  <motion.button key={call.call_id || idx}
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: idx * 0.03 }}
                    onClick={() => handleCall(call)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 hover:bg-[#141414] transition-colors text-left ${
                      isMissed && !call.seen_by?.includes(user?.id) ? 'border-l-[3px] border-l-[#EF4444]' : ''
                    }`}>
                    <div className="w-11 h-11 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium flex-shrink-0">
                      {other?.display_name?.charAt(0)?.toUpperCase() || '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className={`text-[15px] font-medium truncate ${isMissed ? 'text-[#EF4444]' : 'text-[#F5F5F5]'}`}>
                        {other?.display_name || 'Unknown'}
                      </p>
                      <div className="flex items-center gap-1.5">
                        {call.direction === 'incoming' ? (
                          isMissed ? <PhoneMissed size={12} className="text-[#EF4444]" /> : <PhoneIncoming size={12} className="text-[#10B981]" />
                        ) : (
                          <PhoneOutgoing size={12} className={call.status === 'declined' ? 'text-[#EF4444]' : 'text-[#10B981]'} />
                        )}
                        <span className={`text-xs ${isMissed ? 'text-[#EF4444]' : 'text-[#A3A3A3]'}`}>
                          {call.direction === 'incoming' ? (isMissed ? 'Missed' : 'Incoming') : 'Outgoing'}
                          {call.duration > 0 && ` · ${formatDuration(call.duration)}`}
                        </span>
                        {call.call_type === 'video' && <Video size={10} className="text-[#A3A3A3]" />}
                      </div>
                    </div>
                    <span className="text-xs text-[#A3A3A3] flex-shrink-0">
                      {formatRelativeTime(call.started_at)}
                    </span>
                  </motion.button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <ScheduleCallModal
        isOpen={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onScheduled={fetchScheduled}
      />
    </div>
  );
};
