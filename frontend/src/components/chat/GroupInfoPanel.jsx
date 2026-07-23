import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Crown, Shield, UserPlus, LogOut, Pencil, MoreVertical, MessageSquare, UserMinus, ShieldCheck, ShieldOff } from 'lucide-react';
import client from '../../api/client';
import { toast } from 'sonner';
import { NewChatModal } from './NewChatModal';
import useChatStore from '../../stores/chatStore';

export const GroupInfoPanel = ({ conversation, currentUserId, isOpen, onClose }) => {
  const [editingName, setEditingName] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [memberMenu, setMemberMenu] = useState(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const { setActiveConversation } = useChatStore();

  if (!isOpen || !conversation) return null;

  const isCrossOrg = conversation.cross_org === true;
  const participants = conversation.participants || [];
  const myRole = participants.find(p => p.user_id === currentUserId)?.role;
  const isCreator = myRole === 'creator';
  const isAdmin = myRole === 'admin' || isCreator;
  const adminOnly = conversation.admin_only_messages;

  // Sort: creator first, then admins, then members
  const sortedMembers = [...participants].sort((a, b) => {
    const order = { creator: 0, admin: 1, member: 2 };
    return (order[a.role] || 2) - (order[b.role] || 2);
  });

  const handleEditName = async () => {
    if (!newName.trim()) return;
    try {
      await client.put(`/api/conversations/${conversation._id}/group`, { name: newName.trim() });
      toast.success('Group name updated');
      setEditingName(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update');
    }
  };

  const handleEditDesc = async () => {
    try {
      await client.put(`/api/conversations/${conversation._id}/group`, { description: newDesc.trim() || null });
      toast.success('Description updated');
      setEditingDesc(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update');
    }
  };

  const handleToggleAdminOnly = async () => {
    try {
      await client.put(`/api/conversations/${conversation._id}/group`, { admin_only_messages: !adminOnly });
      toast.success(adminOnly ? 'All members can now send messages' : 'Only admins can send messages');
    } catch (err) {
      toast.error('Failed to update');
    }
  };

  const handleRemoveMember = async (memberId) => {
    try {
      await client.delete(`/api/conversations/${conversation._id}/members/${memberId}`);
      toast.success('Member removed');
      setMemberMenu(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to remove');
    }
  };

  const handleChangeRole = async (memberId, newRole) => {
    try {
      await client.put(`/api/conversations/${conversation._id}/members/${memberId}/role`, { role: newRole });
      toast.success(newRole === 'admin' ? 'Made admin' : 'Removed as admin');
      setMemberMenu(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to change role');
    }
  };

  const handleLeave = async () => {
    try {
      await client.post(`/api/conversations/${conversation._id}/leave`);
      toast.success('Left group');
      setShowLeaveConfirm(false);
      onClose();
      setActiveConversation(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to leave');
    }
  };

  const handleAddMembers = async (contactId) => {
    try {
      await client.post(`/api/conversations/${conversation._id}/members`, {
        user_ids: [contactId]
      });
      toast.success('Member added');
      setShowAddMembers(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to add member');
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50"
          onClick={onClose}
        >
          <div className="absolute inset-0 bg-black/60 backdrop-blur-[4px]" />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.3, ease: [0.2, 0.8, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="absolute right-0 top-0 h-full w-full sm:w-[380px] bg-[#0F0F0F] border-l border-[#1F1F1F] shadow-2xl overflow-y-auto"
            data-testid="group-info-panel"
          >
            {/* Close button */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#1F1F1F]">
              <h3 className="text-base font-semibold text-[#F5F5F5]">Group Info</h3>
              <button onClick={onClose} className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">
                <X size={18} />
              </button>
            </div>

            <div className="p-5 space-y-6">
              {/* Avatar + Name */}
              <div className="text-center">
                <div className="w-24 h-24 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-3xl font-bold mx-auto mb-3">
                  {conversation.name?.substring(0, 2).toUpperCase() || 'G'}
                </div>

                {editingName ? (
                  <div className="flex items-center gap-2 justify-center">
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleEditName(); if (e.key === 'Escape') setEditingName(false); }}
                      autoFocus
                      className="h-9 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] text-center focus:border-[#10B981] focus:outline-none"
                    />
                  </div>
                ) : (
                  <div className="flex items-center justify-center gap-2">
                    <h2 className="text-xl font-semibold text-[#F5F5F5]">{conversation.name}</h2>
                    {isAdmin && (
                      <button onClick={() => { setNewName(conversation.name || ''); setEditingName(true); }}
                        className="p-1 text-[#A3A3A3] hover:text-[#10B981] transition-colors">
                        <Pencil size={14} />
                      </button>
                    )}
                  </div>
                )}

                {editingDesc ? (
                  <div className="mt-2 flex flex-col items-center gap-2">
                    <textarea
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEditDesc(); } if (e.key === 'Escape') setEditingDesc(false); }}
                      autoFocus
                      rows={2}
                      className="w-full px-3 py-2 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#A3A3A3] text-center focus:border-[#10B981] focus:outline-none resize-none"
                    />
                  </div>
                ) : (
                  <div className="mt-1 flex items-center justify-center gap-1">
                    <p className="text-sm text-[#A3A3A3]">{conversation.description || 'No description'}</p>
                    {isAdmin && (
                      <button onClick={() => { setNewDesc(conversation.description || ''); setEditingDesc(true); }}
                        className="p-1 text-[#A3A3A3] hover:text-[#10B981] transition-colors">
                        <Pencil size={12} />
                      </button>
                    )}
                  </div>
                )}

                <p className="text-xs text-[#A3A3A3] mt-2">{participants.length} members</p>
                {isCrossOrg && (
                  <span className="inline-block mt-2 text-[11px] px-3 py-1 rounded-full bg-[#10B981]/20 text-[#10B981]">
                    Cross-Organization Group
                  </span>
                )}
              </div>

              {/* Admin only toggle */}
              {isAdmin && (
                <button
                  onClick={handleToggleAdminOnly}
                  className="w-full flex items-center justify-between p-3 bg-[#141414] border border-[#1F1F1F] rounded-[8px] hover:border-[#10B981]/20 transition-colors"
                >
                  <span className="text-sm text-[#F5F5F5]">Only admins can send</span>
                  <div className={`w-10 h-5 rounded-full transition-colors ${adminOnly ? 'bg-[#10B981]' : 'bg-[#2D2D2D]'} relative`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform`}
                      style={{ left: adminOnly ? '22px' : '2px' }} />
                  </div>
                </button>
              )}

              {/* Members */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-medium text-[#A3A3A3]">Members</h4>
                  {isAdmin && (
                    <button
                      onClick={() => setShowAddMembers(true)}
                      data-testid="group-add-members"
                      className="flex items-center gap-1 text-xs text-[#10B981] hover:text-[#059669] transition-colors"
                    >
                      <UserPlus size={14} /> Add
                    </button>
                  )}
                </div>

                <div className="space-y-1">
                  {sortedMembers.map(member => (
                    <div
                      key={member.user_id}
                      className="flex items-center gap-3 p-2 rounded-[6px] hover:bg-[#141414] transition-colors relative group"
                    >
                      <div className="w-9 h-9 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium flex-shrink-0">
                        {member.display_name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm text-[#F5F5F5] truncate">{member.display_name}</span>
                          {member.user_id === currentUserId && <span className="text-xs text-[#A3A3A3]">(You)</span>}
                          {member.role === 'creator' && <Crown size={12} className="text-[#FBBF24] flex-shrink-0" />}
                          {member.role === 'admin' && <Shield size={12} className="text-[#10B981] flex-shrink-0" />}
                        </div>
                      </div>

                      {member.user_id !== currentUserId && (
                        <div className="relative">
                          <button
                            onClick={() => setMemberMenu(memberMenu === member.user_id ? null : member.user_id)}
                            className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] opacity-0 group-hover:opacity-100 transition-all rounded"
                          >
                            <MoreVertical size={14} />
                          </button>
                          <AnimatePresence>
                            {memberMenu === member.user_id && (
                              <>
                                <div className="fixed inset-0 z-40" onClick={() => setMemberMenu(null)} />
                                <motion.div
                                  initial={{ opacity: 0, scale: 0.95 }}
                                  animate={{ opacity: 1, scale: 1 }}
                                  exit={{ opacity: 0, scale: 0.95 }}
                                  className="absolute right-0 top-full mt-1 w-44 bg-[#141414] border border-[#1F1F1F] rounded-[8px] shadow-lg z-50 py-1"
                                >
                                  {isCreator && member.role !== 'creator' && (
                                    <button
                                      onClick={() => handleChangeRole(member.user_id, member.role === 'admin' ? 'member' : 'admin')}
                                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#F5F5F5] hover:bg-[#1A1A1A] transition-colors"
                                    >
                                      {member.role === 'admin' ? <ShieldOff size={12} /> : <ShieldCheck size={12} />}
                                      {member.role === 'admin' ? 'Remove Admin' : 'Make Admin'}
                                    </button>
                                  )}
                                  {isAdmin && member.role !== 'creator' && (
                                    <button
                                      onClick={() => handleRemoveMember(member.user_id)}
                                      className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
                                    >
                                      <UserMinus size={12} /> Remove
                                    </button>
                                  )}
                                  <button
                                    onClick={() => { setMemberMenu(null); }}
                                    className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#F5F5F5] hover:bg-[#1A1A1A] transition-colors"
                                  >
                                    <MessageSquare size={12} /> Message
                                  </button>
                                </motion.div>
                              </>
                            )}
                          </AnimatePresence>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {/* Shared Media placeholder */}
              <div>
                <h4 className="text-sm font-medium text-[#A3A3A3] mb-3">Shared Media</h4>
                <p className="text-xs text-[#525252] text-center py-4">No shared media yet</p>
              </div>

              {/* Leave / Delete */}
              {isCrossOrg ? (
                <div className="pt-2 border-t border-[#1F1F1F] text-center">
                  <p className="text-xs text-[#525252] py-2">Managed by administrator</p>
                </div>
              ) : (
                <div className="pt-2 border-t border-[#1F1F1F]">
                  <button
                    onClick={() => setShowLeaveConfirm(true)}
                    data-testid="group-leave-button"
                    className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-[#EF4444] hover:bg-[#EF4444]/10 rounded-[6px] transition-colors"
                  >
                    <LogOut size={16} />
                    {isCreator && participants.length === 1 ? 'Delete Group' : 'Exit Group'}
                  </button>
                </div>
              )}
            </div>

            {/* Leave Confirmation */}
            <AnimatePresence>
              {showLeaveConfirm && (
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="fixed inset-0 z-[60] flex items-center justify-center p-4"
                  onClick={() => setShowLeaveConfirm(false)}
                >
                  <div className="absolute inset-0 bg-black/60" />
                  <motion.div
                    initial={{ scale: 0.95 }}
                    animate={{ scale: 1 }}
                    exit={{ scale: 0.95 }}
                    onClick={(e) => e.stopPropagation()}
                    className="relative bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-6 max-w-sm"
                  >
                    <p className="text-sm text-[#F5F5F5] mb-4">
                      Are you sure you want to leave "{conversation.name}"?
                    </p>
                    <div className="flex justify-end gap-3">
                      <button onClick={() => setShowLeaveConfirm(false)} className="px-4 py-2 text-sm text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors">Cancel</button>
                      <button onClick={handleLeave} className="px-4 py-2 text-sm font-medium bg-[#EF4444] text-white rounded-[6px] hover:opacity-90 transition-all">Leave</button>
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Add Members Modal */}
            <NewChatModal
              isOpen={showAddMembers}
              onClose={() => setShowAddMembers(false)}
              onSelectContact={handleAddMembers}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
