import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Search, Trash2, Globe, Archive, RotateCcw, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';
import { apiError } from '../../utils/helpers';
import { toggleOrgSelection } from '../../utils/orgMemberSelection';

export default function CrossOrgGroups() {
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  // Create modal state
  const [showCreate, setShowCreate] = useState(false);
  const [createStep, setCreateStep] = useState(1);
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [purposeTag, setPurposeTag] = useState('Project');
  const [allOrgs, setAllOrgs] = useState([]);
  const [selectedOrgIds, setSelectedOrgIds] = useState([]);
  const [orgUsers, setOrgUsers] = useState({});
  const [selectedMembers, setSelectedMembers] = useState([]);
  // Step 3's filter. The roster is capped server-side now, so this is how a
  // member past the cap is reached at all — see loadOrgUsers.
  const [memberSearch, setMemberSearch] = useState('');
  const [adminIds, setAdminIds] = useState([]);
  const [creating, setCreating] = useState(false);
  const [deleteGroup, setDeleteGroup] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/api/admin/cross-org-groups', {
        params: { page, limit, search, status }
      });
      setGroups(data.data);
      setTotal(data.total);
    } catch { toast.error('Failed to load groups'); }
    finally { setLoading(false); }
  }, [page, search, status]);

  useEffect(() => { fetchGroups(); }, [fetchGroups]);

  // Load all orgs for creation
  const loadOrgs = async () => {
    try {
      const { data } = await client.get('/api/admin/organizations/all');
      setAllOrgs(data);
    } catch { toast.error('Failed to load organizations'); }
  };

  // Load users for selected orgs
  const loadOrgUsers = async (orgId, term = '') => {
    try {
      const { data } = await client.get(`/api/admin/organizations/${orgId}/users`, {
        params: term ? { search: term } : {},
      });
      setOrgUsers(prev => ({ ...prev, [orgId]: data }));
    } catch { /* ignore */ }
  };

  // Refetched on the term, not filtered in the browser. The endpoint caps its
  // response, so anyone past the cap only becomes reachable by narrowing it
  // server-side — the reason the cap and this input had to land together.
  //
  // Debounced because this fires once per selected organization: typing eight
  // characters with three organizations chosen would otherwise be 24 requests.
  useEffect(() => {
    if (selectedOrgIds.length === 0) return undefined;
    const term = memberSearch.trim();
    const timer = setTimeout(() => {
      selectedOrgIds.forEach(oid => loadOrgUsers(oid, term));
    }, 250);
    return () => clearTimeout(timer);
  }, [selectedOrgIds, memberSearch]);

  const openCreate = () => {
    setShowCreate(true);
    setCreateStep(1);
    setGroupName('');
    setGroupDesc('');
    setPurposeTag('Project');
    setSelectedOrgIds([]);
    setSelectedMembers([]);
    setAdminIds([]);
    setMemberSearch('');
    setOrgUsers({});
    loadOrgs();
  };

  // Computed from one consistent snapshot rather than a functional update paired
  // with a closure read of the value it was updating — see utils/orgMemberSelection
  // for what that combination did on a deselect.
  const toggleOrg = (orgId) => {
    const next = toggleOrgSelection({ selectedOrgIds, selectedMembers, adminIds }, orgId);
    setSelectedOrgIds(next.selectedOrgIds);
    setSelectedMembers(next.selectedMembers);
    setAdminIds(next.adminIds);
  };

  const toggleMember = (userId, orgId) => {
    setSelectedMembers(prev => {
      const exists = prev.find(m => m.user_id === userId);
      if (exists) return prev.filter(m => m.user_id !== userId);
      return [...prev, { user_id: userId, org_id: orgId }];
    });
  };

  const toggleAdmin = (userId) => {
    setAdminIds(prev =>
      prev.includes(userId) ? prev.filter(id => id !== userId) : [...prev, userId]
    );
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const members = selectedMembers.map(m => ({
        user_id: m.user_id,
        role: adminIds.includes(m.user_id) ? 'admin' : 'member'
      }));
      await client.post('/api/admin/cross-org-groups', {
        name: groupName.trim(),
        description: groupDesc.trim() || null,
        purpose_tag: purposeTag,
        org_ids: selectedOrgIds,
        members
      });
      toast.success('Cross-org group created!');
      setShowCreate(false);
      fetchGroups();
    } catch (err) {
      toast.error(apiError(err, 'Failed to create group'));
    } finally { setCreating(false); }
  };

  const handleArchive = async (group) => {
    try {
      await client.post(`/api/admin/cross-org-groups/${group._id}/archive`);
      toast.success(group.is_active ? 'Group archived' : 'Group unarchived');
      fetchGroups();
    } catch { toast.error('Failed'); }
  };

  const handleDelete = async () => {
    if (!deleteGroup || deleteConfirm !== deleteGroup.name) return;
    try {
      await client.delete(`/api/admin/cross-org-groups/${deleteGroup._id}`);
      toast.success('Group deleted');
      setDeleteGroup(null);
      setDeleteConfirm('');
      fetchGroups();
    } catch { toast.error('Failed to delete'); }
  };

  const totalPages = Math.ceil(total / limit);
  const PURPOSE_COLORS = { Project: '#10B981', 'Task Force': '#3B82F6', Committee: '#A855F7', Custom: '#A3A3A3' };

  // Get user info from orgUsers for display
  const getMemberInfo = (userId) => {
    for (const orgId of Object.keys(orgUsers)) {
      for (const dept of orgUsers[orgId] || []) {
        const user = dept.users.find(u => u.id === userId);
        if (user) return { ...user, org_name: allOrgs.find(o => o._id === orgId)?.name || '' };
      }
    }
    return null;
  };

  return (
    <PageTransition>
      <div className="max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-sm">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
              <input type="text" placeholder="Search groups..." value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="w-full h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none transition-all" />
            </div>
            <div className="flex gap-1">
              {['active', 'archived'].map(s => (
                <button key={s} onClick={() => { setStatus(s); setPage(1); }}
                  className={`px-3 h-10 rounded-[6px] text-xs font-medium capitalize transition-colors ${
                    status === s ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30' : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3]'
                  }`}>{s}</button>
              ))}
            </div>
          </div>
          <button onClick={openCreate} data-testid="create-cross-org-btn"
            className="flex items-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium border border-[#10B981] text-[#10B981] hover:bg-[#10B981] hover:text-[#0A0A0A] transition-all">
            <Plus size={16} /> Create Cross-Org Group
          </button>
        </div>

        {/* Table */}
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-[#0F0F0F] text-[#A3A3A3] text-xs uppercase tracking-wider">
                <th className="px-6 py-3 text-left">Group Name</th>
                <th className="px-6 py-3 text-left">Organizations</th>
                <th className="px-6 py-3 text-left">Members</th>
                <th className="px-6 py-3 text-left">Purpose</th>
                <th className="px-6 py-3 text-left">Status</th>
                <th className="px-6 py-3 text-left">Created</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                [...Array(3)].map((_, i) => (
                  <tr key={i} className="border-t border-[#1F1F1F]">
                    {[...Array(7)].map((_, j) => (
                      <td key={j} className="px-6 py-4"><div className="h-4 bg-[#1A1A1A] rounded animate-pulse" style={{ width: `${50 + Math.random() * 40}%` }} /></td>
                    ))}
                  </tr>
                ))
              ) : groups.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-16 text-center">
                    <Globe size={40} className="text-[#A3A3A3]/30 mx-auto mb-3" />
                    <p className="text-[#A3A3A3] mb-4">No cross-organization groups yet</p>
                    <button onClick={openCreate}
                      className="px-4 py-2 rounded-[6px] text-sm font-medium bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] transition-all">
                      Create One
                    </button>
                  </td>
                </tr>
              ) : (
                groups.map((group, idx) => (
                  <motion.tr key={group._id} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.04 }}
                    className="border-t border-[#1F1F1F] hover:bg-[#1A1A1A] transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-[6px] bg-[#10B981]/10 flex items-center justify-center">
                          <Globe size={14} className="text-[#10B981]" />
                        </div>
                        <span className="text-sm font-medium text-[#F5F5F5]">{group.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {group.organizations?.map(o => (
                          <span key={o.id} className="px-2 py-0.5 bg-[#1A1A1A] border border-[#2D2D2D] rounded text-xs text-[#A3A3A3]">{o.name}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-sm text-[#F5F5F5]">{group.member_count || 0}</td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-0.5 rounded text-xs font-medium"
                        style={{ backgroundColor: `${PURPOSE_COLORS[group.purpose_tag] || '#A3A3A3'}20`, color: PURPOSE_COLORS[group.purpose_tag] || '#A3A3A3' }}>
                        {group.purpose_tag || 'Custom'}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                        group.is_active ? 'bg-[#10B981]/10 text-[#10B981]' : 'bg-[#A3A3A3]/10 text-[#A3A3A3]'
                      }`}>{group.is_active ? 'Active' : 'Archived'}</span>
                    </td>
                    <td className="px-6 py-4 text-sm text-[#A3A3A3]">{group.created_at ? new Date(group.created_at).toLocaleDateString() : ''}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => handleArchive(group)} title={group.is_active ? 'Archive' : 'Unarchive'}
                          className="p-2 text-[#A3A3A3] hover:text-[#F59E0B] hover:bg-[#F59E0B]/10 rounded-[6px] transition-colors">
                          {group.is_active ? <Archive size={14} /> : <RotateCcw size={14} />}
                        </button>
                        <button onClick={() => { setDeleteGroup(group); setDeleteConfirm(''); }}
                          className="p-2 text-[#A3A3A3] hover:text-[#EF4444] hover:bg-[#EF4444]/10 rounded-[6px] transition-colors">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                ))
              )}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-[#1F1F1F]">
              <span className="text-xs text-[#A3A3A3]">Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total}</span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-1.5 rounded text-[#A3A3A3] hover:text-[#F5F5F5] disabled:opacity-30 transition-colors"><ChevronLeft size={16} /></button>
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-1.5 rounded text-[#A3A3A3] hover:text-[#F5F5F5] disabled:opacity-30 transition-colors"><ChevronRight size={16} /></button>
              </div>
            </div>
          )}
        </div>

        {/* Create Modal (simplified multi-step within modal) */}
        <AnimatePresence>
          {showCreate && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
              <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                onClick={(e) => e.stopPropagation()}
                className="relative bg-[#141414] border border-[#1F1F1F] rounded-[12px] w-full max-w-[600px] max-h-[80vh] flex flex-col overflow-hidden">

                {/* Step indicator */}
                <div className="flex items-center gap-2 px-6 py-4 border-b border-[#1F1F1F]">
                  {[1, 2, 3, 4].map(s => (
                    <div key={s} className={`flex-1 h-1 rounded-full ${s <= createStep ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'}`} />
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto p-6">
                  {createStep === 1 && (
                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold text-[#F5F5F5]">Step 1: Group Details</h3>
                      <div>
                        <label htmlFor="crossorggroups-01-group-name" className="text-sm text-[#A3A3A3] mb-1.5 block">Group Name *</label>
                        <input id="crossorggroups-01-group-name" type="text" value={groupName} onChange={(e) => setGroupName(e.target.value)} maxLength={100}
                          className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none transition-all" />
                      </div>
                      <div>
                        <label htmlFor="crossorggroups-02-description" className="text-sm text-[#A3A3A3] mb-1.5 block">Description</label>
                        <textarea id="crossorggroups-02-description" value={groupDesc} onChange={(e) => setGroupDesc(e.target.value)} rows={2} maxLength={500}
                          className="w-full px-4 py-2 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none resize-none transition-all" />
                      </div>
                      <div>
                        {/* Caption for the set. Naming each option "Purpose"
                            made four buttons that sound the same and hid which
                            one is chosen. */}
                        <span id="crossorggroups-03-purpose" className="text-sm text-[#A3A3A3] mb-1.5 block">Purpose</span>
                        <div role="group" aria-labelledby="crossorggroups-03-purpose" className="flex gap-2 flex-wrap">
                          {['Project', 'Task Force', 'Committee', 'Custom'].map(tag => (
                            <button key={tag} aria-pressed={purposeTag === tag} onClick={() => setPurposeTag(tag)}
                              className={`px-3 py-1.5 rounded-[6px] text-xs font-medium transition-colors ${
                                purposeTag === tag
                                  ? `border text-white` : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3]'
                              }`}
                              style={purposeTag === tag ? { backgroundColor: `${PURPOSE_COLORS[tag]}30`, borderColor: PURPOSE_COLORS[tag], color: PURPOSE_COLORS[tag] } : {}}>
                              {tag}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {createStep === 2 && (
                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold text-[#F5F5F5]">Step 2: Select Organizations</h3>
                      <p className="text-sm text-[#A3A3A3]">Choose at least 2 organizations</p>
                      <div className="space-y-2">
                        {allOrgs.map(org => {
                          const selected = selectedOrgIds.includes(org._id);
                          return (
                            <button key={org._id} onClick={() => toggleOrg(org._id)}
                              className={`w-full flex items-center gap-3 p-3 rounded-[6px] border transition-colors text-left ${
                                selected ? 'bg-[#10B981]/10 border-[#10B981]/30' : 'bg-[#1A1A1A] border-[#2D2D2D] hover:border-[#10B981]/20'
                              }`}>
                              <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${selected ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'}`}>
                                {selected && <span className="text-white text-xs">✓</span>}
                              </div>
                              <div className="flex-1">
                                <p className="text-sm font-medium text-[#F5F5F5]">{org.name}</p>
                                <p className="text-xs text-[#A3A3A3]">{org.user_count} users · {org.dept_count} departments</p>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                      <p className="text-xs text-[#A3A3A3]">{selectedOrgIds.length} organizations selected</p>
                    </div>
                  )}

                  {createStep === 3 && (
                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold text-[#F5F5F5]">Step 3: Select Members</h3>
                      <p className="text-sm text-[#A3A3A3]">Choose at least 1 member from each organization</p>
                      {/*
                        The roster is capped server-side, so this is not a
                        convenience — it is the only way to reach a member past the
                        cap. Typing refetches each selected organization narrowed by
                        the term.
                      */}
                      <input
                        type="text"
                        placeholder="Search members by name or email..."
                        value={memberSearch}
                        onChange={e => setMemberSearch(e.target.value)}
                        className="w-full bg-[#0F0F0F] border border-[#1F1F1F] rounded-[6px] px-3 py-2 text-sm text-[#F5F5F5] placeholder-[#525252] focus:outline-none focus:border-[#10B981]"
                      />
                      {selectedOrgIds.map(orgId => {
                        const org = allOrgs.find(o => o._id === orgId);
                        const depts = orgUsers[orgId] || [];
                        const orgMembers = selectedMembers.filter(m => m.org_id === orgId);
                        return (
                          <div key={orgId} className="bg-[#0F0F0F] border border-[#1F1F1F] rounded-[8px] p-4">
                            <h4 className="text-sm font-medium text-[#F5F5F5] mb-3">{org?.name} ({orgMembers.length} selected)</h4>
                            {depts.every(d => d.users.length === 0) && (
                              <p className="text-xs text-[#525252]">
                                {memberSearch.trim()
                                  ? 'No members match that search.'
                                  : 'No members in this organization.'}
                              </p>
                            )}
                            {depts.map(dept => (
                              <div key={dept.id} className="mb-2">
                                <p className="text-xs text-[#A3A3A3] uppercase mb-1">{dept.name}</p>
                                {dept.users.map(user => {
                                  const isSelected = selectedMembers.some(m => m.user_id === user.id);
                                  return (
                                    <button key={user.id} onClick={() => toggleMember(user.id, orgId)}
                                      className={`w-full flex items-center gap-2 px-3 py-1.5 rounded text-left text-sm transition-colors ${
                                        isSelected ? 'bg-[#10B981]/10 text-[#F5F5F5]' : 'text-[#A3A3A3] hover:bg-[#141414]'
                                      }`}>
                                      <div className={`w-4 h-4 rounded border ${isSelected ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'} flex items-center justify-center`}>
                                        {isSelected && <span className="text-white text-[10px]">✓</span>}
                                      </div>
                                      {user.display_name} — {user.email}
                                    </button>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {createStep === 4 && (
                    <div className="space-y-4">
                      <h3 className="text-lg font-semibold text-[#F5F5F5]">Step 4: Review & Create</h3>
                      <div className="bg-[#0F0F0F] border border-[#1F1F1F] rounded-[8px] p-4 space-y-3">
                        <div className="flex items-center gap-3">
                          <div className="w-12 h-12 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] font-bold">
                            {groupName.substring(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <p className="text-base font-medium text-[#F5F5F5]">{groupName}</p>
                            {groupDesc && <p className="text-xs text-[#A3A3A3]">{groupDesc}</p>}
                            <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: `${PURPOSE_COLORS[purposeTag]}20`, color: PURPOSE_COLORS[purposeTag] }}>{purposeTag}</span>
                          </div>
                        </div>
                        <div className="border-t border-[#1F1F1F] pt-3">
                          <p className="text-sm text-[#A3A3A3]">{selectedOrgIds.length} organizations · {selectedMembers.length} members</p>
                        </div>
                      </div>

                      <div>
                        <h4 className="text-sm font-medium text-[#A3A3A3] mb-2">Assign Admins (at least 1)</h4>
                        <div className="space-y-1">
                          {selectedMembers.map(m => {
                            const info = getMemberInfo(m.user_id);
                            const isAdmin = adminIds.includes(m.user_id);
                            return (
                              <button key={m.user_id} onClick={() => toggleAdmin(m.user_id)}
                                className={`w-full flex items-center gap-3 px-3 py-2 rounded-[6px] text-left transition-colors ${
                                  isAdmin ? 'bg-[#10B981]/10 border border-[#10B981]/30' : 'bg-[#1A1A1A] border border-[#2D2D2D]'
                                }`}>
                                <div className={`w-4 h-4 rounded border ${isAdmin ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'} flex items-center justify-center`}>
                                  {isAdmin && <span className="text-white text-[10px]">✓</span>}
                                </div>
                                <span className="text-sm text-[#F5F5F5]">{info?.display_name || m.user_id}</span>
                                <span className="text-xs text-[#A3A3A3]">({info?.org_name})</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-6 py-4 border-t border-[#1F1F1F]">
                  <button onClick={() => { if (createStep === 1) setShowCreate(false); else setCreateStep(s => s - 1); }}
                    className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">
                    {createStep === 1 ? 'Cancel' : 'Back'}
                  </button>
                  {createStep < 4 ? (
                    <button
                      onClick={() => setCreateStep(s => s + 1)}
                      disabled={
                        (createStep === 1 && !groupName.trim()) ||
                        (createStep === 2 && selectedOrgIds.length < 2) ||
                        (createStep === 3 && selectedMembers.length < 2)
                      }
                      className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 transition-all">
                      Next
                    </button>
                  ) : (
                    <button onClick={handleCreate} disabled={adminIds.length === 0 || creating}
                      className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 transition-all flex items-center gap-2">
                      {creating && <Loader2 size={14} className="animate-spin" />}
                      Create Group
                    </button>
                  )}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Delete Confirmation */}
        <AnimatePresence>
          {deleteGroup && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDeleteGroup(null)}>
              <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
              <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
                onClick={(e) => e.stopPropagation()}
                className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] w-full max-w-md p-6">
                <h3 className="text-lg font-semibold text-[#F5F5F5] mb-2">Delete Group</h3>
                <p className="text-sm text-[#A3A3A3] mb-3">Type <span className="font-mono text-[#F5F5F5]">{deleteGroup.name}</span> to confirm</p>
                <input type="text" value={deleteConfirm} onChange={(e) => setDeleteConfirm(e.target.value)}
                  placeholder={deleteGroup.name}
                  className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#EF4444] focus:outline-none transition-all" />
                <div className="flex justify-end gap-3 mt-4">
                  <button onClick={() => setDeleteGroup(null)} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] transition-colors">Cancel</button>
                  <button onClick={handleDelete} disabled={deleteConfirm !== deleteGroup.name}
                    className="px-4 py-2 text-sm font-medium bg-[#EF4444] text-white rounded-[6px] hover:opacity-90 disabled:opacity-30 transition-all">Delete</button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </PageTransition>
  );
}
