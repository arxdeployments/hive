import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Users, Activity, FolderTree, MessageSquare } from 'lucide-react';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';

const statCards = [
  { key: 'total_users', label: 'Total Users', icon: Users },
  { key: 'active_today', label: 'Active Today', icon: Activity },
  { key: 'total_departments', label: 'Departments', icon: FolderTree },
  { key: 'total_conversations', label: 'Conversations', icon: MessageSquare },
];

export default function OrgAdminDashboard() {
  const [stats, setStats] = useState(null);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      client.get('/api/org-admin/stats'),
      client.get('/api/org-admin/activity')
    ]).then(([s, a]) => {
      setStats(s.data);
      setActivity(a.data || []);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  return (
    <PageTransition>
      <div className="max-w-[1200px]">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {statCards.map((card, i) => {
            const Icon = card.icon;
            return (
              <motion.div key={card.key} initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.08 }}
                className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden">
                <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, rgba(16,185,129,0), rgba(16,185,129,1), rgba(16,185,129,0))' }} />
                <div className="p-6">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-[#A3A3A3]">{card.label}</span>
                    <div className="w-9 h-9 rounded-[6px] bg-[#10B981]/10 flex items-center justify-center">
                      <Icon size={18} className="text-[#10B981]" />
                    </div>
                  </div>
                  {loading ? <div className="h-8 w-20 bg-[#1A1A1A] rounded animate-pulse" /> :
                    <p className="text-3xl font-semibold text-[#F5F5F5] tracking-tight">{stats?.[card.key] ?? 0}</p>}
                </div>
              </motion.div>
            );
          })}
        </div>

        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-6">
          <h3 className="text-lg font-semibold text-[#F5F5F5] mb-4">Recent Activity</h3>
          {activity.length > 0 ? (
            <div className="space-y-3">
              {activity.map((a, i) => (
                <div key={i} className="flex items-center gap-3 p-2 rounded-[6px] hover:bg-[#1A1A1A] transition-colors">
                  <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center">
                    <Activity size={14} className="text-[#10B981]" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-[#F5F5F5] capitalize">{a.action?.replace(/_/g, ' ')} — {a.target}</p>
                    <p className="text-xs text-[#A3A3A3]">{a.timestamp ? new Date(a.timestamp).toLocaleString() : ''}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-[#A3A3A3] text-center py-4">No recent activity</p>}
        </div>
      </div>
    </PageTransition>
  );
}
