import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Building2, FolderTree, Users, Activity } from 'lucide-react';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';

const statCards = [
  { key: 'total_orgs', label: 'Total Organizations', icon: Building2 },
  { key: 'total_depts', label: 'Total Departments', icon: FolderTree },
  { key: 'total_users', label: 'Total Users', icon: Users },
  { key: 'active_today', label: 'Active Users Today', icon: Activity },
];

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Same defect as the org-admin dashboard, on the super-admin's copy of the
  // same screen. Fixed identically and in the same change: fixing one and not
  // the other would leave the two portals disagreeing about what a failed load
  // looks like.
  // Only the newest load may write — see the org-admin copy for the full
  // reasoning. Same retry button reachable as fast as an admin can click it,
  // same out-of-order replies, same stale figures and phantom error strip.
  const reqSeqRef = useRef(0);

  const fetchStats = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    setLoading(true);
    try {
      const { data } = await client.get('/api/admin/stats');
      if (seq !== reqSeqRef.current) return;
      setStats(data);
      setError(false);
    } catch (err) {
      // Logged either way: a superseded request still failed, and swallowing it
      // hides a half-broken endpoint that only ever loses the race.
      console.error('Failed to fetch stats', err);
      if (seq === reqSeqRef.current) setError(true);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    return () => { reqSeqRef.current++; };
  }, [fetchStats]);

  return (
    <PageTransition>
      <div className="max-w-[1400px] mx-auto">
        {error && (
          <div
            data-testid="admin-dashboard-error"
            className="mb-6 flex items-center justify-between gap-4 px-4 py-3 bg-[#141414] border border-[#EF4444]/40 rounded-[8px]"
          >
            <p className="text-sm text-[#A3A3A3]">Couldn&apos;t load the platform figures.</p>
            <button
              type="button"
              onClick={fetchStats}
              data-testid="admin-dashboard-retry"
              className="px-3 py-1.5 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors shrink-0"
            >
              Try again
            </button>
          </div>
        )}
        {/* Stat Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {statCards.map((card, index) => {
            const Icon = card.icon;
            return (
              <motion.div
                key={card.key}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: index * 0.08, duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
                className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden"
                data-testid={`stat-card-${card.key}`}
              >
                {/* Emerald gradient top line */}
                <div className="h-1 w-full" style={{ background: 'linear-gradient(90deg, rgba(16,185,129,0.0), rgba(16,185,129,1), rgba(16,185,129,0.0))' }} />
                <div className="p-6">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm text-[#A3A3A3]">{card.label}</span>
                    <div className="w-9 h-9 rounded-[6px] bg-[#10B981]/10 flex items-center justify-center">
                      <Icon size={18} className="text-[#10B981]" />
                    </div>
                  </div>
                  {loading ? (
                    <div className="h-8 w-20 bg-[#1A1A1A] rounded animate-pulse" />
                  ) : (
                    <p className="text-3xl font-semibold text-[#F5F5F5] tracking-tight">
                      {/* Em dash, not 0: `?? 0` turned "we do not know" into a measurement. */}
                      {stats?.[card.key] ?? '—'}
                    </p>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Recent Activity */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35, duration: 0.3 }}
          className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-6"
        >
          <h3 className="text-lg font-semibold text-[#F5F5F5] mb-4">Recent Activity</h3>
          {loading ? (
            <div className="space-y-3">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-[#1A1A1A] animate-pulse" />
                  <div className="flex-1">
                    <div className="h-4 w-48 bg-[#1A1A1A] rounded animate-pulse" />
                    <div className="h-3 w-24 bg-[#1A1A1A] rounded animate-pulse mt-1" />
                  </div>
                </div>
              ))}
            </div>
          ) : !stats ? (
            /* No payload has ever landed, so there is nothing to be empty. The
               rich "No recent activity yet / Activity will appear here as you
               manage the platform" state below is an onboarding message for a
               working platform with nothing on it yet, and rendering it under a
               banner that says the figures failed to load told a super-admin the
               platform was idle when the truth was that we never found out.
               `stats` is only assigned on success, so a later failure keeps the
               last good payload and this branch is not reached. */
            <div className="text-center py-8" data-testid="admin-activity-unavailable">
              <Activity size={32} className="text-[#A3A3A3]/30 mx-auto mb-3" />
              <p className="text-sm text-[#A3A3A3]">Activity couldn&apos;t be loaded.</p>
            </div>
          ) : stats.recent_activity?.length > 0 ? (
            <div className="space-y-3">
              {stats.recent_activity.map((activity, index) => (
                <motion.div
                  key={activity._id || index}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: index * 0.04 }}
                  className="flex items-center gap-3 p-3 rounded-[6px] hover:bg-[#1A1A1A] transition-colors duration-150"
                >
                  <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center">
                    <Activity size={14} className="text-[#10B981]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#F5F5F5]">
                      <span className="font-medium capitalize">{activity.action?.replace(/_/g, ' ')}</span>
                      {activity.target && <span className="text-[#A3A3A3]"> — {activity.target}</span>}
                    </p>
                    <p className="text-xs text-[#A3A3A3]">
                      {activity.timestamp ? new Date(activity.timestamp).toLocaleString() : ''}
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <Activity size={32} className="text-[#A3A3A3]/30 mx-auto mb-3" />
              <p className="text-sm text-[#A3A3A3]">No recent activity yet</p>
              <p className="text-xs text-[#A3A3A3]/60 mt-1">Activity will appear here as you manage the platform</p>
            </div>
          )}
        </motion.div>
      </div>
    </PageTransition>
  );
}
