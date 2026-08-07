import { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Plus, Search, Pencil, Trash2, Building2, Loader2, ChevronLeft, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';

export default function Organizations() {
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [sortField, setSortField] = useState('created_at');
  const [sortOrder, setSortOrder] = useState('desc');
  const limit = 10;

  // Modal states
  const [showCreate, setShowCreate] = useState(false);
  const [editOrg, setEditOrg] = useState(null);
  const [deleteOrg, setDeleteOrg] = useState(null);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');

  // Form states
  const [formName, setFormName] = useState('');
  const [formSlug, setFormSlug] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  const [nameAvailable, setNameAvailable] = useState(null);

  const fetchOrgs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/api/admin/organizations', {
        params: { page, limit, search, sort: sortField, order: sortOrder }
      });
      setOrgs(data.data);
      setTotal(data.total);
    } catch {
      toast.error('Failed to load organizations');
    } finally {
      setLoading(false);
    }
  }, [page, search, sortField, sortOrder]);

  useEffect(() => {
    fetchOrgs();
  }, [fetchOrgs]);

  // Debounced name validation
  useEffect(() => {
    if (!formName || formName.length < 2) {
      setNameAvailable(null);
      setFormSlug('');
      return;
    }
    const slug = formName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    setFormSlug(slug);

    const timer = setTimeout(async () => {
      try {
        const { data } = await client.get('/api/admin/validate/org-name', {
          params: { name: formName, exclude_id: editOrg?._id }
        });
        setNameAvailable(data.available);
      } catch {
        setNameAvailable(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [formName, editOrg]);

  const handleSort = (field) => {
    if (sortField === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const openCreate = () => {
    setFormName('');
    setFormSlug('');
    setNameAvailable(null);
    setShowCreate(true);
  };

  const openEdit = (org) => {
    setEditOrg(org);
    setFormName(org.name);
    setFormSlug(org.slug);
    setNameAvailable(null);
  };

  const closeModal = () => {
    setShowCreate(false);
    setEditOrg(null);
    setFormName('');
    setFormSlug('');
    setNameAvailable(null);
  };

  const handleSave = async () => {
    if (!formName || formName.length < 2) return;
    setFormSaving(true);
    try {
      if (editOrg) {
        await client.put(`/api/admin/organizations/${editOrg._id}`, { name: formName });
        toast.success('Organization updated');
      } else {
        await client.post('/api/admin/organizations', { name: formName });
        toast.success('Organization created');
      }
      closeModal();
      fetchOrgs();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to save');
    } finally {
      setFormSaving(false);
    }
  };

  const handleToggleStatus = async (org) => {
    try {
      await client.put(`/api/admin/organizations/${org._id}`, { is_active: !org.is_active });
      toast.success(`Organization ${org.is_active ? 'deactivated' : 'activated'}`);
      fetchOrgs();
    } catch {
      toast.error('Failed to update status');
    }
  };

  const handleDelete = async () => {
    if (deleteConfirmName !== deleteOrg.name) return;
    try {
      await client.delete(`/api/admin/organizations/${deleteOrg._id}`);
      toast.success('Organization deactivated');
      setDeleteOrg(null);
      setDeleteConfirmName('');
      fetchOrgs();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to delete');
    }
  };

  const totalPages = Math.ceil(total / limit);

  return (
    <PageTransition>
      <div className="max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
          <div className="relative flex-1 max-w-sm">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
            <input
              type="text"
              placeholder="Search organizations..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              data-testid="orgs-search-input"
              className="w-full h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all duration-200"
            />
          </div>
          <button
            onClick={openCreate}
            data-testid="orgs-create-button"
            className="flex items-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium border border-[#10B981] text-[#10B981] hover:bg-[#10B981] hover:text-[#0A0A0A] transition-all duration-200 active:scale-[0.98]"
          >
            <Plus size={16} />
            Create Organization
          </button>
        </div>

        {/* Table */}
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full" data-testid="orgs-table">
              <thead>
                <tr className="bg-[#0F0F0F] text-[#A3A3A3] text-xs uppercase tracking-wider">
                  <th className="px-6 py-3 text-left cursor-pointer hover:text-[#F5F5F5] transition-colors" onClick={() => handleSort('name')}>
                    Name {sortField === 'name' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th className="px-6 py-3 text-left">Slug</th>
                  <th className="px-6 py-3 text-left">Departments</th>
                  <th className="px-6 py-3 text-left">Users</th>
                  <th className="px-6 py-3 text-left">Status</th>
                  <th className="px-6 py-3 text-left cursor-pointer hover:text-[#F5F5F5] transition-colors" onClick={() => handleSort('created_at')}>
                    Created {sortField === 'created_at' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  [...Array(5)].map((_, i) => (
                    <tr key={i} className="border-t border-[#1F1F1F]">
                      {[...Array(7)].map((_, j) => (
                        <td key={j} className="px-6 py-4">
                          <div className="h-4 bg-[#1A1A1A] rounded animate-pulse" style={{ width: `${60 + Math.random() * 40}%` }} />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : orgs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-16 text-center">
                      <Building2 size={40} className="text-[#A3A3A3]/30 mx-auto mb-3" />
                      <p className="text-[#A3A3A3] mb-4">No organizations yet. Create your first one.</p>
                      <button
                        onClick={openCreate}
                        className="px-4 py-2 rounded-[6px] text-sm font-medium bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] transition-all duration-200"
                      >
                        Create Organization
                      </button>
                    </td>
                  </tr>
                ) : (
                  <AnimatePresence>
                    {orgs.map((org, index) => (
                      <motion.tr
                        key={org._id}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.04 }}
                        className="border-t border-[#1F1F1F] hover:bg-[#1A1A1A] transition-colors duration-150"
                        data-testid="orgs-table-row"
                      >
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-[6px] bg-[#10B981]/10 flex items-center justify-center">
                              <Building2 size={14} className="text-[#10B981]" />
                            </div>
                            <span className="text-sm font-medium text-[#F5F5F5]">{org.name}</span>
                          </div>
                        </td>
                        <td className="px-6 py-4 text-sm text-[#A3A3A3] font-mono">{org.slug}</td>
                        <td className="px-6 py-4 text-sm text-[#F5F5F5]">{org.dept_count ?? 0}</td>
                        <td className="px-6 py-4 text-sm text-[#F5F5F5]">{org.user_count ?? 0}</td>
                        <td className="px-6 py-4">
                          <button
                            onClick={() => handleToggleStatus(org)}
                            className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium transition-colors duration-150 ${
                              org.is_active
                                ? 'bg-[#10B981]/10 text-[#10B981] hover:bg-[#10B981]/20'
                                : 'bg-[#EF4444]/10 text-[#EF4444] hover:bg-[#EF4444]/20'
                            }`}
                          >
                            {org.is_active ? 'Active' : 'Inactive'}
                          </button>
                        </td>
                        <td className="px-6 py-4 text-sm text-[#A3A3A3]">
                          {org.created_at ? new Date(org.created_at).toLocaleDateString() : ''}
                        </td>
                        <td className="px-6 py-4">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => openEdit(org)}
                              className="p-2 text-[#A3A3A3] hover:text-[#10B981] hover:bg-[#10B981]/10 rounded-[6px] transition-colors duration-150"
                              data-testid={`orgs-edit-${org._id}`}
                            >
                              <Pencil size={14} />
                            </button>
                            <button
                              onClick={() => { setDeleteOrg(org); setDeleteConfirmName(''); }}
                              className="p-2 text-[#A3A3A3] hover:text-[#EF4444] hover:bg-[#EF4444]/10 rounded-[6px] transition-colors duration-150"
                              data-testid="orgs-delete-button"
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

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-[#1F1F1F]">
              <span className="text-xs text-[#A3A3A3]">
                Showing {(page - 1) * limit + 1}-{Math.min(page * limit, total)} of {total}
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="p-1.5 rounded-[6px] text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronLeft size={16} />
                </button>
                {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 5) pageNum = i + 1;
                  else if (page <= 3) pageNum = i + 1;
                  else if (page >= totalPages - 2) pageNum = totalPages - 4 + i;
                  else pageNum = page - 2 + i;
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setPage(pageNum)}
                      className={`w-8 h-8 rounded-[6px] text-xs font-medium transition-colors ${
                        page === pageNum
                          ? 'bg-[#10B981] text-[#0A0A0A]'
                          : 'text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A]'
                      }`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="p-1.5 rounded-[6px] text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Create/Edit Modal */}
        <AnimatePresence>
          {(showCreate || editOrg) && (
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
                    {editOrg ? 'Edit Organization' : 'Create Organization'}
                  </h3>

                  <div className="space-y-4">
                    <div>
                      <label htmlFor="organizations-01-organization-name" className="text-sm text-[#A3A3A3] mb-1.5 block">Organization Name *</label>
                      <input id="organizations-01-organization-name"
                        type="text"
                        value={formName}
                        onChange={(e) => setFormName(e.target.value)}
                        placeholder="e.g. Acme Corp"
                        data-testid="org-name-input"
                        className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all duration-200"
                      />
                      {formSlug && (
                        <p className="mt-1.5 text-xs text-[#A3A3A3]">
                          Slug: <span className="font-mono text-[#10B981]">{formSlug}</span>
                          {nameAvailable === false && (
                            <span className="text-[#EF4444] ml-2">Name already taken</span>
                          )}
                          {nameAvailable === true && (
                            <span className="text-[#10B981] ml-2">Available</span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#1F1F1F]">
                  <button
                    onClick={closeModal}
                    className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors duration-150"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={!formName || formName.length < 2 || nameAvailable === false || formSaving}
                    data-testid="org-save-button"
                    className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center gap-2"
                  >
                    {formSaving && <Loader2 size={14} className="animate-spin" />}
                    {editOrg ? 'Save Changes' : 'Create'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Delete Confirmation Modal */}
        <AnimatePresence>
          {deleteOrg && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-50 flex items-center justify-center p-4"
              onClick={() => { setDeleteOrg(null); setDeleteConfirmName(''); }}
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
                  <h3 className="text-lg font-semibold text-[#F5F5F5] mb-2">Delete Organization</h3>
                  <p className="text-sm text-[#A3A3A3] mb-4">
                    Are you sure you want to delete <span className="text-[#F5F5F5] font-medium">{deleteOrg.name}</span>?
                  </p>
                  <div className="p-3 bg-[#EF4444]/5 border border-[#EF4444]/20 rounded-[6px] mb-4">
                    <p className="text-xs text-[#EF4444]">
                      This will deactivate all users and departments in this organization.
                    </p>
                  </div>
                  <label htmlFor="organizations-delete-confirm" className="text-sm text-[#A3A3A3] mb-1.5 block">
                    Type <span className="font-mono text-[#F5F5F5]">{deleteOrg.name}</span> to confirm
                  </label>
                  <input
                    id="organizations-delete-confirm"
                    type="text"
                    value={deleteConfirmName}
                    onChange={(e) => setDeleteConfirmName(e.target.value)}
                    data-testid="orgs-delete-confirm-input"
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#EF4444] focus:outline-none transition-all duration-200"
                    placeholder={deleteOrg.name}
                  />
                </div>
                <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-[#1F1F1F]">
                  <button
                    onClick={() => { setDeleteOrg(null); setDeleteConfirmName(''); }}
                    className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleteConfirmName !== deleteOrg.name}
                    data-testid="orgs-delete-confirm-submit"
                    className="px-4 py-2 text-sm font-medium bg-[#EF4444] text-white rounded-[6px] hover:opacity-90 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200"
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
