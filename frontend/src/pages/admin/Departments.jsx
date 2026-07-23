import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Search, Pencil, Trash2, FolderTree, Loader2, ChevronLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';

export default function Departments() {
  const [orgs, setOrgs] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [orgDropdownOpen, setOrgDropdownOpen] = useState(false);
  const [depts, setDepts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const limit = 10;

  // Modal states
  const [showCreate, setShowCreate] = useState(false);
  const [editDept, setEditDept] = useState(null);
  const [deleteDept, setDeleteDept] = useState(null);

  // Form states
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [formSaving, setFormSaving] = useState(false);

  useEffect(() => {
    const fetchOrgs = async () => {
      try {
        const { data } = await client.get('/api/admin/organizations', { params: { limit: 100 } });
        setOrgs(data.data);
      } catch (err) {
        toast.error('Failed to load organizations');
      }
    };
    fetchOrgs();
  }, []);

  const fetchDepts = useCallback(async () => {
    if (!selectedOrg) return;
    setLoading(true);
    try {
      const { data } = await client.get('/api/admin/departments', {
        params: { org_id: selectedOrg._id, page, limit, search }
      });
      setDepts(data.data);
      setTotal(data.total);
    } catch (err) {
      toast.error('Failed to load departments');
    } finally {
      setLoading(false);
    }
  }, [selectedOrg, page, search]);

  useEffect(() => {
    fetchDepts();
  }, [fetchDepts]);

  const openCreate = () => {
    setFormName('');
    setFormDesc('');
    setShowCreate(true);
  };

  const openEdit = (dept) => {
    setEditDept(dept);
    setFormName(dept.name);
    setFormDesc(dept.description || '');
  };

  const closeModal = () => {
    setShowCreate(false);
    setEditDept(null);
    setFormName('');
    setFormDesc('');
  };

  const handleSave = async () => {
    if (!formName || formName.length < 2) return;
    setFormSaving(true);
    try {
      if (editDept) {
        await client.put(`/api/admin/departments/${editDept._id}`, { name: formName, description: formDesc || null });
        toast.success('Department updated');
      } else {
        await client.post('/api/admin/departments', { org_id: selectedOrg._id, name: formName, description: formDesc || null });
        toast.success('Department created');
      }
      closeModal();
      fetchDepts();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save');
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async () => {
    try {
      await client.delete(`/api/admin/departments/${deleteDept._id}`);
      toast.success('Department deleted');
      setDeleteDept(null);
      fetchDepts();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <PageTransition>
      <div className="max-w-[1400px] mx-auto">
        {/* Org Selector */}
        <div className="mb-6">
          <label className="text-sm text-[#A3A3A3] mb-2 block">Select Organization</label>
          <div className="relative max-w-sm">
            <button
              onClick={() => setOrgDropdownOpen(!orgDropdownOpen)}
              data-testid="departments-org-select"
              className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-left flex items-center justify-between focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all duration-200"
            >
              <span className={selectedOrg ? 'text-[#F5F5F5]' : 'text-[#A3A3A3]'}>
                {selectedOrg?.name || 'Choose an organization...'}
              </span>
              <ChevronDown size={16} className={`text-[#A3A3A3] transition-transform ${orgDropdownOpen ? 'rotate-180' : ''}`} />
            </button>
            <AnimatePresence>
              {orgDropdownOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-full left-0 right-0 mt-1 bg-[#141414] border border-[#1F1F1F] rounded-[6px] shadow-lg z-20 max-h-60 overflow-y-auto"
                >
                  {orgs.length === 0 ? (
                    <p className="px-4 py-3 text-sm text-[#A3A3A3]">No organizations found</p>
                  ) : (
                    orgs.map((org) => (
                      <button
                        key={org._id}
                        onClick={() => {
                          setSelectedOrg(org);
                          setOrgDropdownOpen(false);
                          setPage(1);
                          setSearch('');
                        }}
                        className={`w-full px-4 py-2.5 text-sm text-left hover:bg-[#1A1A1A] transition-colors ${
                          selectedOrg?._id === org._id ? 'text-[#10B981] bg-[#10B981]/5' : 'text-[#F5F5F5]'
                        }`}
                      >
                        {org.name}
                      </button>
                    ))
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {!selectedOrg ? (
          <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-16 text-center">
            <FolderTree size={40} className="text-[#A3A3A3]/30 mx-auto mb-3" />
            <p className="text-[#A3A3A3]">Select an organization to manage its departments</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
              <div className="flex items-center gap-3">
                <h3 className="text-base font-medium text-[#F5F5F5]">{selectedOrg.name} — Departments</h3>
              </div>
              <div className="flex items-center gap-3 w-full sm:w-auto">
                <div className="relative flex-1 sm:flex-initial">
                  <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
                  <input
                    type="text"
                    placeholder="Search departments..."
                    value={search}
                    onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                    data-testid="depts-search-input"
                    className="w-full sm:w-56 h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all duration-200"
                  />
                </div>
                <button
                  onClick={openCreate}
                  data-testid="depts-create-button"
                  className="flex items-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium border border-[#10B981] text-[#10B981] hover:bg-[#10B981] hover:text-[#0A0A0A] transition-all duration-200 active:scale-[0.98] whitespace-nowrap"
                >
                  <Plus size={16} />
                  Create Department
                </button>
              </div>
            </div>

            {/* Table */}
            <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full" data-testid="depts-table">
                  <thead>
                    <tr className="bg-[#0F0F0F] text-[#A3A3A3] text-xs uppercase tracking-wider">
                      <th className="px-6 py-3 text-left">Department Name</th>
                      <th className="px-6 py-3 text-left">Description</th>
                      <th className="px-6 py-3 text-left">Members</th>
                      <th className="px-6 py-3 text-left">Created</th>
                      <th className="px-6 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      [...Array(3)].map((_, i) => (
                        <tr key={i} className="border-t border-[#1F1F1F]">
                          {[...Array(5)].map((_, j) => (
                            <td key={j} className="px-6 py-4">
                              <div className="h-4 bg-[#1A1A1A] rounded animate-pulse" style={{ width: `${50 + Math.random() * 40}%` }} />
                            </td>
                          ))}
                        </tr>
                      ))
                    ) : depts.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-6 py-16 text-center">
                          <FolderTree size={40} className="text-[#A3A3A3]/30 mx-auto mb-3" />
                          <p className="text-[#A3A3A3] mb-4">No departments in this organization</p>
                          <button
                            onClick={openCreate}
                            className="px-4 py-2 rounded-[6px] text-sm font-medium bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] transition-all duration-200"
                          >
                            Create Department
                          </button>
                        </td>
                      </tr>
                    ) : (
                      <AnimatePresence>
                        {depts.map((dept, index) => (
                          <motion.tr
                            key={dept._id}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ delay: index * 0.04 }}
                            className="border-t border-[#1F1F1F] hover:bg-[#1A1A1A] transition-colors duration-150"
                            data-testid="depts-table-row"
                          >
                            <td className="px-6 py-4">
                              <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-[6px] bg-[#10B981]/10 flex items-center justify-center">
                                  <FolderTree size={14} className="text-[#10B981]" />
                                </div>
                                <span className="text-sm font-medium text-[#F5F5F5]">{dept.name}</span>
                              </div>
                            </td>
                            <td className="px-6 py-4 text-sm text-[#A3A3A3] max-w-[200px] truncate">
                              {dept.description || '—'}
                            </td>
                            <td className="px-6 py-4 text-sm text-[#F5F5F5]">{dept.member_count ?? 0}</td>
                            <td className="px-6 py-4 text-sm text-[#A3A3A3]">
                              {dept.created_at ? new Date(dept.created_at).toLocaleDateString() : ''}
                            </td>
                            <td className="px-6 py-4">
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  onClick={() => openEdit(dept)}
                                  className="p-2 text-[#A3A3A3] hover:text-[#10B981] hover:bg-[#10B981]/10 rounded-[6px] transition-colors duration-150"
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  onClick={() => setDeleteDept(dept)}
                                  className="p-2 text-[#A3A3A3] hover:text-[#EF4444] hover:bg-[#EF4444]/10 rounded-[6px] transition-colors duration-150"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
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
                      <button key={p} onClick={() => setPage(p)} className={`w-8 h-8 rounded-[6px] text-xs font-medium transition-colors ${page === p ? 'bg-[#10B981] text-[#0A0A0A]' : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A]'}`}>
                        {p}
                      </button>
                    ))}
                    <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="p-1.5 rounded-[6px] text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* Create/Edit Modal */}
        <AnimatePresence>
          {(showCreate || editDept) && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              onClick={closeModal}
            >
              <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] w-full max-w-md shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)]"
              >
                <div className="p-6">
                  <h3 className="text-lg font-semibold text-[#F5F5F5] mb-6">
                    {editDept ? 'Edit Department' : 'Create Department'}
                  </h3>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Department Name *</label>
                      <input
                        type="text"
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder="e.g. Engineering"
                        data-testid="dept-name-input"
                        className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all duration-200"
                      />
                    </div>
                    <div>
                      <label className="text-sm text-[#A3A3A3] mb-1.5 block">Description</label>
                      <textarea
                        value={formDesc}
                        onChange={(e) => setFormDesc(e.target.value)}
                        placeholder="Optional description..."
                        data-testid="dept-desc-input"
                        rows={3}
                        className="w-full px-4 py-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all duration-200 resize-none"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#1F1F1F]">
                  <button onClick={closeModal} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Cancel</button>
                  <button
                    onClick={handleSave}
                    disabled={!formName || formName.length < 2 || formSaving}
                    data-testid="dept-save-button"
                    className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center gap-2"
                  >
                    {formSaving && <Loader2 size={14} className="animate-spin" />}
                    {editDept ? 'Save Changes' : 'Create'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Delete Confirmation Modal */}
        <AnimatePresence>
          {deleteDept && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              onClick={() => setDeleteDept(null)}
            >
              <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
                onClick={(e) => e.stopPropagation()}
                className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] w-full max-w-md shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)]"
              >
                <div className="p-6">
                  <h3 className="text-lg font-semibold text-[#F5F5F5] mb-2">Delete Department</h3>
                  <p className="text-sm text-[#A3A3A3]">
                    Are you sure you want to delete <span className="text-[#F5F5F5] font-medium">{deleteDept.name}</span>?
                  </p>
                  {deleteDept.member_count > 0 && (
                    <div className="mt-3 p-3 bg-[#EF4444]/5 border border-[#EF4444]/20 rounded-[6px]">
                      <p className="text-xs text-[#EF4444]">This department has {deleteDept.member_count} active member(s). Remove or reassign them first.</p>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#1F1F1F]">
                  <button onClick={() => setDeleteDept(null)} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Cancel</button>
                  <button
                    onClick={handleDelete}
                    data-testid="dept-delete-confirm"
                    className="px-4 py-2 text-sm font-medium bg-[#EF4444] text-white rounded-[6px] hover:opacity-90 transition-all duration-200"
                  >
                    Delete
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </PageTransition>
  );
}
