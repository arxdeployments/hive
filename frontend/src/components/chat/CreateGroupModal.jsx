import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Search, X, ArrowLeft, Camera, Users, Loader2 } from 'lucide-react';
import client from '../../api/client';
import { toast } from 'sonner';
import { useModalDialog } from '../../hooks/useModalDialog';
import { apiError } from '../../utils/helpers';

/**
 * `prefillMembers` / `prefillName` / `prefillDescription` back GroupInfoPanel's
 * "Create a similar group": the modal opens on step 1 with the source group's
 * members already selected so they can be adjusted before the group is created.
 * Members must be roster-shaped — { id, display_name, avatar_url, department_name }.
 */
export const CreateGroupModal = ({
  isOpen,
  onClose,
  onGroupCreated,
  prefillMembers,
  prefillName,
  prefillDescription,
}) => {
  const [step, setStep] = useState(1);
  const { titleId, dialogProps } = useModalDialog({ isOpen, onClose });
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectedContacts, setSelectedContacts] = useState([]);
  const [loading, setLoading] = useState(false);

  // Step 2
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await client.get('/api/users/contacts', { params: { search } });
      setContacts(data);
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [search]);

  useEffect(() => {
    if (!isOpen) return;
    const timer = setTimeout(fetchContacts, 300);
    return () => clearTimeout(timer);
  }, [isOpen, fetchContacts]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setStep(1);
      setSelectedIds([]);
      setSelectedContacts([]);
      setGroupName('');
      setGroupDesc('');
      setSearch('');
    }
  }, [isOpen]);

  // Seed from the prefill on open only. Re-seeding on every render would fight
  // the user's own edits to the selection they were handed.
  useEffect(() => {
    if (!isOpen) return;
    const seedMembers = Array.isArray(prefillMembers) ? prefillMembers.filter(m => m?.id) : [];
    if (seedMembers.length === 0 && !prefillName && !prefillDescription) return;
    setSelectedContacts(seedMembers);
    setSelectedIds(seedMembers.map(m => m.id));
    setGroupName(prefillName || '');
    setGroupDesc(prefillDescription || '');
    setStep(1);
  }, [isOpen]);

  const toggleContact = (contact) => {
    if (selectedIds.includes(contact.id)) {
      setSelectedIds(prev => prev.filter(id => id !== contact.id));
      setSelectedContacts(prev => prev.filter(c => c.id !== contact.id));
    } else {
      setSelectedIds(prev => [...prev, contact.id]);
      setSelectedContacts(prev => [...prev, contact]);
    }
  };

  const removeChip = (id) => {
    setSelectedIds(prev => prev.filter(i => i !== id));
    setSelectedContacts(prev => prev.filter(c => c.id !== id));
  };

  const handleCreate = async () => {
    if (!groupName.trim() || selectedIds.length < 2) return;
    setCreating(true);
    try {
      const { data } = await client.post('/api/conversations/group', {
        name: groupName.trim(),
        description: groupDesc.trim() || null,
        member_ids: selectedIds,
      });
      toast.success(`Group "${groupName.trim()}" created!`);
      onGroupCreated(data);
      onClose();
    } catch (err) {
      toast.error(apiError(err, 'Failed to create group'));
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
          onClick={(e) => e.stopPropagation()}
          {...dialogProps}
          className="relative bg-[#141414] border border-[#1F1F1F] rounded-[12px] w-full max-w-[480px] max-h-[75vh] shadow-[0_0_0_1px_rgba(31,31,31,1),0_18px_60px_rgba(0,0,0,0.55)] flex flex-col overflow-hidden outline-none"
        >
          <AnimatePresence mode="wait">
            {step === 1 ? (
              <motion.div
                key="step1"
                initial={{ x: 0 }}
                exit={{ x: -50, opacity: 0 }}
                className="flex flex-col h-full max-h-[75vh]"
              >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-[#1F1F1F] flex-shrink-0">
                  <div>
                    <h3 id={titleId} className="text-lg font-semibold text-[#F5F5F5]">New Group</h3>
                    <p className="text-xs text-[#A3A3A3]">Step 1 of 2 — Select members</p>
                  </div>
                  <button onClick={onClose} className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">
                    <X size={18} />
                  </button>
                </div>

                {/* Selected chips */}
                {selectedContacts.length > 0 && (
                  <div className="px-4 pt-3 flex gap-2 flex-wrap max-h-24 overflow-y-auto flex-shrink-0">
                    {selectedContacts.map(c => (
                      <span key={c.id} className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-[#1A1A1A] border border-[#2D2D2D] rounded-full text-xs text-[#F5F5F5]">
                        <span className="w-5 h-5 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-[10px] font-medium">
                          {c.display_name?.charAt(0)?.toUpperCase()}
                        </span>
                        {c.display_name}
                        <button onClick={() => removeChip(c.id)} className="text-[#A3A3A3] hover:text-[#EF4444] transition-colors">
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {/* Search */}
                <div className="px-4 py-3 flex-shrink-0">
                  <div className="relative">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
                    <input
                      type="text"
                      placeholder="Search contacts..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      data-testid="group-member-search"
                      className="w-full h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none transition-all"
                    />
                  </div>
                </div>

                {/* Contact list */}
                <div className="flex-1 overflow-y-auto px-2 pb-3 min-h-0">
                  {loading ? (
                    <div className="flex items-center justify-center py-12">
                      <Loader2 className="w-6 h-6 text-[#10B981] animate-spin" />
                    </div>
                  ) : contacts.length === 0 ? (
                    <p className="text-center py-12 text-sm text-[#A3A3A3]">No contacts found</p>
                  ) : (
                    contacts.map(contact => {
                      const isSelected = selectedIds.includes(contact.id);
                      return (
                        <button
                          key={contact.id}
                          onClick={() => toggleContact(contact)}
                          data-testid="group-contact-item"
                          className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[6px] transition-colors text-left ${
                            isSelected ? 'bg-[#10B981]/10' : 'hover:bg-[#1A1A1A]'
                          }`}
                        >
                          <div className={`w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                            isSelected ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'
                          }`}>
                            {isSelected && <span className="text-white text-xs">✓</span>}
                          </div>
                          <div className="w-9 h-9 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium flex-shrink-0">
                            {contact.display_name?.charAt(0)?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-[#F5F5F5] truncate">{contact.display_name}</p>
                            <p className="text-xs text-[#A3A3A3] truncate">{contact.department_name}</p>
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between px-5 py-4 border-t border-[#1F1F1F] flex-shrink-0">
                  <span className="text-xs text-[#A3A3A3]">{selectedIds.length} selected</span>
                  <div className="flex gap-3">
                    <button onClick={onClose} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Cancel</button>
                    <button
                      onClick={() => setStep(2)}
                      disabled={selectedIds.length < 2}
                      data-testid="group-next-button"
                      className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="step2"
                initial={{ x: 50, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 50, opacity: 0 }}
                className="flex flex-col h-full max-h-[75vh]"
              >
                {/* Header */}
                <div className="flex items-center gap-3 px-5 py-4 border-b border-[#1F1F1F] flex-shrink-0">
                  <button onClick={() => setStep(1)} className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">
                    <ArrowLeft size={18} />
                  </button>
                  <div>
                    <h3 id={titleId} className="text-lg font-semibold text-[#F5F5F5]">New Group</h3>
                    <p className="text-xs text-[#A3A3A3]">Step 2 of 2 — Group details</p>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-5 space-y-5">
                  {/* Group avatar */}
                  <div className="flex justify-center">
                    <div className="w-20 h-20 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-2xl font-bold border-2 border-dashed border-[#2D2D2D]">
                      {groupName ? groupName.substring(0, 2).toUpperCase() : <Camera size={24} />}
                    </div>
                  </div>

                  {/* Group name */}
                  <div>
                    <label htmlFor="creategroupmodal-01-group-name" className="text-sm text-[#A3A3A3] mb-1.5 block">Group Name *</label>
                    <input id="creategroupmodal-01-group-name"
                      type="text"
                      value={groupName}
                      onChange={(e) => setGroupName(e.target.value)}
                      maxLength={100}
                      placeholder="e.g. Engineering Team"
                      autoFocus
                      data-testid="group-name-input"
                      className="w-full h-10 px-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none focus:shadow-[0_0_0_3px_rgba(16,185,129,0.25)] transition-all"
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label htmlFor="creategroupmodal-02-description" className="text-sm text-[#A3A3A3] mb-1.5 block">Description</label>
                    <textarea id="creategroupmodal-02-description"
                      value={groupDesc}
                      onChange={(e) => setGroupDesc(e.target.value)}
                      maxLength={500}
                      placeholder="What is this group about?"
                      rows={2}
                      data-testid="group-desc-input"
                      className="w-full px-4 py-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/50 focus:border-[#10B981] focus:outline-none resize-none transition-all"
                    />
                  </div>

                  {/* Member summary */}
                  <div className="flex items-center gap-2">
                    <Users size={14} className="text-[#A3A3A3]" />
                    <span className="text-sm text-[#A3A3A3]">{selectedContacts.length + 1} members (including you)</span>
                  </div>
                  <div className="flex -space-x-2">
                    {selectedContacts.slice(0, 5).map(c => (
                      <div key={c.id} className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-xs font-medium border-2 border-[#141414]">
                        {c.display_name?.charAt(0)?.toUpperCase()}
                      </div>
                    ))}
                    {selectedContacts.length > 5 && (
                      <div className="w-8 h-8 rounded-full bg-[#1A1A1A] flex items-center justify-center text-[#A3A3A3] text-xs font-medium border-2 border-[#141414]">
                        +{selectedContacts.length - 5}
                      </div>
                    )}
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-3 px-5 py-4 border-t border-[#1F1F1F] flex-shrink-0">
                  <button onClick={() => setStep(1)} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Back</button>
                  <button
                    onClick={handleCreate}
                    disabled={!groupName.trim() || creating}
                    data-testid="group-create-button"
                    className="px-4 py-2 text-sm font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
                  >
                    {creating && <Loader2 size={14} className="animate-spin" />}
                    Create Group
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};
