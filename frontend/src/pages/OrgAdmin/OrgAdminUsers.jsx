import { useEffect, useState, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { Plus, Search, Pencil, Loader2, RefreshCw, Copy, X, Info } from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import { useAuth } from '../../contexts/AuthContext';
import client from '../../api/client';

import { generatePassword as genPassword } from '../../utils/generatePassword';
import { apiError } from '../../utils/helpers';
import { createRequestTicket } from '../../utils/latestRequest';

export default function OrgAdminUsers() {
  const { user: me } = useAuth();
  // An empty array means organization-wide, matching the API (see
  // org_admin.managed_dept_ids). Absent for anyone who is not an org admin, and
  // this page is admin-only, but default it so a stale cached /me cannot crash
  // the render.
  const managed = me?.managed_departments || [];
  const scoped = managed.length > 0;

  const [users, setUsers] = useState([]);
  const [depts, setDepts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [formEmail, setFormEmail] = useState('');
  const [formName, setFormName] = useState('');
  const [formDept, setFormDept] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [autoPassword, setAutoPassword] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('');
  const [editActive, setEditActive] = useState(true);
  const [editDept, setEditDept] = useState('');
  const [resetPw, setResetPw] = useState(null);

  const fetchDepts = useCallback(async () => {
    try { const { data } = await client.get('/api/org-admin/departments'); setDepts(data); } catch {}
  }, []);

  // One counter for every load below, effect-driven and imperative alike: only
  // the holder of the newest ticket may write. See utils/latestRequest.
  const ticketRef = useRef(null);
  ticketRef.current ??= createRequestTicket();

  // Imperative reloads — after create, edit, delete, bulk — go through a nonce the
  // load effect depends on, rather than calling the loader directly.
  //
  // Those handlers are async: they await a mutation and then reload. Calling the
  // loader directly calls the closure captured at the render the handler was
  // created in, so a page or filter change DURING that await leaves them holding a
  // loader built over the OLD query — which then takes the newest ticket and wins
  // with rows the search box no longer describes. That is the same defect this file
  // was just fixed for, arriving through a different door.
  //
  // Bumping a nonce hands the load back to the effect, which always re-runs with
  // current state. setReloadNonce is stable, so no handler can capture a stale one.
  const [reloadNonce, setReloadNonce] = useState(0);
  const reloadUsers = useCallback(() => setReloadNonce((n) => n + 1), []);

  const fetchUsers = useCallback(async () => {
    const seq = ticketRef.current.take();
    setLoading(true);
    try {
      const params = { page, limit, search };
      if (deptFilter) params.dept_id = deptFilter;
      const { data } = await client.get('/api/org-admin/users', { params });
      if (!ticketRef.current.isCurrent(seq)) return;
      setUsers(data.data); setTotal(data.total);
    } catch { if (ticketRef.current.isCurrent(seq)) toast.error('Failed to load users'); }
    // The spinner belongs to the newest load as much as the rows do: clearing it
    // from a superseded one shows the stale table as if it were loaded.
    finally { if (ticketRef.current.isCurrent(seq)) setLoading(false); }
  }, [page, search, deptFilter]);

  useEffect(() => { fetchDepts(); }, [fetchDepts]);
  useEffect(() => {
    fetchUsers();
    // Disowned on the way out: a response arriving for a screen that is gone
    // writes nothing. See utils/latestRequest.
    return () => ticketRef.current.invalidate();
  }, [fetchUsers, reloadNonce]);

  const openCreate = () => {
    setFormEmail(''); setFormName(''); setFormDept(depts[0]?._id || '');
    setAutoPassword(true); setFormPassword(genPassword()); setShowCreate(true);
  };

  const handleCreate = async () => {
    // Mirror OrgCreateUser's `min_length=2` on display_name, against the trimmed
    // value. Checking `!formName` only asked whether the box was non-empty, and
    // the API measures the string it is sent, not the one it stores: "  " is two
    // characters on the wire, clears min_length, and is then stripped before the
    // insert, so the account landed with a blank name. " a " got through the same
    // way and stored a one-character one. Sending the trimmed value keeps what is
    // stored identical to what was validated here.
    const name = formName.trim();
    if (name.length < 2) return;
    setSaving(true);
    try {
      // Always 'member'. The API rejects anything else from an org admin, so
      // there is no role to choose and no state to hold one in.
      await client.post('/api/org-admin/users', {
        dept_id: formDept, email: formEmail, display_name: name, password: formPassword, role: 'member'
      });
      toast.success('User created', {
        description: `Password: ${formPassword}`, duration: 10000,
        action: { label: 'Copy', onClick: () => { navigator.clipboard.writeText(formPassword); toast.success('Copied!'); } }
      });
      setShowCreate(false); reloadUsers();
    } catch (err) { toast.error(apiError(err, 'Failed')); }
    finally { setSaving(false); }
  };

  const openEdit = (user) => {
    setEditUser(user); setEditName(user.display_name); setEditRole(user.role);
    setEditActive(user.is_active); setEditDept(user.dept_id); setResetPw(null);
  };

  const handleEditSave = async () => {
    // The same floor, which this drawer had no version of at all. OrgUpdateUser
    // carries no `min_length`, so a rename to "a" was accepted and kept, while a
    // rename to whitespace was quietly discarded server-side and still reported
    // "User updated" over a list that had not changed.
    const name = editName.trim();
    if (name.length < 2) return;
    try {
      await client.put(`/api/org-admin/users/${editUser._id}`, {
        display_name: name, role: editRole, is_active: editActive, dept_id: editDept
      });
      toast.success('User updated'); setEditUser(null); reloadUsers();
    } catch (err) { toast.error(apiError(err, 'Failed')); }
  };

  const handleResetPw = async () => {
    try {
      const { data } = await client.post(`/api/org-admin/users/${editUser._id}/reset-password`);
      setResetPw(data.temporary_password);
      toast.success('Password reset', { description: data.temporary_password, duration: 10000 });
    } catch { toast.error('Failed'); }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <PageTransition>
      <div className="max-w-[1200px]">
        {/* Without this a scoped admin sees a short list with no explanation and
            reasonably concludes people are missing. Names the departments rather
            than saying "restricted", so the boundary is checkable at a glance. */}
        {scoped && (
          <div className="flex items-start gap-2 mb-4 p-3 rounded-[6px] bg-[#1A1A1A] border border-[#2D2D2D]">
            <Info size={14} className="text-[#10B981] mt-0.5 flex-shrink-0" />
            <p className="text-xs text-[#A3A3A3] leading-relaxed">
              You manage{' '}
              <span className="text-[#F5F5F5]">{managed.map(d => d.name).join(', ')}</span>.
              You can view and create members in {managed.length > 1 ? 'these departments' : 'this department'} only.
            </p>
          </div>
        )}
        <div className="flex flex-wrap items-end gap-4 mb-6">
          <div className="relative flex-1 max-w-xs">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
            <input type="text" placeholder="Search users..." value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none transition-all" />
          </div>
          <select value={deptFilter || ''} onChange={(e) => { setDeptFilter(e.target.value || null); setPage(1); }}
            className="h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none">
            <option value="">All Departments</option>
            {depts.map(d => <option key={d._id} value={d._id}>{d.name}</option>)}
          </select>
          <button onClick={openCreate}
            className="flex items-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium border border-[#10B981] text-[#10B981] hover:bg-[#10B981] hover:text-[#0A0A0A] transition-all ml-auto">
            <Plus size={16} /> Create User
          </button>
        </div>

        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-[#0F0F0F] text-[#A3A3A3] text-xs uppercase tracking-wider">
                <th className="px-6 py-3 text-left">User</th>
                <th className="px-6 py-3 text-left">Email</th>
                <th className="px-6 py-3 text-left">Department</th>
                <th className="px-6 py-3 text-left">Role</th>
                <th className="px-6 py-3 text-left">Status</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? [...Array(5)].map((_, i) => (
                <tr key={i} className="border-t border-[#1F1F1F]">
                  {[...Array(6)].map((_, j) => <td key={j} className="px-6 py-4"><div className="h-4 bg-[#1A1A1A] rounded animate-pulse" /></td>)}
                </tr>
              )) : users.length === 0 ? (
                <tr><td colSpan={6} className="px-6 py-12 text-center text-sm text-[#A3A3A3]">No users found</td></tr>
              ) : users.map((user, idx) => (
                <motion.tr key={user._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: idx * 0.03 }}
                  className="border-t border-[#1F1F1F] hover:bg-[#1A1A1A] transition-colors">
                  <td className="px-6 py-4 text-sm font-medium text-[#F5F5F5]">{user.display_name}</td>
                  <td className="px-6 py-4 text-sm text-[#A3A3A3]">{user.email}</td>
                  <td className="px-6 py-4 text-sm text-[#F5F5F5]">{user.dept_name}</td>
                  <td className="px-6 py-4">
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${user.role === 'admin' ? 'bg-[#10B981]/10 text-[#10B981]' : 'bg-[#1A1A1A] text-[#A3A3A3]'}`}>
                      {user.role === 'admin' ? 'Admin' : 'Member'}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className={`text-xs ${user.is_active ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>{user.is_active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button onClick={() => openEdit(user)} className="p-2 text-[#A3A3A3] hover:text-[#10B981] rounded-[6px] transition-colors">
                      <Pencil size={14} />
                    </button>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-[#1F1F1F]">
              <span className="text-xs text-[#A3A3A3]">Page {page} of {totalPages}</span>
              <div className="flex gap-1">
                <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page === 1} className="px-3 py-1 text-xs bg-[#1A1A1A] border border-[#2D2D2D] rounded text-[#A3A3A3] disabled:opacity-30">Prev</button>
                <button onClick={() => setPage(p => Math.min(totalPages, p+1))} disabled={page === totalPages} className="px-3 py-1 text-xs bg-[#1A1A1A] border border-[#2D2D2D] rounded text-[#A3A3A3] disabled:opacity-30">Next</button>
              </div>
            </div>
          )}
        </div>

        {/* Create User Modal */}
        {showCreate && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
            <div className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-[#F5F5F5] mb-6">Create User</h3>
              <div className="space-y-4">
                <div>
                  <label htmlFor="orgadminusers-01-department" className="text-sm text-[#A3A3A3] mb-1.5 block">Department *</label>
                  <select id="orgadminusers-01-department" value={formDept} onChange={(e) => setFormDept(e.target.value)}
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none">
                    {depts.map(d => <option key={d._id} value={d._id}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="orgadminusers-02-email" className="text-sm text-[#A3A3A3] mb-1.5 block">Email *</label>
                  <input id="orgadminusers-02-email" type="email" value={formEmail} onChange={(e) => setFormEmail(e.target.value)}
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none" />
                </div>
                <div>
                  <label htmlFor="orgadminusers-03-display-name" className="text-sm text-[#A3A3A3] mb-1.5 block">Display Name *</label>
                  {/* OrgCreateUser caps display_name at 100. `maxLength` is
                      live-enforced by the browser on typing and pasting alike, so
                      the ceiling belongs here — unlike the floor, which cannot be
                      a `minLength` attribute because nothing on this page is
                      inside a <form> and constraint validation never runs. The
                      edit drawer's ceiling is a different number; see there. */}
                  <input id="orgadminusers-03-display-name" type="text" value={formName} onChange={(e) => setFormName(e.target.value)}
                    maxLength={100}
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none" />
                </div>
                <div>
                  <div className="flex justify-between mb-1.5">
                    {/* Caption for the field, not a name for the switch beside it:
                        as a label it named the button "Password" and dropped the
                        one word — "Manual" or "Auto-generate" — that says what
                        pressing it does. It labels the manual input instead. */}
                    <span id="orgadminusers-04-password" className="text-sm text-[#A3A3A3]">Password</span>
                    <button aria-label={autoPassword ? 'Enter password manually' : 'Auto-generate password'}
                      onClick={() => { setAutoPassword(!autoPassword); if (!autoPassword) setFormPassword(genPassword()); }}
                      className="text-xs text-[#A3A3A3]">{autoPassword ? 'Manual' : 'Auto-generate'}</button>
                  </div>
                  {autoPassword ? (
                    <div className="flex gap-2">
                      <div className="flex-1 h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm font-mono text-[#10B981] flex items-center">{formPassword}</div>
                      <button onClick={() => { navigator.clipboard.writeText(formPassword); toast.success('Copied!'); }}
                        className="h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-[#A3A3A3] hover:text-[#10B981]"><Copy size={14} /></button>
                    </div>
                  ) : (
                    <input type="text" value={formPassword} onChange={(e) => setFormPassword(e.target.value)}
                      aria-labelledby="orgadminusers-04-password"
                      className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none" />
                  )}
                </div>
                {/* No role picker: an admin creates members only, and the API
                    refuses anything else with a 403. Offering a choice that
                    always fails would be worse than offering none. Stated
                    rather than left implicit, so nobody hunts for the missing
                    control. */}
                <div className="flex items-start gap-2 p-3 rounded-[6px] bg-[#1A1A1A] border border-[#2D2D2D]">
                  <Info size={14} className="text-[#A3A3A3] mt-0.5 flex-shrink-0" />
                  <p className="text-xs text-[#A3A3A3] leading-relaxed">
                    New accounts are created as <span className="text-[#F5F5F5]">members</span>.
                    Only a super admin can grant admin access.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] transition-colors">Cancel</button>
                <button onClick={handleCreate} disabled={!formEmail || formName.trim().length < 2 || !formDept || !formPassword || saving}
                  className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 transition-all flex items-center gap-2">
                  {saving && <Loader2 size={14} className="animate-spin" />} Create User
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Edit User Drawer */}
        {editUser && (
          <div className="fixed inset-0 z-50" onClick={() => setEditUser(null)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
            <motion.div initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
              transition={{ duration: 0.3 }} onClick={e => e.stopPropagation()}
              className="absolute right-0 top-0 h-full w-full sm:w-[400px] bg-[#141414] border-l border-[#1F1F1F] shadow-2xl overflow-y-auto p-6">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-lg font-semibold text-[#F5F5F5]">Edit User</h3>
                <button onClick={() => setEditUser(null)} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] rounded"><X size={18} /></button>
              </div>
              <div className="space-y-5">
                <div><label htmlFor="orgadminusers-05-name" className="text-sm text-[#A3A3A3] mb-1.5 block">Name</label>
                  {/* 200, not the create form's 100: OrgUpdateUser is bounded at
                      the User.display_name column width rather than the create
                      schema's limit. Matching each input to its own endpoint is
                      the point of the attribute — capping this at 100 would refuse
                      renames the API accepts, and would strand any name already
                      longer than that in a box that could only be shortened. */}
                  <input id="orgadminusers-05-name" value={editName} onChange={e => setEditName(e.target.value)}
                    maxLength={200}
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none" /></div>
                <div><label htmlFor="orgadminusers-06-email" className="text-sm text-[#A3A3A3] mb-1.5 block">Email</label>
                  <input id="orgadminusers-06-email" value={editUser.email} readOnly className="w-full h-10 px-4 bg-[#0F0F0F] border border-[#1F1F1F] rounded-[6px] text-sm text-[#A3A3A3]" /></div>
                <div><label htmlFor="orgadminusers-07-department" className="text-sm text-[#A3A3A3] mb-1.5 block">Department</label>
                  <select id="orgadminusers-07-department" value={editDept} onChange={e => setEditDept(e.target.value)}
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none">
                    {depts.map(d => <option key={d._id} value={d._id}>{d.name}</option>)}
                  </select></div>
                <div><span id="orgadminusers-role" className="text-sm text-[#A3A3A3] mb-2 block">Role</span>
                  <div role="group" aria-labelledby="orgadminusers-role" className="flex gap-2">
                    {['member', 'admin'].map(r => {
                      // Promotion is the same grant the create form refuses,
                      // reached through a member who already exists, so the
                      // API blocks it too. Demotion stays available — taking
                      // reach away is not escalation — which is why this
                      // disables the button rather than dropping it: an
                      // existing admin still needs a selected state to
                      // demote FROM.
                      const blocked = r === 'admin' && editUser.role !== 'admin';
                      return (
                        <button key={r} onClick={() => !blocked && setEditRole(r)}
                          disabled={blocked}
                          // The group is named, but naming it said nothing about
                          // which of the two is in force — the selected role was
                          // carried by colour alone.
                          aria-pressed={editRole === r}
                          title={blocked ? 'Only a super admin can grant admin access' : undefined}
                          className={`flex-1 h-10 rounded-[6px] text-sm font-medium capitalize transition-colors ${
                            blocked ? 'bg-[#1A1A1A] border border-[#1F1F1F] text-[#5A5A5A] cursor-not-allowed'
                            : editRole === r ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30'
                            : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3]'}`}>{r}</button>
                      );
                    })}
                  </div>
                  {editUser.role !== 'admin' && (
                    <p className="text-xs text-[#5A5A5A] mt-1.5">Only a super admin can grant admin access.</p>
                  )}</div>
                <div><span id="orgadminusers-09-status" className="text-sm text-[#A3A3A3] mb-2 block">Status</span>
                  <button aria-labelledby="orgadminusers-09-status orgadminusers-09-status-state"
                    aria-pressed={editActive} onClick={() => setEditActive(!editActive)}
                    className="flex items-center gap-3 w-full p-3 rounded-[6px] bg-[#1A1A1A] border border-[#2D2D2D]">
                    <div className={`w-10 h-5 rounded-full ${editActive ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'} relative`}>
                      <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white" style={{ left: editActive ? '22px' : '2px' }} />
                    </div>
                    {/* The caption alone said "Status" and stopped there, so the
                        toggle sounded identical whether the user was active or
                        not. The word is the state; it belongs in the name. */}
                    <span id="orgadminusers-09-status-state" className={`text-sm ${editActive ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>{editActive ? 'Active' : 'Inactive'}</span>
                  </button></div>
                <button onClick={handleResetPw}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium bg-[#1A1A1A] border border-[#2D2D2D] text-[#F59E0B] hover:bg-[#F59E0B]/10 transition-colors">
                  <RefreshCw size={14} /> Reset Password
                </button>
                {resetPw && (
                  <div className="p-3 bg-[#10B981]/5 border border-[#10B981]/20 rounded-[6px]">
                    <p className="text-xs text-[#A3A3A3] mb-1">New password:</p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 text-sm font-mono text-[#10B981]">{resetPw}</code>
                      <button onClick={() => { navigator.clipboard.writeText(resetPw); toast.success('Copied!'); }}
                        className="p-1.5 text-[#A3A3A3] hover:text-[#10B981]"><Copy size={14} /></button>
                    </div>
                  </div>
                )}
                <div className="flex gap-3 pt-4">
                  <button onClick={() => setEditUser(null)} className="flex-1 px-4 py-2.5 text-sm bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3] rounded-[6px]">Cancel</button>
                  <button onClick={handleEditSave} disabled={editName.trim().length < 2}
                    className="flex-1 px-4 py-2.5 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-all">Save</button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}
