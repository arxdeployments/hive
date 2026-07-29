import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Check, Loader2, Plus, ShieldCheck, Trash2, Users, X } from 'lucide-react';
import { toast } from 'sonner';
import { PageTransition } from '../../components/common/PageTransition';
import client from '../../api/client';

/**
 * Super-admin authoring for who may chat with whom, and what they may send.
 *
 * THREE THINGS THIS SCREEN HAS TO MAKE OBVIOUS, because the model is not
 * self-evident from a list of rows:
 *
 *  1. Reachability is DENY BY DEFAULT. An empty rule list means nobody can
 *     start a conversation, so "no rules" must not read as "no restrictions".
 *  2. MOST SPECIFIC WINS, and a user-level allow can override a department
 *     deny. A flat list would make the overridden rule look broken, which is
 *     what the Check pair tool is for — it names the rule that actually decided.
 *  3. Send policy is the opposite: ALLOW by default. Deleting a send policy
 *     LOOSENS, deleting an access rule TIGHTENS. Both destructive-looking
 *     buttons therefore say which way they move.
 */

const TABS = [
  { id: 'rules', label: 'Who can chat', icon: Users },
  { id: 'send', label: 'What can be sent', icon: ShieldCheck },
  { id: 'delegation', label: 'Admin departments', icon: Building2 },
];

const LEVEL_LABEL = { 3: 'Person → person', 2: 'Person → department', 1: 'Department → department' };

const card = 'bg-[#141414] border border-[#1F1F1F] rounded-[10px]';
const inputCls =
  'bg-[#0A0A0A] border border-[#2D2D2D] rounded-[6px] px-3 py-2 text-sm text-[#F5F5F5] focus:border-[#10B981] outline-none';
const btnPrimary =
  'px-3 py-2 text-sm font-medium rounded-[6px] bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] disabled:opacity-40 disabled:cursor-not-allowed transition-colors';

/** A user/department picker that emits the {type,id} shape the API expects. */
const PartyPicker = ({ users, departments, value, onChange, testId }) => (
  <select
    value={value ? `${value.type}:${value.id}` : ''}
    onChange={(e) => {
      const raw = e.target.value;
      if (!raw) return onChange(null);
      const [type, id] = raw.split(':');
      return onChange({ type, id });
    }}
    data-testid={testId}
    className={`${inputCls} min-w-[190px]`}
  >
    <option value="">Select…</option>
    <optgroup label="Departments">
      {departments.map((d) => (
        <option key={d.id} value={`department:${d.id}`}>{d.name}</option>
      ))}
    </optgroup>
    <optgroup label="People">
      {users.map((u) => (
        <option key={u.id} value={`user:${u.id}`}>{u.display_name}</option>
      ))}
    </optgroup>
  </select>
);

const Toggle = ({ label, checked, onChange, hint }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="w-full flex items-center justify-between gap-4 px-3 py-2.5 rounded-[6px] hover:bg-[#1A1A1A] text-left transition-colors"
  >
    <span className="min-w-0">
      <span className="block text-sm text-[#F5F5F5]">{label}</span>
      {hint && <span className="block text-xs text-[#A3A3A3] mt-0.5">{hint}</span>}
    </span>
    <span
      className={`relative inline-block h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-[2px]'
        }`}
      />
    </span>
  </button>
);

