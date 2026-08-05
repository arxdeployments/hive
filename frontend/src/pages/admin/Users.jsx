import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus, Search, Pencil, Users as UsersIcon, Loader2,
  ChevronLeft, ChevronRight, ChevronDown, Copy, RefreshCw, X,
  Smartphone
} from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';

function generatePassword(len = 12) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
  let result = '';
  for (let i = 0; i < len; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
  return result;
}

export default function UsersPage() {
  const [orgs, setOrgs] = useState([]);
  const [depts, setDepts] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [selectedDept, setSelectedDept] = useState(null);
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const [deptDropdownOpen, setDeptDropdownOpen] = useState(false);
  const [statusFilter, setStatusFilter] = useState(null);
  // null = all, 'granted' | 'denied' — "who can actually use the phone app?"
  const [mobileFilter, setMobileFilter] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  // Selection
  const [selectedIds, setSelectedIds] = useState([]);

  // Modals
  const [showCreate, setShowCreate] = useState(false);
  const [editUser, setEditUser] = useState(null);
  const [resetPwResult, setResetPwResult] = useState(null);

  // Create form
  const [createOrg, setCreateOrg] = useState(null);
  const [createOrgOpen, setCreateOrgOpen] = useState(false);
  const [createDepts, setCreateDepts] = useState([]);
  const [createDept, setCreateDept] = useState(null);
  const [createDeptOpen, setCreateDeptOpen] = useState(false);
  const [createEmail, setCreateEmail] = useState('');
  const [createName, setCreateName] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState('member');
  const [createMobileAccess, setCreateMobileAccess] = useState(false);
  const [autoPassword, setAutoPassword] = useState(true);
  const [emailAvailable, setEmailAvailable] = useState(null);
  const [createSaving, setCreateSaving] = useState(false);

  // Edit form
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState('member');
  const [editActive, setEditActive] = useState(true);
  const [editMobileAccess, setEditMobileAccess] = useState(false);
  const [editDeptId, setEditDeptId] = useState(null);
  const [editDepts, setEditDepts] = useState([]);
  const [editDeptOpen, setEditDeptOpen] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  // Ids with an in-flight inline mobile-access toggle, so the row can show a
  // spinner and refuse a second click without blocking the rest of the table.
  const [mobilePending, setMobilePending] = useState([]);

  // Load orgs
  useEffect(() => {
    (async () => {
      try {
        const { data } = await client.get('/api/admin/organizations', { params: { limit: 100 } });
        setOrgs(data.data);
      } catch { toast.error('Failed to load organizations'); }
    })();
  }, []);

  // Load depts for filter
  useEffect(() => {
    if (!selectedOrg) { setDepts([]); return; }
    (async () => {
      try {
        const { data } = await client.get('/api/admin/departments', { params: { org_id: selectedOrg._id, limit: 100 } });
        setDepts(data.data);
      } catch { setDepts([]); }
    })();
  }, [selectedOrg]);

  // Fetch users
  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const params = { page, limit, search };
      if (selectedOrg) params.org_id = selectedOrg._id;
      if (selectedDept) params.dept_id = selectedDept._id;
      if (statusFilter) params.status = statusFilter;
      if (mobileFilter) params.mobile = mobileFilter;
      const { data } = await client.get('/api/admin/users', { params });
      setUsers(data.data);
      setTotal(data.total);
    } catch {
      toast.error('Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [selectedOrg, selectedDept, statusFilter, mobileFilter, page, search]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  // Load create depts when org changes
  useEffect(() => {
    if (!createOrg) { setCreateDepts([]); return; }
    (async () => {
      try {
        const { data } = await client.get('/api/admin/departments', { params: { org_id: createOrg._id, limit: 100 } });
        setCreateDepts(data.data);
      } catch { setCreateDepts([]); }
    })();
  }, [createOrg]);

  // Email validation
  useEffect(() => {
    if (!createEmail || !createEmail.includes('@')) { setEmailAvailable(null); return; }
    const timer = setTimeout(async () => {
      try {
        const { data } = await client.get('/api/admin/validate/user-email', { params: { email: createEmail } });
        setEmailAvailable(data.available);
      } catch { setEmailAvailable(null); }
    }, 400);
    return () => clearTimeout(timer);
  }, [createEmail]);

  // Auto generate password
  useEffect(() => {
    if (autoPassword && showCreate) setCreatePassword(generatePassword());
  }, [autoPassword, showCreate]);

  // Load edit depts
  useEffect(() => {
    if (!editUser) return;
    (async () => {
      try {
        const { data } = await client.get('/api/admin/departments', { params: { org_id: editUser.org_id, limit: 100 } });
        setEditDepts(data.data);
      } catch { setEditDepts([]); }
    })();
  }, [editUser]);

  const openCreate = () => {
    setCreateOrg(selectedOrg);
    setCreateDept(null);
    setCreateEmail('');
    setCreateName('');
    setCreateRole('member');
    setCreateMobileAccess(false);
    setAutoPassword(true);
    setCreatePassword(generatePassword());
    setEmailAvailable(null);
    setShowCreate(true);
  };

  const openEdit = (user) => {
    setEditUser(user);
    setEditName(user.display_name);
    setEditRole(user.role);
    setEditActive(user.is_active);
    setEditMobileAccess(!!user.mobile_access);
    setEditDeptId(user.dept_id);
  };

  const handleCreateUser = async () => {
    if (!createOrg || !createDept || !createEmail || !createName || !createPassword) return;
    setCreateSaving(true);
    try {
      await client.post('/api/admin/users', {
        org_id: createOrg._id,
        dept_id: createDept._id,
        email: createEmail,
        display_name: createName,
        password: createPassword,
        role: createRole,
        mobile_access: createMobileAccess,
      });
      toast.success('User created successfully', {
        description: `Password: ${createPassword}`,
        duration: 10000,
        action: {
          label: 'Copy',
          onClick: () => { navigator.clipboard.writeText(createPassword); toast.success('Password copied!'); }
        }
      });
      setShowCreate(false);
      fetchUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to create user');
    } finally {
      setCreateSaving(false);
    }
  };

  const handleEditSave = async () => {
    if (!editUser) return;
    setEditSaving(true);
    try {
      const payload = {
        display_name: editName,
        role: editRole,
        is_active: editActive,
        mobile_access: editMobileAccess,
      };
      if (editDeptId !== editUser.dept_id) payload.dept_id = editDeptId;
      await client.put(`/api/admin/users/${editUser._id}`, payload);
      toast.success('User updated');
      setEditUser(null);
      fetchUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update user');
    } finally {
      setEditSaving(false);
    }
  };

  const handleResetPassword = async () => {
    if (!editUser) return;
    try {
      const { data } = await client.post(`/api/admin/users/${editUser._id}/reset-password`);
      setResetPwResult(data.temporary_password);
      toast.success('Password reset successfully', {
        description: `New password: ${data.temporary_password}`,
        duration: 10000,
        action: {
          label: 'Copy',
          onClick: () => { navigator.clipboard.writeText(data.temporary_password); toast.success('Password copied!'); }
        }
      });
    } catch {
      toast.error('Failed to reset password');
    }
  };

  /**
   * Grant/revoke one user's mobile sign-in straight from the table row.
   *
   * Approving a rollout means walking a list and saying yes to most of it, so the
   * decision lives one click from the row rather than three clicks deep in the
   * edit drawer. Optimistic: the pill flips immediately and is put back if the
   * request fails, because the round trip is long enough that an un-flipped
   * toggle reads as a dead button and invites a second click.
   */
  const toggleMobileAccess = async (user) => {
    if (mobilePending.includes(user._id)) return;
    const next = !user.mobile_access;
    setMobilePending(prev => [...prev, user._id]);
    setUsers(prev => prev.map(u => (u._id === user._id ? { ...u, mobile_access: next } : u)));
    try {
      await client.put(`/api/admin/users/${user._id}`, { mobile_access: next });
      toast.success(
        next
          ? `Mobile access granted to ${user.display_name}`
          : `Mobile access revoked for ${user.display_name}`
      );
      // Keep the edit drawer in sync if it happens to be open on this user.
      if (editUser?._id === user._id) setEditMobileAccess(next);
    } catch (err) {
      setUsers(prev => prev.map(u => (u._id === user._id ? { ...u, mobile_access: !next } : u)));
      toast.error(err.response?.data?.detail || 'Failed to update mobile access');
    } finally {
      setMobilePending(prev => prev.filter(id => id !== user._id));
    }
  };

  const handleBulkAction = async (action) => {
    if (selectedIds.length === 0) return;
    try {
      const { data } = await client.post('/api/admin/users/bulk-action', {
        user_ids: selectedIds,
        action,
      });
      toast.success(data.message);
      setSelectedIds([]);
      fetchUsers();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Bulk action failed');
    }
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === users.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(users.map(u => u._id));
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard!');
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <PageTransition>
      <div className="max-w-[1400px] mx-auto">
        {/* Filters */}
        <div className="flex flex-wrap items-end gap-4 mb-6">
          {/* Org filter */}
          <div>
            <label className="text-xs text-[#A3A3A3] mb-1.5 block">Organization</label>
            <div className="relative">
              <button
                onClick={() => { setOrgDropdownOpen(!orgDropdownOpen); setDeptDropdownOpen(false); }}
                data-testid="users-org-filter"
                className="w-48 h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-left flex items-center justify-between focus:border-[#10B981] focus:outline-none transition-all duration-200"
              >
                <span className={selectedOrg ? 'text-[#F5F5F5] truncate' : 'text-[#A3A3A3]'}>
                  {selectedOrg?.name || 'All'}
                </span>
                <ChevronDown size={14} className="text-[#A3A3A3] flex-shrink-0" />
              </button>
              <AnimatePresence>
                {orgDropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                    className="absolute top-full left-0 right-0 mt-1 bg-[#141414] border border-[#1F1F1F] rounded-[6px] shadow-lg z-20 max-h-60 overflow-y-auto"
                  >
                    <button onClick={() => { setSelectedOrg(null); setSelectedDept(null); setOrgDropdownOpen(false); setPage(1); }}
                      className="w-full px-4 py-2.5 text-sm text-left text-[#A3A3A3] hover:bg-[#1A1A1A]">All Organizations</button>
                    {orgs.map(o => (
                      <button key={o._id} onClick={() => { setSelectedOrg(o); setSelectedDept(null); setOrgDropdownOpen(false); setPage(1); }}
                        className={`w-full px-4 py-2.5 text-sm text-left hover:bg-[#1A1A1A] ${selectedOrg?._id === o._id ? 'text-[#10B981] bg-[#10B981]/5' : 'text-[#F5F5F5]'}`}>
                        {o.name}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Dept filter */}
          <div>
            <label className="text-xs text-[#A3A3A3] mb-1.5 block">Department</label>
            <div className="relative">
              <button
                onClick={() => { if (selectedOrg) { setDeptDropdownOpen(!deptDropdownOpen); setOrgDropdownOpen(false); } }}
                data-testid="users-dept-filter"
                className={`w-48 h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-left flex items-center justify-between transition-all duration-200 ${!selectedOrg ? 'opacity-50 cursor-not-allowed' : 'focus:border-[#10B981] focus:outline-none'}`}
              >
                <span className={selectedDept ? 'text-[#F5F5F5] truncate' : 'text-[#A3A3A3]'}>
                  {selectedDept?.name || 'All'}
                </span>
                <ChevronDown size={14} className="text-[#A3A3A3] flex-shrink-0" />
              </button>
              <AnimatePresence>
                {deptDropdownOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                    className="absolute top-full left-0 right-0 mt-1 bg-[#141414] border border-[#1F1F1F] rounded-[6px] shadow-lg z-20 max-h-60 overflow-y-auto"
                  >
                    <button onClick={() => { setSelectedDept(null); setDeptDropdownOpen(false); setPage(1); }}
                      className="w-full px-4 py-2.5 text-sm text-left text-[#A3A3A3] hover:bg-[#1A1A1A]">All Departments</button>
                    {depts.map(d => (
                      <button key={d._id} onClick={() => { setSelectedDept(d); setDeptDropdownOpen(false); setPage(1); }}
                        className={`w-full px-4 py-2.5 text-sm text-left hover:bg-[#1A1A1A] ${selectedDept?._id === d._id ? 'text-[#10B981] bg-[#10B981]/5' : 'text-[#F5F5F5]'}`}>
                        {d.name}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Search */}
          <div>
            <label className="text-xs text-[#A3A3A3] mb-1.5 block">Search</label>
            <div className="relative">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
              <input
                type="text" placeholder="Name or email..."
                value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                data-testid="users-search-input"
                className="w-56 h-10 pl-9 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all duration-200"
              />
            </div>
          </div>

          {/* Status filter */}
          <div>
            <label className="text-xs text-[#A3A3A3] mb-1.5 block">Status</label>
            <div className="flex gap-1">
              {[null, 'active', 'inactive'].map(s => (
                <button key={s || 'all'} onClick={() => { setStatusFilter(s); setPage(1); }}
                  className={`px-3 h-10 rounded-[6px] text-xs font-medium transition-colors ${statusFilter === s ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30' : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3] hover:text-[#F5F5F5]'}`}>
                  {s ? s.charAt(0).toUpperCase() + s.slice(1) : 'All'}
                </button>
              ))}
            </div>
          </div>

          {/* Mobile-access filter */}
          <div>
            <label className="text-xs text-[#A3A3A3] mb-1.5 block">Mobile App</label>
            <div className="flex gap-1">
              {[
                { value: null, label: 'All' },
                { value: 'granted', label: 'Approved' },
                { value: 'denied', label: 'Not approved' },
              ].map(opt => (
                <button key={opt.value || 'all'}
                  onClick={() => { setMobileFilter(opt.value); setPage(1); }}
                  data-testid={`users-mobile-filter-${opt.value || 'all'}`}
                  className={`px-3 h-10 rounded-[6px] text-xs font-medium transition-colors whitespace-nowrap ${mobileFilter === opt.value ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30' : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3] hover:text-[#F5F5F5]'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ml-auto">
            <button onClick={openCreate} data-testid="users-create-button"
              className="flex items-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium border border-[#10B981] text-[#10B981] hover:bg-[#10B981] hover:text-[#0A0A0A] transition-all duration-200 active:scale-[0.98]">
              <Plus size={16} /> Create User
            </button>
          </div>
        </div>

        {/* Bulk actions bar */}
        <AnimatePresence>
          {selectedIds.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
              data-testid="users-bulk-actions-bar"
              className="mb-4 p-3 bg-[#141414] border border-[#10B981]/30 rounded-[8px] flex items-center gap-3"
            >
              <span className="text-sm text-[#F5F5F5]">{selectedIds.length} selected</span>
              <button onClick={() => handleBulkAction('deactivate')}
                className="px-3 py-1.5 rounded-[6px] text-xs font-medium bg-[#EF4444]/10 text-[#EF4444] hover:bg-[#EF4444]/20 transition-colors">
                Deactivate Selected
              </button>
              <button onClick={() => handleBulkAction('activate')}
                className="px-3 py-1.5 rounded-[6px] text-xs font-medium bg-[#10B981]/10 text-[#10B981] hover:bg-[#10B981]/20 transition-colors">
                Activate Selected
              </button>
              <div className="w-px h-5 bg-[#2D2D2D]" />
              <button onClick={() => handleBulkAction('grant_mobile')}
                data-testid="users-bulk-grant-mobile"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-xs font-medium bg-[#10B981]/10 text-[#10B981] hover:bg-[#10B981]/20 transition-colors">
                <Smartphone size={12} /> Grant Mobile Access
              </button>
              <button onClick={() => handleBulkAction('revoke_mobile')}
                data-testid="users-bulk-revoke-mobile"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-xs font-medium bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors">
                <Smartphone size={12} /> Revoke Mobile Access
              </button>
              <button onClick={() => setSelectedIds([])}
                className="ml-auto p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors">
                <X size={14} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Table */}
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="users-table">
              <thead>
                <tr className="bg-[#0F0F0F] text-[#A3A3A3] text-xs uppercase tracking-wider">
                  <th className="px-4 py-3 text-left w-10">
                    <input type="checkbox" checked={users.length > 0 && selectedIds.length === users.length}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 rounded border-[#2D2D2D] bg-[#1A1A1A] text-[#10B981] focus:ring-[#10B981] focus:ring-offset-0" />
                  </th>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 text-left">Email</th>
                  <th className="px-4 py-3 text-left">Organization</th>
                  <th className="px-4 py-3 text-left">Department</th>
                  <th className="px-4 py-3 text-left">Role</th>
                  <th className="px-4 py-3 text-left">Status</th>
                  <th className="px-4 py-3 text-left">Mobile App</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [...Array(5)].map((_, i) => (
                    <tr key={i} className="border-t border-[#1F1F1F]">
                      {[...Array(9)].map((_, j) => (
                        <td key={j} className="px-4 py-4">
                          <div className="h-4 bg-[#1A1A1A] rounded animate-pulse" style={{ width: `${40 + Math.random() * 50}%` }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : users.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-16 text-center">
                      <UsersIcon size={40} className="text-[#A3A3A3]/30 mx-auto mb-3" />
                      <p className="text-[#A3A3A3] mb-4">No users found</p>
                    </td>
                  </tr>
                ) : (
                  <AnimatePresence>
                    {users.map((user, index) => (
                      <motion.tr
                        key={user._id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.04 }}
                        className="border-t border-[#1F1F1F] hover:bg-[#1A1A1A] transition-colors duration-150"
                        data-testid="users-table-row"
                      >
                        <td className="px-4 py-4">
                          <input type="checkbox" checked={selectedIds.includes(user._id)}
                            onChange={() => toggleSelect(user._id)}
                            className="w-4 h-4 rounded border-[#2D2D2D] bg-[#1A1A1A] text-[#10B981] focus:ring-[#10B981] focus:ring-offset-0" />
                        </td>
                        <td className="px-4 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-xs font-medium flex-shrink-0">
                              {user.display_name?.charAt(0)?.toUpperCase() || '?'}
                            </div>
                            <span className="text-sm font-medium text-[#F5F5F5]">{user.display_name}</span>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-sm text-[#A3A3A3]">{user.email}</td>
                        <td className="px-4 py-4 text-sm text-[#F5F5F5]">{user.org_name}</td>
                        <td className="px-4 py-4 text-sm text-[#F5F5F5]">{user.dept_name}</td>
                        <td className="px-4 py-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                            user.role === 'admin'
                              ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30'
                              : 'bg-[#1A1A1A] text-[#A3A3A3] border border-[#2D2D2D]'
                          }`}>
                            {user.role === 'admin' ? 'Admin' : 'Member'}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${
                            user.is_active ? 'text-[#10B981]' : 'text-[#EF4444]'
                          }`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${user.is_active ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`} />
                            {user.is_active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-4">
                          <button
                            onClick={() => toggleMobileAccess(user)}
                            disabled={mobilePending.includes(user._id)}
                            data-testid="users-mobile-access-toggle"
                            title={user.mobile_access
                              ? 'Approved for the mobile app — click to revoke'
                              : 'Not approved for the mobile app — click to grant'}
                            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium border transition-colors disabled:opacity-50 disabled:cursor-wait ${
                              user.mobile_access
                                ? 'bg-[#10B981]/10 text-[#10B981] border-[#10B981]/30 hover:bg-[#10B981]/20'
                                : 'bg-[#1A1A1A] text-[#A3A3A3] border-[#2D2D2D] hover:text-[#F5F5F5] hover:border-[#10B981]/30'
                            }`}
                          >
                            {mobilePending.includes(user._id)
                              ? <Loader2 size={12} className="animate-spin" />
                              : <Smartphone size={12} />}
                            {user.mobile_access ? 'Approved' : 'Not approved'}
                          </button>
                        </td>
                        <td className="px-4 py-4">
                          <button onClick={() => openEdit(user)} data-testid="users-edit-open-button"
                            className="p-2 text-[#A3A3A3] hover:text-[#10B981] hover:bg-[#10B981]/10 rounded-[6px] transition-colors">
                            <Pencil size={14} />
                          </button>
                        </td>
                      </motion.tr>
                    ))}
                  </AnimatePresence>
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-[#1F1F1F]">
              <span className="text-xs text-[#A3A3A3]">
                Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1} className="p-1.5 rounded-[6px] text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                  <ChevronLeft size={16} />
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map(p => (
                  <button key={p} onClick={() => setPage(p)} className={`w-8 h-8 rounded-[6px] text-xs font-medium transition-colors ${page === p ? 'bg-[#10B981] text-[#0A0A0A]' : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A]'}`}>{p}</button>
                ))}
                <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-1.5 rounded-[6px] text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Create User Modal */}
        <AnimatePresence>
          {showCreate && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              onClick={() => setShowCreate(false)}>
              <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] w-full max-w-lg shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)] max-h-[85vh] overflow-y-auto"
              >
                <div className="p-6">
                  <h3 className="text-lg font-semibold text-[#F5F5F5] mb-6">Create User</h3>
                  <div className="space-y-4">
                    {/* Org select */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Organization *</label>
                      <div className="relative">
                        <button onClick={() => { setCreateOrgOpen(!createOrgOpen); setCreateDeptOpen(false); }}
                          className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-left flex items-center justify-between focus:border-[#10B981] focus:outline-none transition-all">
                          <span className={createOrg ? 'text-[#F5F5F5]' : 'text-[#A3A3A3]'}>{createOrg?.name || 'Select organization'}</span>
                          <ChevronDown size={14} className="text-[#A3A3A3]" />
                        </button>
                        <AnimatePresence>
                          {createOrgOpen && (
                            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                              className="absolute top-full left-0 right-0 mt-1 bg-[#141414] border border-[#1F1F1F] rounded-[6px] shadow-lg z-30 max-h-48 overflow-y-auto">
                              {orgs.map(o => (
                                <button key={o._id} onClick={() => { setCreateOrg(o); setCreateDept(null); setCreateOrgOpen(false); }}
                                  className={`w-full px-4 py-2.5 text-sm text-left hover:bg-[#1A1A1A] ${createOrg?._id === o._id ? 'text-[#10B981]' : 'text-[#F5F5F5]'}`}>{o.name}</button>
                              ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    {/* Dept select */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Department *</label>
                      <div className="relative">
                        <button onClick={() => { if (createOrg) { setCreateDeptOpen(!createDeptOpen); setCreateOrgOpen(false); } }}
                          className={`w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-left flex items-center justify-between transition-all ${!createOrg ? 'opacity-50 cursor-not-allowed' : 'focus:border-[#10B981] focus:outline-none'}`}>
                          <span className={createDept ? 'text-[#F5F5F5]' : 'text-[#A3A3A3]'}>{createDept?.name || 'Select department'}</span>
                          <ChevronDown size={14} className="text-[#A3A3A3]" />
                        </button>
                        <AnimatePresence>
                          {createDeptOpen && (
                            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                              className="absolute top-full left-0 right-0 mt-1 bg-[#141414] border border-[#1F1F1F] rounded-[6px] shadow-lg z-30 max-h-48 overflow-y-auto">
                              {createDepts.length === 0 ? (
                                <p className="px-4 py-3 text-sm text-[#A3A3A3]">No departments in this org</p>
                              ) : createDepts.map(d => (
                                <button key={d._id} onClick={() => { setCreateDept(d); setCreateDeptOpen(false); }}
                                  className={`w-full px-4 py-2.5 text-sm text-left hover:bg-[#1A1A1A] ${createDept?._id === d._id ? 'text-[#10B981]' : 'text-[#F5F5F5]'}`}>{d.name}</button>
                              ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    {/* Email */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Email *</label>
                      <input type="email" value={createEmail} onChange={(e) => setCreateEmail(e.target.value)}
                        placeholder="user@company.com" data-testid="user-email-input"
                        className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all" />
                      {emailAvailable === false && <p className="mt-1 text-xs text-[#EF4444]">Email already in use</p>}
                      {emailAvailable === true && <p className="mt-1 text-xs text-[#10B981]">Email available</p>}
                    </div>

                    {/* Name */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Display Name *</label>
                      <input type="text" value={createName} onChange={(e) => setCreateName(e.target.value)}
                        placeholder="John Doe" data-testid="user-name-input"
                        className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all" />
                    </div>

                    {/* Password section */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <label className="text-sm text-[#A3A3A3]">Password</label>
                        <button onClick={() => setAutoPassword(!autoPassword)} data-testid="users-auto-password-toggle"
                          className="flex items-center gap-2 text-xs text-[#A3A3A3] hover:text-[#F5F5F5] transition-colors">
                          <div className={`w-8 h-4.5 rounded-full transition-colors ${autoPassword ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'} relative`}>
                            <div className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${autoPassword ? 'left-4' : 'left-0.5'}`} />
                          </div>
                          Auto-generate
                        </button>
                      </div>
                      {autoPassword ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm font-mono text-[#10B981] flex items-center"
                            data-testid="users-generated-password">
                            {createPassword}
                          </div>
                          <button onClick={() => copyToClipboard(createPassword)} data-testid="users-copy-password-button"
                            className="h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-[#A3A3A3] hover:text-[#10B981] hover:border-[#10B981]/30 transition-colors">
                            <Copy size={14} />
                          </button>
                          <button onClick={() => setCreatePassword(generatePassword())}
                            className="h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-[#A3A3A3] hover:text-[#10B981] hover:border-[#10B981]/30 transition-colors">
                            <RefreshCw size={14} />
                          </button>
                        </div>
                      ) : (
                        <input type="text" value={createPassword} onChange={(e) => setCreatePassword(e.target.value)}
                          placeholder="Min 6 characters"
                          className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none transition-all" />
                      )}
                    </div>

                    {/* Role */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-2 block">Role</label>
                      <div className="space-y-2">
                        {['member', 'admin'].map(role => (
                          <label key={role}
                            className={`flex items-start gap-3 p-3 rounded-[6px] border cursor-pointer transition-colors ${
                              createRole === role ? 'bg-[#10B981]/5 border-[#10B981]/30' : 'bg-[#1A1A1A] border-[#2D2D2D] hover:border-[#10B981]/20'
                            }`}>
                            <input type="radio" name="role" checked={createRole === role}
                              onChange={() => setCreateRole(role)}
                              className="mt-0.5 text-[#10B981] focus:ring-[#10B981]" />
                            <div>
                              <span className="text-sm text-[#F5F5F5] font-medium capitalize">{role}</span>
                              {role === 'admin' && (
                                <p className="text-xs text-[#A3A3A3] mt-0.5">Admins can manage users and departments within this organization</p>
                              )}
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Mobile app access */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-2 block">Mobile App Access</label>
                      <button onClick={() => setCreateMobileAccess(!createMobileAccess)}
                        data-testid="users-create-mobile-access-toggle"
                        className="flex items-center gap-3 w-full p-3 rounded-[6px] bg-[#1A1A1A] border border-[#2D2D2D] hover:border-[#10B981]/20 transition-colors text-left">
                        <div className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${createMobileAccess ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'} relative`}>
                          <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                            style={{ left: createMobileAccess ? '22px' : '2px' }} />
                        </div>
                        <div className="min-w-0">
                          <span className={`text-sm flex items-center gap-1.5 ${createMobileAccess ? 'text-[#10B981]' : 'text-[#A3A3A3]'}`}>
                            <Smartphone size={13} />
                            {createMobileAccess ? 'Allow mobile sign-in' : 'Web only'}
                          </span>
                          <p className="text-xs text-[#A3A3A3] mt-0.5">
                            Mobile access is off by default and can be changed at any time.
                          </p>
                        </div>
                      </button>
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#1F1F1F]">
                  <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Cancel</button>
                  <button onClick={handleCreateUser}
                    disabled={!createOrg || !createDept || !createEmail || !createName || !createPassword || createPassword.length < 6 || emailAvailable === false || createSaving}
                    data-testid="user-create-submit"
                    className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center gap-2">
                    {createSaving && <Loader2 size={14} className="animate-spin" />}
                    Create User
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Edit User Drawer (slides from right) */}
        <AnimatePresence>
          {editUser && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-50" onClick={() => { setEditUser(null); setResetPwResult(null); }}>
              <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
              <motion.div
                initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
                transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                data-testid="users-edit-drawer"
                className="absolute right-0 top-0 h-full w-full sm:w-[420px] bg-[#141414] border-l border-[#1F1F1F] shadow-2xl overflow-y-auto"
              >
                <div className="p-6">
                  <div className="flex items-center justify-between mb-6">
                    <h3 className="text-lg font-semibold text-[#F5F5F5]">Edit User</h3>
                    <button onClick={() => { setEditUser(null); setResetPwResult(null); }}
                      className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">
                      <X size={18} />
                    </button>
                  </div>

                  {/* User info header */}
                  <div className="flex items-center gap-3 mb-6 p-3 bg-[#0F0F0F] rounded-[8px]">
                    <div className="w-10 h-10 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] font-medium">
                      {editUser.display_name?.charAt(0)?.toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-[#F5F5F5]">{editUser.display_name}</p>
                      <p className="text-xs text-[#A3A3A3]">{editUser.email}</p>
                    </div>
                  </div>

                  <div className="space-y-5">
                    {/* Display name */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Display Name</label>
                      <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)}
                        className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none transition-all" />
                    </div>

                    {/* Email (read-only) */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Email</label>
                      <input type="email" value={editUser.email} readOnly
                        className="w-full h-10 px-4 bg-[#0F0F0F] border border-[#1F1F1F] rounded-[6px] text-sm text-[#A3A3A3] cursor-not-allowed" />
                    </div>

                    {/* Department */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Department</label>
                      <div className="relative">
                        <button onClick={() => setEditDeptOpen(!editDeptOpen)}
                          className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-left flex items-center justify-between focus:border-[#10B981] focus:outline-none transition-all">
                          <span className="text-[#F5F5F5]">{editDepts.find(d => d._id === editDeptId)?.name || editUser.dept_name}</span>
                          <ChevronDown size={14} className="text-[#A3A3A3]" />
                        </button>
                        <AnimatePresence>
                          {editDeptOpen && (
                            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                              className="absolute top-full left-0 right-0 mt-1 bg-[#141414] border border-[#1F1F1F] rounded-[6px] shadow-lg z-20 max-h-48 overflow-y-auto">
                              {editDepts.map(d => (
                                <button key={d._id} onClick={() => { setEditDeptId(d._id); setEditDeptOpen(false); }}
                                  className={`w-full px-4 py-2.5 text-sm text-left hover:bg-[#1A1A1A] ${editDeptId === d._id ? 'text-[#10B981]' : 'text-[#F5F5F5]'}`}>{d.name}</button>
                              ))}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>

                    {/* Role */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-2 block">Role</label>
                      <div className="flex gap-2">
                        {['member', 'admin'].map(role => (
                          <button key={role} onClick={() => setEditRole(role)}
                            className={`flex-1 h-10 rounded-[6px] text-sm font-medium capitalize transition-colors ${
                              editRole === role ? 'bg-[#10B981]/10 text-[#10B981] border border-[#10B981]/30' : 'bg-[#1A1A1A] border border-[#2D2D2D] text-[#A3A3A3] hover:text-[#F5F5F5]'
                            }`}>
                            {role}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Status */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-2 block">Status</label>
                      <button onClick={() => setEditActive(!editActive)}
                        className="flex items-center gap-3 w-full p-3 rounded-[6px] bg-[#1A1A1A] border border-[#2D2D2D] hover:border-[#10B981]/20 transition-colors">
                        <div className={`w-10 h-5 rounded-full transition-colors ${editActive ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'} relative`}>
                          <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${editActive ? 'left-5.5' : 'left-0.5'}`}
                            style={{ left: editActive ? '22px' : '2px' }} />
                        </div>
                        <span className={`text-sm ${editActive ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                          {editActive ? 'Active' : 'Inactive'}
                        </span>
                      </button>
                    </div>

                    {/* Mobile app access — the super-admin-only grant. Spelled out
                        rather than labelled with a bare toggle, because "off" here
                        is the reason a user's app says it cannot sign them in. */}
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-2 block">Mobile App Access</label>
                      <button onClick={() => setEditMobileAccess(!editMobileAccess)}
                        data-testid="users-edit-mobile-access-toggle"
                        className="flex items-center gap-3 w-full p-3 rounded-[6px] bg-[#1A1A1A] border border-[#2D2D2D] hover:border-[#10B981]/20 transition-colors text-left">
                        <div className={`w-10 h-5 rounded-full transition-colors flex-shrink-0 ${editMobileAccess ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'} relative`}>
                          <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all"
                            style={{ left: editMobileAccess ? '22px' : '2px' }} />
                        </div>
                        <div className="min-w-0">
                          <span className={`text-sm flex items-center gap-1.5 ${editMobileAccess ? 'text-[#10B981]' : 'text-[#A3A3A3]'}`}>
                            <Smartphone size={13} />
                            {editMobileAccess ? 'Approved for mobile' : 'Web only'}
                          </span>
                          <p className="text-xs text-[#A3A3A3] mt-0.5">
                            {editMobileAccess
                              ? 'This user can sign in to the RxHive iOS app.'
                              : 'This user cannot sign in to the RxHive iOS app.'}
                          </p>
                        </div>
                      </button>
                      {editUser.mobile_access && !editMobileAccess && (
                        <p className="mt-2 text-xs text-[#F59E0B]">
                          Saving will sign this user out of the mobile app. Their web session is unaffected.
                        </p>
                      )}
                    </div>

                    {/* Reset Password */}
                    <div className="pt-2">
                      <button onClick={handleResetPassword} data-testid="users-reset-password-button"
                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium bg-[#1A1A1A] border border-[#2D2D2D] text-[#F59E0B] hover:bg-[#F59E0B]/10 hover:border-[#F59E0B]/30 transition-colors">
                        <RefreshCw size={14} />
                        Reset Password
                      </button>
                      {resetPwResult && (
                        <div className="mt-2 p-3 bg-[#10B981]/5 border border-[#10B981]/20 rounded-[6px]">
                          <p className="text-xs text-[#A3A3A3] mb-1">New password:</p>
                          <div className="flex items-center gap-2">
                            <code className="flex-1 text-sm font-mono text-[#10B981]">{resetPwResult}</code>
                            <button onClick={() => copyToClipboard(resetPwResult)}
                              className="p-1.5 text-[#A3A3A3] hover:text-[#10B981] transition-colors">
                              <Copy size={14} />
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Save/Cancel */}
                  <div className="flex items-center gap-3 mt-8">
                    <button onClick={() => { setEditUser(null); setResetPwResult(null); }}
                      className="flex-1 px-4 py-2.5 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] transition-colors">
                      Cancel
                    </button>
                    <button onClick={handleEditSave} disabled={editSaving} data-testid="users-edit-save-button"
                      className="flex-1 px-4 py-2.5 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2">
                      {editSaving && <Loader2 size={14} className="animate-spin" />}
                      Save Changes
                    </button>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </PageTransition>
  );
}
