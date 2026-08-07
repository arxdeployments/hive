import { useEffect, useState } from 'react';
import { Pencil, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';

export default function OrgAdminSettings() {
  const [org, setOrg] = useState(null);
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    client.get('/api/org-admin/settings').then(r => setOrg(r.data)).catch(() => {});
  }, []);

  const handleSaveName = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      const { data } = await client.put('/api/org-admin/settings', { name: newName.trim() });
      setOrg(data); setEditingName(false); toast.success('Name updated');
    } catch (err) { toast.error(err.response?.data?.detail || 'Failed'); }
    finally { setSaving(false); }
  };

  if (!org) return <div className="text-center py-12 text-[#A3A3A3]">Loading...</div>;

  return (
    <PageTransition>
      <div className="max-w-[600px]">
        <h2 className="text-lg font-semibold text-[#F5F5F5] mb-6">Organization Settings</h2>
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-6 space-y-6">
          <div>
            <label htmlFor="orgadminsettings-01-organization-name" className="text-sm text-[#A3A3A3] mb-1.5 block">Organization Name</label>
            {editingName ? (
              <div className="flex gap-2">
                <input id="orgadminsettings-01-organization-name" value={newName} onChange={e => setNewName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveName(); if (e.key === 'Escape') setEditingName(false); }}
                  autoFocus
                  className="flex-1 h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] focus:border-[#10B981] focus:outline-none" />
                <button onClick={handleSaveName} disabled={saving}
                  className="px-4 h-10 bg-[#10B981] text-[#0A0A0A] rounded-[6px] text-sm font-medium hover:bg-[#059669] disabled:opacity-50">
                  {saving ? <Loader2 size={14} className="animate-spin" /> : 'Save'}
                </button>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <p className="text-base text-[#F5F5F5]">{org.name}</p>
                <button onClick={() => { setNewName(org.name); setEditingName(true); }}
                  className="p-1.5 text-[#A3A3A3] hover:text-[#10B981] transition-colors"><Pencil size={14} /></button>
              </div>
            )}
          </div>
          <div>
            <span className="text-sm text-[#A3A3A3] mb-1.5 block">Slug</span>
            <p className="text-sm text-[#A3A3A3] font-mono">{org.slug}</p>
          </div>
          <div>
            <span className="text-sm text-[#A3A3A3] mb-1.5 block">Created</span>
            <p className="text-sm text-[#A3A3A3]">{org.created_at ? new Date(org.created_at).toLocaleDateString() : 'N/A'}</p>
          </div>
        </div>
      </div>
    </PageTransition>
  );
}