export default function AccessControl() {
  const [orgs, setOrgs] = useState([]);
  const [orgId, setOrgId] = useState('');
  const [tab, setTab] = useState('rules');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const [users, setUsers] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [rules, setRules] = useState([]);
  const [policies, setPolicies] = useState([]);
  const [docExts, setDocExts] = useState([]);
  const [admins, setAdmins] = useState([]);

  const [newA, setNewA] = useState(null);
  const [newB, setNewB] = useState(null);
  const [newAllow, setNewAllow] = useState(true);

  const [checkA, setCheckA] = useState('');
  const [checkB, setCheckB] = useState('');
  const [checkResult, setCheckResult] = useState(null);

  const [policyScope, setPolicyScope] = useState(null);
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    client
      .get('/api/admin/organizations')
      .then(({ data }) => {
        const list = data?.data || data || [];
        setOrgs(list);
        if (list.length && !orgId) setOrgId(list[0]._id || list[0].id);
      })
      .catch(() => toast.error('Could not load organizations'))
      .finally(() => setLoading(false));
    // Deliberately once on mount: orgId is seeded here and owned by the select
    // afterwards, so depending on it would re-seed and fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const [u, d, r, p, a] = await Promise.all([
        client.get('/api/admin/users', { params: { org_id: orgId, limit: 500 } }),
        client.get('/api/admin/departments', { params: { org_id: orgId } }),
        client.get('/api/admin/access/rules', { params: { org_id: orgId } }),
        client.get('/api/admin/access/send-policies', { params: { org_id: orgId } }),
        client.get('/api/admin/access/admin-departments', { params: { org_id: orgId } }),
      ]);
      setUsers((u.data?.data || u.data || []).map((x) => ({ id: x._id || x.id, display_name: x.display_name })));
      setDepartments((d.data?.data || d.data || []).map((x) => ({ id: x._id || x.id, name: x.name })));
      setRules(r.data?.data || []);
      setPolicies(p.data?.data || []);
      setDocExts(p.data?.document_extensions || []);
      setAdmins(a.data?.data || []);
    } catch {
      toast.error('Could not load access control data');
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { load(); }, [load]);

  const addRule = async () => {
    if (!newA || !newB) return;
    setBusy(true);
    try {
      await client.put('/api/admin/access/rules', { org_id: orgId, a: newA, b: newB, allow: newAllow });
      toast.success(newAllow ? 'Pair allowed' : 'Pair blocked');
      setNewA(null); setNewB(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save the rule');
    } finally {
      setBusy(false);
    }
  };

  const removeRule = async (id) => {
    setBusy(true);
    try {
      const { data } = await client.delete(`/api/admin/access/rules/${id}`);
      // Removing an ALLOW re-blocks the pair — say so rather than a bare "Deleted".
      toast.success(data?.note ? `Rule removed — ${data.note}` : 'Rule removed');
      await load();
    } catch {
      toast.error('Could not remove the rule');
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async () => {
    if (!checkA || !checkB) return;
    try {
      const { data } = await client.get('/api/admin/access/explain', {
        params: { user_a: checkA, user_b: checkB },
      });
      setCheckResult(data);
    } catch {
      toast.error('Could not evaluate that pair');
    }
  };

  const openPolicy = (scope, existing) => {
    setPolicyScope(scope);
    setDraft(
      existing || {
        allow_text: true, allow_image: true, allow_video: true,
        allow_audio: true, allow_document: true, doc_extensions: null,
      }
    );
  };

  const savePolicy = async () => {
    setBusy(true);
    try {
      await client.put('/api/admin/access/send-policies', {
        org_id: orgId,
        scope: policyScope,
        allow_text: draft.allow_text,
        allow_image: draft.allow_image,
        allow_video: draft.allow_video,
        allow_audio: draft.allow_audio,
        allow_document: draft.allow_document,
        doc_extensions: draft.doc_extensions,
      });
      toast.success('Send policy saved');
      setPolicyScope(null); setDraft(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Could not save the policy');
    } finally {
      setBusy(false);
    }
  };

  const removePolicy = async (id) => {
    setBusy(true);
    try {
      const { data } = await client.delete(`/api/admin/access/send-policies/${id}`);
      toast.success(data?.note ? `Policy removed — ${data.note}` : 'Policy removed');
      await load();
    } catch {
      toast.error('Could not remove the policy');
    } finally {
      setBusy(false);
    }
  };

  const setAdminDepts = async (userId, deptIds) => {
    setBusy(true);
    try {
      const { data } = await client.put(`/api/admin/access/admin-departments/${userId}`, {
        department_ids: deptIds,
      });
      toast.success(data.org_wide ? 'Admin now covers the whole organization' : 'Departments updated');
      await load();
    } catch {
      toast.error('Could not update departments');
    } finally {
      setBusy(false);
    }
  };

  return (
    <PageTransition>
      <div className="space-y-5" data-testid="admin-access-control">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-[#F5F5F5]">Access control</h1>
            <p className="text-sm text-[#A3A3A3] mt-1">
              Who may hold a conversation, and what they may send.
            </p>
          </div>
          <select
            value={orgId}
            onChange={(e) => { setOrgId(e.target.value); setCheckResult(null); }}
            data-testid="access-org-select"
            className={inputCls}
          >
            {orgs.map((o) => (
              <option key={o._id || o.id} value={o._id || o.id}>{o.name}</option>
            ))}
          </select>
        </div>

        <div className="flex gap-1 border-b border-[#1F1F1F]">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                data-testid={`access-tab-${t.id}`}
                className={`flex items-center gap-2 px-3 py-2 text-sm border-b-2 transition-colors ${
                  tab === t.id
                    ? 'border-[#10B981] text-[#10B981]'
                    : 'border-transparent text-[#A3A3A3] hover:text-[#F5F5F5]'
                }`}
              >
                <Icon size={15} /> {t.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="animate-spin text-[#10B981]" size={22} />
          </div>
        ) : tab === 'rules' ? (
          <div className="space-y-4">
            {/* The single most important sentence on this screen. */}
            <div className="rounded-[8px] border border-[#10B981]/30 bg-[#10B981]/5 px-4 py-3">
              <p className="text-sm text-[#F5F5F5]">Nobody can chat unless a rule permits it.</p>
              <p className="text-xs text-[#A3A3A3] mt-1">
                The most specific rule wins — a person-to-person rule overrides a department one, in
                either direction. When two equally specific rules disagree, the block wins.
              </p>
            </div>

            <div className={`${card} p-4`}>
              <h2 className="text-sm font-medium text-[#F5F5F5] mb-3">Add a rule</h2>
              <div className="flex flex-wrap items-center gap-2">
                <PartyPicker users={users} departments={departments} value={newA} onChange={setNewA} testId="rule-party-a" />
                <span className="text-xs text-[#A3A3A3]">and</span>
                <PartyPicker users={users} departments={departments} value={newB} onChange={setNewB} testId="rule-party-b" />
                <select
                  value={newAllow ? 'allow' : 'block'}
                  onChange={(e) => setNewAllow(e.target.value === 'allow')}
                  className={inputCls}
                  data-testid="rule-verdict"
                >
                  <option value="allow">may chat</option>
                  <option value="block">may not chat</option>
                </select>
                <button type="button" onClick={addRule} disabled={!newA || !newB || busy} className={btnPrimary} data-testid="rule-add">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
                </button>
              </div>
            </div>

            <div className={`${card} p-4`}>
              <h2 className="text-sm font-medium text-[#F5F5F5] mb-1">Check a pair</h2>
              <p className="text-xs text-[#A3A3A3] mb-3">
                Shows which rule actually decides, including ones it overrides.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select value={checkA} onChange={(e) => setCheckA(e.target.value)} className={inputCls} data-testid="check-user-a">
                  <option value="">Person…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
                <select value={checkB} onChange={(e) => setCheckB(e.target.value)} className={inputCls} data-testid="check-user-b">
                  <option value="">Person…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
                </select>
                <button type="button" onClick={runCheck} disabled={!checkA || !checkB} className={btnPrimary} data-testid="check-run">
                  Check
                </button>
              </div>
              {checkResult && (
                <div className="mt-3 space-y-2" data-testid="check-result">
                  <p className={`text-sm font-medium ${checkResult.allowed ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                    {checkResult.allowed ? 'Allowed' : 'Blocked'}
                    {checkResult.reason ? ` — ${checkResult.reason}` : ''}
                  </p>
                  {checkResult.matched.map((m) => (
                    <p key={m.id} className={`text-xs ${m.decisive ? 'text-[#F5F5F5]' : 'text-[#A3A3A3] line-through'}`}>
                      {LEVEL_LABEL[m.level]}: {m.a.name} ↔ {m.b.name} — {m.allow ? 'may chat' : 'may not chat'}
                      {m.decisive ? '  ← decides' : '  (overridden)'}
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className={card}>
              {rules.length === 0 ? (
                <p className="text-sm text-[#A3A3A3] p-6 text-center">
                  No rules yet — which means nobody in this organization can start a conversation.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[#A3A3A3] border-b border-[#1F1F1F]">
                      <th className="px-4 py-2 font-medium">Scope</th>
                      <th className="px-4 py-2 font-medium">Pair</th>
                      <th className="px-4 py-2 font-medium">Verdict</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody data-testid="rules-table">
                    {rules.map((r) => (
                      <tr key={r.id} className="border-b border-[#1F1F1F] last:border-0">
                        <td className="px-4 py-2.5 text-[#A3A3A3] text-xs">{LEVEL_LABEL[r.level]}</td>
                        <td className="px-4 py-2.5 text-[#F5F5F5]">{r.a.name} ↔ {r.b.name}</td>
                        <td className="px-4 py-2.5">
                          <span className={r.allow ? 'text-[#10B981]' : 'text-[#EF4444]'}>
                            {r.allow ? 'may chat' : 'may not chat'}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => removeRule(r.id)}
                            disabled={busy}
                            aria-label="Remove rule"
                            className="p-1.5 text-[#A3A3A3] hover:text-[#EF4444] rounded transition-colors"
                          >
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : tab === 'send' ? (
          <div className="space-y-4">
            <div className="rounded-[8px] border border-[#2D2D2D] bg-[#141414] px-4 py-3">
              <p className="text-sm text-[#F5F5F5]">Everything is allowed until you add a policy.</p>
              <p className="text-xs text-[#A3A3A3] mt-1">
                This is the opposite of the chat rules above. A person&apos;s own policy replaces
                their department&apos;s entirely rather than merging with it. Turning audio off also
                blocks voice messages.
              </p>
            </div>

            <div className={`${card} p-4 flex flex-wrap items-center gap-2`}>
              <span className="text-sm text-[#F5F5F5]">Add or edit a policy for</span>
              <PartyPicker users={users} departments={departments} value={policyScope} onChange={(s) => openPolicy(s, null)} testId="policy-scope" />
            </div>

            {policyScope && draft && (
              <div className={`${card} p-4 space-y-1`} data-testid="policy-editor">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-sm font-medium text-[#F5F5F5]">Allowed content</h2>
                  <button type="button" onClick={() => { setPolicyScope(null); setDraft(null); }} className="p-1 text-[#A3A3A3] hover:text-[#F5F5F5]">
                    <X size={16} />
                  </button>
                </div>
                {[
                  ['allow_text', 'Text messages'],
                  ['allow_image', 'Photos'],
                  ['allow_video', 'Videos'],
                  ['allow_audio', 'Audio', 'Includes voice messages'],
                  ['allow_document', 'Documents'],
                ].map(([key, label, hint]) => (
                  <Toggle key={key} label={label} hint={hint} checked={draft[key]} onChange={(v) => setDraft({ ...draft, [key]: v })} />
                ))}

                {draft.allow_document && (
                  <div className="pt-3 mt-2 border-t border-[#1F1F1F]">
                    <p className="text-sm text-[#F5F5F5] mb-1">Document types</p>
                    <p className="text-xs text-[#A3A3A3] mb-2">
                      Leave all unticked to allow every type. Ticking some restricts to exactly those.
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {docExts.map((ext) => {
                        const on = Array.isArray(draft.doc_extensions) && draft.doc_extensions.includes(ext);
                        return (
                          <button
                            key={ext}
                            type="button"
                            onClick={() => {
                              const cur = Array.isArray(draft.doc_extensions) ? draft.doc_extensions : [];
                              const next = on ? cur.filter((e) => e !== ext) : [...cur, ext];
                              // Empty selection means "no restriction", so it goes
                              // back to null rather than [] — an empty list is a
                              // real and much stricter setting (no documents at all).
                              setDraft({ ...draft, doc_extensions: next.length ? next : null });
                            }}
                            className={`px-2 py-1 text-xs rounded-[5px] border transition-colors ${
                              on
                                ? 'border-[#10B981] text-[#10B981] bg-[#10B981]/10'
                                : 'border-[#2D2D2D] text-[#A3A3A3] hover:text-[#F5F5F5]'
                            }`}
                          >
                            {on && <Check size={11} className="inline mr-1" />}{ext}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="pt-3">
                  <button type="button" onClick={savePolicy} disabled={busy} className={btnPrimary} data-testid="policy-save">
                    Save policy
                  </button>
                </div>
              </div>
            )}

            <div className={card}>
              {policies.length === 0 ? (
                <p className="text-sm text-[#A3A3A3] p-6 text-center">
                  No policies — everyone may send anything.
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[#A3A3A3] border-b border-[#1F1F1F]">
                      <th className="px-4 py-2 font-medium">Applies to</th>
                      <th className="px-4 py-2 font-medium">Allowed</th>
                      <th className="px-4 py-2" />
                    </tr>
                  </thead>
                  <tbody data-testid="policies-table">
                    {policies.map((p) => {
                      const on = [
                        p.allow_text && 'text', p.allow_image && 'photos', p.allow_video && 'videos',
                        p.allow_audio && 'audio',
                        p.allow_document && (p.doc_extensions?.length ? `docs (${p.doc_extensions.join(' ')})` : 'documents'),
                      ].filter(Boolean);
                      return (
                        <tr key={p.id} className="border-b border-[#1F1F1F] last:border-0">
                          <td className="px-4 py-2.5 text-[#F5F5F5]">
                            {p.scope.name}
                            <span className="text-xs text-[#A3A3A3] ml-2">{p.scope.type}</span>
                          </td>
                          <td className="px-4 py-2.5 text-[#A3A3A3]">
                            {on.length ? on.join(', ') : <span className="text-[#EF4444]">nothing</span>}
                          </td>
                          <td className="px-4 py-2.5 text-right">
                            <button type="button" onClick={() => removePolicy(p.id)} disabled={busy} aria-label="Remove policy"
                              className="p-1.5 text-[#A3A3A3] hover:text-[#EF4444] rounded transition-colors">
                              <Trash2 size={15} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-[8px] border border-[#2D2D2D] bg-[#141414] px-4 py-3">
              <p className="text-sm text-[#F5F5F5]">
                An admin with no departments selected covers the whole organization.
              </p>
              <p className="text-xs text-[#A3A3A3] mt-1">
                Selecting departments narrows them to those. Clearing the selection widens them back
                to org-wide — it does not remove their access.
              </p>
            </div>
            <div className={card}>
              {admins.length === 0 ? (
                <p className="text-sm text-[#A3A3A3] p-6 text-center">
                  This organization has no admins.
                </p>
              ) : (
                <div className="divide-y divide-[#1F1F1F]" data-testid="delegation-list">
                  {admins.map((a) => (
                    <div key={a.user_id} className="p-4">
                      <div className="flex items-baseline gap-2 mb-2">
                        <span className="text-sm text-[#F5F5F5]">{a.display_name}</span>
                        <span className="text-xs text-[#A3A3A3]">{a.email}</span>
                        {a.org_wide && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-[#10B981]/10 text-[#10B981]">
                            whole organization
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {departments.map((d) => {
                          const on = a.departments.some((x) => x.id === d.id);
                          return (
                            <button
                              key={d.id}
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                const cur = a.departments.map((x) => x.id);
                                setAdminDepts(a.user_id, on ? cur.filter((x) => x !== d.id) : [...cur, d.id]);
                              }}
                              className={`px-2 py-1 text-xs rounded-[5px] border transition-colors ${
                                on
                                  ? 'border-[#10B981] text-[#10B981] bg-[#10B981]/10'
                                  : 'border-[#2D2D2D] text-[#A3A3A3] hover:text-[#F5F5F5]'
                              }`}
                            >
                              {on && <Check size={11} className="inline mr-1" />}{d.name}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  );
}
