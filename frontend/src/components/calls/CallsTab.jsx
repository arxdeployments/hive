import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { Phone, Video, Link2, Hash, Calendar, PhoneIncoming, PhoneOutgoing, PhoneMissed } from 'lucide-react';
import { formatRelativeTime } from '../../utils/helpers';
import client from '../../api/client';
import useCallStore from '../../stores/callStore';
import { PageTransition } from '../common/PageTransition';
import wsClient from '../../services/websocket';
import { useAuth } from '../../contexts/AuthContext';
import { toast } from 'sonner';

const backendUrl = import.meta.env.VITE_BACKEND_URL || '';

export const CallsTab = () => {
  const { user } = useAuth();
  const { missedCallCount, setMissedCallCount } = useCallStore();
  const [calls, setCalls] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  const fetchCalls = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/api/calls/history', { params: { filter, limit: 30 } });
      setCalls(data.data || []);
    } catch {} finally { setLoading(false); }
  }, [filter]);

  useEffect(() => { fetchCalls(); }, [fetchCalls]);

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

  return (
    <div className="flex-1 overflow-y-auto scrollable-area" data-testid="calls-tab">
      {/* Action Cards */}
      <div className="grid grid-cols-2 gap-2 p-3">
        {[
          { icon: Video, label: 'Start call', onClick: () => toast.info('Select a contact from the list below') },
          { icon: Link2, label: 'New call link', onClick: handleCreateLink },
          { icon: Hash, label: 'Call a number', onClick: () => toast.info('Dialer coming soon') },
          { icon: Calendar, label: 'Schedule call', onClick: () => toast.info('Scheduling coming soon') },
        ].map((item, i) => (
          <button key={i} onClick={item.onClick}
            className="bg-[#141414] border border-[#1F1F1F] rounded-[12px] p-4 flex flex-col items-center gap-2 hover:bg-[#1A1A1A] transition-colors group">
            <item.icon size={24} className="text-[#A3A3A3] group-hover:text-[#10B981] transition-colors" />
            <span className="text-xs text-[#A3A3A3]">{item.label}</span>
          </button>
        ))}
      </div>

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
    </div>
  );
};
