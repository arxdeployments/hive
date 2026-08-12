import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Plus, Pencil, Trash2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import { useAuth } from '../../contexts/AuthContext';
import client from '../../api/client';

export default function OrgAdminDepartments() {
  const { user: me } = useAuth();
  // Empty means organization-wide, matching org_admin.managed_dept_ids. A
  // department-scoped admin cannot add departments: the new one would fall
  // outside their scope the moment it existed, so it would vanish from this very
  // table and they could neither staff it nor rename it.
  const managed = me?.managed_departments || [];
  const scoped = managed.length > 0;

  const [depts, setDepts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editDept, setEditDept] = useState(null);
  const [formName, setFormName] = useState('');
  const [formDesc, setFormDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  // Same defect and same fix as the dashboard beside it: a swallowed failure
  // rendered as "No departments yet", which is a statement about the org made
  // on the strength of a request that never came back. Fixed here in the same
  // change, or the portal would be honest on one page and lying on the next.
  const fetchDepts = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/api/org-admin/departments');
      setDepts(data);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { fetchDepts(); }, [fetchDepts]);

  const openCreate = () => { setEditDept(null); setFormName(''); setFormDesc(''); setShowModal(true); };
  const openEdit = (d) => { setEditDept(d); setFormName(d.name); setFormDesc(d.description || ''); setShowModal(true); };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (editDept) {
        await client.put(`/api/org-admin/departments/${editDept._id}`, { name: formName, description: formDesc || null });
        toast.success('Department updated');
      } else {
        await client.post('/api/org-admin/departments', { name: formName, description: formDesc || null });
        toast.success('Department created');
      }
      setShowModal(false); fetchDepts();
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = async (dept) => {
    if (!window.confirm(`Delete department "${dept.name}"?`)) return;
    try { await client.delete(`/api/org-admin/departments/${dept._id}`); toast.success('Deleted'); fetchDepts(); }
    catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
  };

  return (
    <PageTransition>
      <div className="max-w-[1200px]">
        {/* gap-4 and the flex-wrap matter: justify-between with a long text node
            instead of a button leaves the two children touching as soon as they
            fill the row, which reads as one run-on sentence. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 mb-6">
          <h2 className="text-lg font-semibold text-[#F5F5F5]">Departments</h2>
          {scoped ? (
            <span className="text-xs text-[#A3A3A3] sm:text-right">
              You manage {managed.length === 1 ? 'this department' : 'these departments'}. Ask a super admin to add more.
            </span>
          ) : (
            <button onClick={openCreate}
              className="flex items-center gap-2 px-4 py-2.5 rounded-[6px] text-sm font-medium border border-[#10B981] text-[#10B981] hover:bg-[#10B981] hover:text-[#0A0A0A] transition-all">
              <Plus size={16} /> Create Department
            </button>
          )}
        </div>

        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-[#0F0F0F] text-[#A3A3A3] text-xs uppercase tracking-wider">
                <th className="px-6 py-3 text-left">Name</th>
                <th className="px-6 py-3 text-left">Description</th>
                <th className="px-6 py-3 text-left">Members</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? [...Array(3)].map((_, i) => (
                <tr key={i} className="border-t border-[#1F1F1F]"><td colSpan={4} className="px-6 py-4"><div className="h-4 bg-[#1A1A1A] rounded animate-pulse" /></td></tr>
              )) : depts.length === 0 && error ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center" data-testid="departments-load-error">
                  <p className="text-sm text-[#A3A3A3] mb-3">Couldn&apos;t load departments.</p>
                  <button type="button" onClick={fetchDepts} data-testid="departments-retry"
                    className="px-3 py-1.5 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors">
                    Try again
                  </button>
                </td></tr>
              ) : depts.length === 0 ? (
                <tr><td colSpan={4} className="px-6 py-12 text-center text-sm text-[#A3A3A3]">No departments yet</td></tr>
              ) : (<>
                {/* A refresh that failed over rows we still have. The branch
                    above cannot cover it — that one is gated on the list being
                    empty — so a failed retry, save-refresh or delete-refresh left
                    the table showing a list it could no longer vouch for, with
                    nothing on screen to say so and no way to try again. `setDepts`
                    only runs on success, which is what keeps these rows here, and
                    is also why the failure is otherwise invisible.
                    role on the span, not the row: a role on <tr> would override
                    its table-row semantics for assistive tech. */}
                {error && (
                  <tr data-testid="departments-refresh-error">
                    <td colSpan={4} className="px-6 py-2 bg-[#1A1A1A]/60 border-t border-[#1F1F1F]">
                      <div className="flex items-center justify-between gap-2">
                        <span role="alert" className="text-xs text-[#A3A3A3]">
                          Couldn&apos;t refresh departments — showing the last list that loaded.
                        </span>
                        <button
                          type="button"
                          onClick={fetchDepts}
                          data-testid="departments-refresh-retry"
                          className="px-2 py-1 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors shrink-0"
                        >
                          Try again
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
                {depts.map((dept, idx) => (
                <motion.tr key={dept._id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: idx * 0.03 }}
                  className="border-t border-[#1F1F1F] hover:bg-[#1A1A1A] transition-colors">
                  <td className="px-6 py-4 text-sm font-medium text-[#F5F5F5]">{dept.name}</td>
                  <td className="px-6 py-4 text-sm text-[#A3A3A3]">{dept.description || '—'}</td>
                  <td className="px-6 py-4 text-sm text-[#F5F5F5]">{dept.member_count ?? 0}</td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => openEdit(dept)} className="p-2 text-[#A3A3A3] hover:text-[#10B981] rounded transition-colors"><Pencil size={14} /></button>
                      <button onClick={() => handleDelete(dept)} className="p-2 text-[#A3A3A3] hover:text-[#EF4444] rounded transition-colors"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </motion.tr>
                ))}
              </>)}
            </tbody>
          </table>
        </div>

        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowModal(false)}>
            <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
            <div className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
              <h3 className="text-lg font-semibold text-[#F5F5F5] mb-4">{editDept ? 'Edit Department' : 'Create Department'}</h3>
              <div className="space-y-4">
                <div><label htmlFor="orgadmindepartments-01-name" className="text-sm text-[#A3A3A3] mb-1.5 block">Name *</label>
                  <input id="orgadmindepartments-01-name" value={formName} onChange={e => setFormName(e.target.value)}
                    className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none" /></div>
                <div><label htmlFor="orgadmindepartments-02-description" className="text-sm text-[#A3A3A3] mb-1.5 block">Description</label>
                  <textarea id="orgadmindepartments-02-description" value={formDesc} onChange={e => setFormDesc(e.target.value)} rows={2}
                    className="w-full px-4 py-2 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none resize-none" /></div>
              </div>
              <div className="flex justify-end gap-3 mt-6">
                <button onClick={() => setShowModal(false)} className="px-4 py-2 text-sm text-[#A3A3A3] rounded-[6px]">Cancel</button>
                <button onClick={handleSave} disabled={!formName.trim() || saving}
                  className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 flex items-center gap-2">
                  {saving && <Loader2 size={14} className="animate-spin" />} {editDept ? 'Save' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}
