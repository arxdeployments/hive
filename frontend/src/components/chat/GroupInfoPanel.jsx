/**
 * Group Info — WhatsApp-parity two-column drawer.
 *
 *   <GroupInfoPanel conversation={conv} isOpen={bool} onClose={fn} initialSection="info" />
 *
 * Left rail: Info · Media, links and docs · Starred · Group permissions ·
 * Encryption · Members. Every nav item carries data-testid="group-info-nav-<section>".
 *
 * `currentUserId` is optional — it is read from AuthContext when omitted, so the
 * documented four-prop contract is enough on its own. `onJumpToMessage`,
 * `onSearchMessages` and `onGroupCreated` are optional integration hooks; the
 * panel degrades gracefully (no dead UI) when they are not supplied.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  Copy,
  Crown,
  Download,
  Eraser,
  Info,
  Image as ImageIcon,
  Lock,
  LogOut,
  MessageSquare,
  MoreVertical,
  Pencil,
  Phone,
  Search,
  Shield,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Star,
  Timer,
  UserMinus,
  UserPlus,
  Users,
  Video,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import client from '../../api/client';
import useChatStore from '../../stores/chatStore';
import useCallStore from '../../stores/callStore';
import wsClient from '../../services/websocket';
import { useAuth } from '../../contexts/AuthContext';
import { NewChatModal } from './NewChatModal';
import { CreateGroupModal } from './CreateGroupModal';
import { InfoPanelShell } from './info/InfoPanelShell';
import { MediaLinksDocsSection } from './info/MediaLinksDocsSection';
import { StarredSection } from './info/StarredSection';
import { EncryptionSection } from './info/EncryptionSection';
import {
  ActionRow,
  Avatar,
  ConfirmDialog,
  EmptyState,
  LoadingState,
  QuickAction,
  SectionHeading,
  ToggleRow,
  formatLongDate,
} from './info/InfoPanelPrimitives';

const ROLE_ORDER = { creator: 0, admin: 1, member: 2 };

/**
 * "Members can:" rows, in WhatsApp's order.
 *
 * Only permissions the backend actually enforces are listed. `send_history`,
 * `invite_via_link` and `approve_new_members` were switches that saved happily
 * and changed nothing — a member added later still read the entire pre-join
 * history through the message list, search, starred, pinned, media and export.
 * A privacy control that silently does nothing is worse than none at all, so
 * they stay hidden until a read path enforces them.
 */
const MEMBER_PERMISSIONS = [
  {
    key: 'edit_info',
    label: 'Edit group settings',
    description: 'Change the group name, icon and description',
  },
  { key: 'send_messages', label: 'Send new messages' },
  { key: 'add_members', label: 'Add other members' },
];

export const GroupInfoPanel = ({
  conversation,
  isOpen,
  onClose,
  initialSection = 'info',
  currentUserId,
  onJumpToMessage,
  onSearchMessages,
  onGroupCreated,
}) => {
  const { user } = useAuth();
  const myUserId = currentUserId || user?.id;
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const updateConversation = useChatStore((s) => s.updateConversation);
  const setMessages = useChatStore((s) => s.setMessages);

  const [section, setSection] = useState(initialSection);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState('');
  const [savingInfo, setSavingInfo] = useState(false);

  const [muted, setMuted] = useState(false);
  const [mutePending, setMutePending] = useState(false);

  const [permissions, setPermissions] = useState(null);
  const [permLoading, setPermLoading] = useState(false);
  const [permError, setPermError] = useState(false);
  const [permSaving, setPermSaving] = useState(null);

  const [memberSearch, setMemberSearch] = useState('');
  const [memberMenu, setMemberMenu] = useState(null);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [showSimilarGroup, setShowSimilarGroup] = useState(false);

  const [confirm, setConfirm] = useState(null); // 'leave' | 'clear'
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [exporting, setExporting] = useState(false);

  const convId = conversation?._id;
  const participants = useMemo(() => conversation?.participants || [], [conversation]);
  const myRole = participants.find((p) => p.user_id === myUserId)?.role;
  const isCreator = myRole === 'creator';
  const isAdmin = myRole === 'admin' || isCreator;
  const isCrossOrg = conversation?.cross_org === true;
  const memberCount = participants.length;

  // Re-arm the requested section every time the drawer opens: the integrator
  // passes initialSection per invocation ("open straight to Members"), and a
  // panel that remembered the last section would ignore it on re-open.
  useEffect(() => {
    if (isOpen) {
      setSection(initialSection || 'info');
      setMemberMenu(null);
      setMemberSearch('');
      setEditingName(false);
      setEditingDesc(false);
    }
  }, [isOpen, initialSection, convId]);

  // Mute is per-participant. Prefer whatever the conversation doc exposes, then
  // my participant row, then Off — the toggle response is the source of truth.
  useEffect(() => {
    const mine = participants.find((p) => p.user_id === myUserId);
    setMuted(Boolean(conversation?.is_muted ?? mine?.is_muted ?? false));
  }, [conversation?.is_muted, participants, myUserId]);

  const loadPermissions = useCallback(async () => {
    if (!convId) return;
    setPermLoading(true);
    setPermError(false);
    try {
      const { data } = await client.get(`/api/conversations/${convId}/permissions`);
      setPermissions(data);
    } catch {
      setPermissions(null);
      setPermError(true);
    } finally {
      setPermLoading(false);
    }
  }, [convId]);

  useEffect(() => {
    if (isOpen && section === 'permissions') loadPermissions();
  }, [isOpen, section, loadPermissions]);

  const handleSaveName = async () => {
    const name = nameDraft.trim();
    if (!name || name === conversation.name) {
      setEditingName(false);
      return;
    }
    setSavingInfo(true);
    try {
      const { data } = await client.put(`/api/conversations/${convId}/group`, { name });
      updateConversation(convId, { name: data?.name ?? name });
      toast.success('Group name updated');
      setEditingName(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update group name');
    } finally {
      setSavingInfo(false);
    }
  };

  const handleSaveDesc = async () => {
    const description = descDraft.trim();
    setSavingInfo(true);
    try {
      await client.put(`/api/conversations/${convId}/group`, { description: description || null });
      updateConversation(convId, { description: description || null });
      toast.success('Description updated');
      setEditingDesc(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to update description');
    } finally {
      setSavingInfo(false);
    }
  };

  const handleToggleMute = async (next) => {
    setMutePending(true);
    setMuted(next); // optimistic
    try {
      const { data } = await client.put(`/api/conversations/${convId}/mute`);
      const value = Boolean(data?.is_muted);
      setMuted(value);
      updateConversation(convId, { is_muted: value });
      toast.success(value ? 'Notifications muted' : 'Notifications unmuted');
    } catch (err) {
      setMuted(!next); // roll back
      toast.error(err.response?.data?.detail || 'Failed to change mute');
    } finally {
      setMutePending(false);
    }
  };

  const handleTogglePermission = async (key, next) => {
    const previous = permissions;
    setPermissions((prev) => ({ ...prev, [key]: next })); // optimistic
    setPermSaving(key);
    try {
      const { data } = await client.put(`/api/conversations/${convId}/permissions`, { [key]: next });
      setPermissions(data);
    } catch (err) {
      setPermissions(previous); // roll back
      toast.error(err.response?.data?.detail || 'Failed to update permission');
    } finally {
      setPermSaving(null);
    }
  };

  const handleCall = (callType) => {
    if (useCallStore.getState().callState !== 'idle') {
      toast.error('You are already in a call');
      return;
    }
    wsClient.send({ type: 'call:group_initiate', conversation_id: convId, call_type: callType });
    useCallStore.getState().initiateCall(null, callType, true, convId);
    onClose?.();
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const response = await client.get(`/api/conversations/${convId}/export`, { responseType: 'blob' });
      const blob = new Blob([response.data], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // Filename from the id, never the (user-controlled) group name.
      link.download = `rxhive-chat-${convId}.txt`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      toast.success('Chat exported');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleClearChat = async () => {
    setConfirmBusy(true);
    try {
      await client.post(`/api/conversations/${convId}/clear`);
      setMessages(convId, []);
      toast.success('Chat cleared');
      setConfirm(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to clear chat');
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleLeave = async () => {
    setConfirmBusy(true);
    try {
      await client.post(`/api/conversations/${convId}/leave`);
      toast.success('Left group');
      setConfirm(null);
      onClose?.();
      setActiveConversation(null);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to leave group');
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleAddMember = async (contactId) => {
    try {
      await client.post(`/api/conversations/${convId}/members`, { user_ids: [contactId] });
      toast.success('Member added');
      setShowAddMembers(false);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to add member');
    }
  };

  const handleRemoveMember = async (memberId) => {
    setMemberMenu(null);
    try {
      await client.delete(`/api/conversations/${convId}/members/${memberId}`);
      toast.success('Member removed');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to remove member');
    }
  };

  const handleChangeRole = async (memberId, role) => {
    setMemberMenu(null);
    try {
      await client.put(`/api/conversations/${convId}/members/${memberId}/role`, { role });
      toast.success(role === 'admin' ? 'Made admin' : 'Removed as admin');
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to change role');
    }
  };

  const handleMessageMember = async (memberId) => {
    setMemberMenu(null);
    try {
      const { data } = await client.post('/api/conversations/direct', { participant_id: memberId });
      onClose?.();
      setActiveConversation(data._id);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to open chat');
    }
  };

  const sortedMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    return [...participants]
      .filter((p) => !query || (p.display_name || '').toLowerCase().includes(query))
      .sort((a, b) => {
        const byRole = (ROLE_ORDER[a.role] ?? 2) - (ROLE_ORDER[b.role] ?? 2);
        if (byRole !== 0) return byRole;
        return (a.display_name || '').localeCompare(b.display_name || '');
      });
  }, [participants, memberSearch]);

  /** Everyone except me, shaped the way CreateGroupModal's contact list expects. */
  const similarGroupMembers = useMemo(
    () =>
      participants
        .filter((p) => p.user_id !== myUserId)
        .map((p) => ({
          id: p.user_id,
          display_name: p.display_name,
          avatar_url: p.avatar_url,
          department_name: p.department_name || '',
        })),
    [participants, myUserId]
  );

  const creatorName =
    participants.find((p) => p.user_id === conversation?.created_by)?.display_name ||
    participants.find((p) => p.role === 'creator')?.display_name ||
    'Unknown';

  const sections = [
    { id: 'info', label: 'Info', icon: Info },
    { id: 'media', label: 'Media, links and docs', icon: ImageIcon },
    { id: 'starred', label: 'Starred', icon: Star },
    { id: 'permissions', label: 'Group permissions', icon: SlidersHorizontal },
    { id: 'encryption', label: 'Encryption', icon: Lock },
    { id: 'members', label: 'Members', icon: Users, badge: memberCount },
  ];

  if (!conversation) return null;

  const renderInfo = () => (
    <div className="p-5 space-y-6">
      {/* Identity */}
      <div className="flex flex-col items-center text-center">
        <Avatar name={conversation.name || 'Group'} src={conversation.avatar_url} size={112} />

        {editingName ? (
          <div className="mt-4 w-full max-w-[320px] flex items-center gap-2">
            <input
              type="text"
              value={nameDraft}
              maxLength={100}
              autoFocus
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveName();
                if (e.key === 'Escape') setEditingName(false);
              }}
              data-testid="group-info-name-input"
              className="flex-1 h-10 px-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] text-center focus:border-[#10B981] focus:outline-none"
            />
            <button
              type="button"
              onClick={handleSaveName}
              disabled={savingInfo}
              aria-label="Save group name"
              data-testid="group-info-name-save"
              className="p-2 text-[#10B981] hover:bg-[#10B981]/10 rounded-[6px] transition-colors disabled:opacity-50"
            >
              <Check size={16} />
            </button>
            <button
              type="button"
              onClick={() => setEditingName(false)}
              aria-label="Cancel"
              className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2">
            <h2 className="text-xl font-semibold text-[#F5F5F5]">{conversation.name || 'Group'}</h2>
            {isAdmin && (
              <button
                type="button"
                onClick={() => {
                  setNameDraft(conversation.name || '');
                  setEditingName(true);
                }}
                aria-label="Edit group name"
                data-testid="group-info-edit-name"
                className="p-1.5 text-[#A3A3A3] hover:text-[#10B981] rounded-[6px] transition-colors"
              >
                <Pencil size={14} />
              </button>
            )}
          </div>
        )}

        <p className="text-sm text-[#A3A3A3] mt-1">
          Group · {memberCount} {memberCount === 1 ? 'member' : 'members'}
        </p>
        {isCrossOrg && (
          <span className="mt-2 text-[11px] px-3 py-1 rounded-full bg-[#10B981]/20 text-[#10B981]">
            Cross-Organization Group
          </span>
        )}
      </div>

      {/* Quick actions */}
      <div className="flex gap-2">
        <QuickAction icon={Phone} label="Audio" onClick={() => handleCall('voice')} testId="group-info-action-audio" />
        <QuickAction icon={Video} label="Video" onClick={() => handleCall('video')} testId="group-info-action-video" />
        <QuickAction
          icon={UserPlus}
          label="Add"
          disabled={!isAdmin}
          onClick={() => setShowAddMembers(true)}
          testId="group-info-action-add"
        />
        <QuickAction
          icon={Search}
          label="Search"
          onClick={() => {
            onClose?.();
            onSearchMessages?.();
          }}
          testId="group-info-action-search"
        />
      </div>

      {/* Description */}
      <div className="bg-[#141414] border border-[#1F1F1F] rounded-[10px] p-4">
        <div className="flex items-center justify-between mb-2">
          <SectionHeading>Description</SectionHeading>
          {isAdmin && !editingDesc && (
            <button
              type="button"
              onClick={() => {
                setDescDraft(conversation.description || '');
                setEditingDesc(true);
              }}
              data-testid="group-info-edit-description"
              className="text-xs text-[#10B981] hover:text-[#059669] transition-colors"
            >
              Edit
            </button>
          )}
        </div>
        {editingDesc ? (
          <div className="space-y-2">
            <textarea
              value={descDraft}
              maxLength={500}
              rows={3}
              autoFocus
              onChange={(e) => setDescDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setEditingDesc(false);
              }}
              placeholder="Add a group description"
              data-testid="group-info-description-input"
              className="w-full px-3 py-2 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/60 focus:border-[#10B981] focus:outline-none resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditingDesc(false)}
                className="px-3 py-1.5 text-xs text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveDesc}
                disabled={savingInfo}
                data-testid="group-info-description-save"
                className="px-3 py-1.5 text-xs font-medium bg-[#10B981] text-[#0A0A0A] rounded-[6px] hover:bg-[#059669] disabled:opacity-50 transition-colors"
              >
                Save
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-[#F5F5F5] whitespace-pre-wrap break-words">
            {conversation.description || <span className="text-[#A3A3A3]">No description yet</span>}
          </p>
        )}
      </div>

      {/* Chat settings */}
      <div className="bg-[#141414] border border-[#1F1F1F] rounded-[10px] divide-y divide-[#1F1F1F]">
        <ToggleRow
          label="Mute notifications"
          description={muted ? 'You will not be notified about new messages' : 'Notifications are on'}
          checked={muted}
          busy={mutePending}
          onChange={handleToggleMute}
          testId="group-info-mute-toggle"
        />
        <div className="flex items-center justify-between gap-4 px-4 py-3" data-testid="group-info-disappearing">
          <span className="flex items-center gap-3 min-w-0">
            <Timer size={18} className="text-[#A3A3A3] shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm text-[#F5F5F5]">Disappearing messages</span>
              <span className="block text-xs text-[#A3A3A3] mt-0.5">Not available on RX HIVE yet</span>
            </span>
          </span>
          <span className="text-sm text-[#A3A3A3] shrink-0">Off</span>
        </div>
      </div>

      {/* Chat actions */}
      <div className="bg-[#141414] border border-[#1F1F1F] rounded-[10px] divide-y divide-[#1F1F1F]">
        <ActionRow
          icon={Copy}
          label="Create a similar group"
          description="Start a new group with the same members"
          onClick={() => setShowSimilarGroup(true)}
          testId="group-info-create-similar"
        />
        <ActionRow
          icon={Download}
          label="Export chat"
          description="Download this conversation as a text file"
          onClick={handleExport}
          disabled={exporting}
          trailing={exporting ? 'Exporting…' : undefined}
          testId="group-info-export"
        />
        <ActionRow
          icon={Eraser}
          label="Clear chat"
          description="Remove all messages from your copy of this chat"
          onClick={() => setConfirm('clear')}
          testId="group-info-clear"
        />
        {isCrossOrg ? (
          <div className="px-4 py-3">
            <p className="text-xs text-[#A3A3A3]">
              This cross-organization group is managed by an administrator — you cannot leave it yourself.
            </p>
          </div>
        ) : (
          <ActionRow
            icon={LogOut}
            label={isCreator && memberCount === 1 ? 'Delete group' : 'Exit group'}
            danger
            onClick={() => setConfirm('leave')}
            testId="group-leave-button"
          />
        )}
      </div>

      <p className="text-xs text-[#A3A3A3] text-center" data-testid="group-info-created">
        Created by {creatorName} · Created {formatLongDate(conversation.created_at) || 'unknown'}
      </p>
    </div>
  );

  const renderPermissions = () => {
    if (permLoading) return <LoadingState label="Loading permissions…" />;
    if (permError || !permissions) {
      return (
        <div className="flex flex-col items-center py-16 gap-3">
          <p className="text-sm text-[#A3A3A3]">Couldn&apos;t load group permissions.</p>
          <button
            type="button"
            onClick={loadPermissions}
            className="px-3 py-1.5 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }

    return (
      <div className="p-5 space-y-5">
        {!isAdmin && (
          <div
            className="flex gap-3 p-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[10px]"
            data-testid="group-permissions-readonly-notice"
          >
            <Shield size={18} className="text-[#A3A3A3] shrink-0 mt-0.5" />
            <p className="text-sm text-[#A3A3A3]">
              Only the group creator and admins can change these settings. You can see what is currently
              allowed, but the switches are read-only for you.
            </p>
          </div>
        )}

        <div>
          <SectionHeading className="px-1 mb-2">Members can</SectionHeading>
          <div className="bg-[#141414] border border-[#1F1F1F] rounded-[10px] divide-y divide-[#1F1F1F]">
            {MEMBER_PERMISSIONS.map((row) => (
              <ToggleRow
                key={row.key}
                label={row.label}
                description={row.description}
                checked={!!permissions[row.key]}
                disabled={!isAdmin}
                busy={permSaving === row.key}
                onChange={(next) => handleTogglePermission(row.key, next)}
                testId={`group-permission-${row.key}`}
              />
            ))}
          </div>
        </div>
      </div>
    );
  };

  const renderMembers = () => (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
          <input
            type="text"
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
            placeholder="Search members"
            data-testid="group-members-search"
            className="w-full h-9 pl-9 pr-3 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3]/60 focus:border-[#10B981] focus:outline-none transition-colors"
          />
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={() => setShowAddMembers(true)}
            data-testid="group-add-members"
            className="flex items-center gap-1.5 h-9 px-3 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors shrink-0"
          >
            <UserPlus size={14} /> Add
          </button>
        )}
      </div>

      <p className="text-xs text-[#A3A3A3] px-1">
        {sortedMembers.length} of {memberCount} {memberCount === 1 ? 'member' : 'members'}
      </p>

      {sortedMembers.length === 0 ? (
        <EmptyState icon={Users} title="No members match that search" />
      ) : (
        <div className="space-y-1">
          {sortedMembers.map((member) => {
            const isMe = member.user_id === myUserId;
            const canManage = isAdmin && !isMe && member.role !== 'creator';
            const canPromote = isCreator && !isMe && member.role !== 'creator';
            return (
              <div
                key={member.user_id}
                className="group flex items-center gap-3 p-2.5 rounded-[8px] hover:bg-[#141414] transition-colors relative"
                data-testid="group-member-row"
              >
                <Avatar name={member.display_name} src={member.avatar_url} size={38} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-[#F5F5F5] truncate">{member.display_name}</span>
                    {isMe && <span className="text-xs text-[#A3A3A3] shrink-0">(You)</span>}
                  </div>
                  <span
                    className={`text-xs ${
                      member.status === 'online' ? 'text-[#10B981]' : 'text-[#A3A3A3]'
                    }`}
                  >
                    {member.status === 'online' ? 'online' : 'offline'}
                  </span>
                </div>

                {member.role === 'creator' && (
                  <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[#FBBF24]/15 text-[#FBBF24] shrink-0">
                    <Crown size={11} /> Creator
                  </span>
                )}
                {member.role === 'admin' && (
                  <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-[#10B981]/15 text-[#10B981] shrink-0">
                    <Shield size={11} /> Admin
                  </span>
                )}

                {!isMe && (
                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setMemberMenu(memberMenu === member.user_id ? null : member.user_id)}
                      aria-label={`Actions for ${member.display_name}`}
                      data-testid="group-member-menu"
                      className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] rounded-[6px] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all"
                    >
                      <MoreVertical size={15} />
                    </button>
                    <AnimatePresence>
                      {memberMenu === member.user_id && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setMemberMenu(null)} />
                          <motion.div
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.95 }}
                            transition={{ duration: 0.12 }}
                            className="absolute right-0 top-full mt-1 w-48 bg-[#141414] border border-[#1F1F1F] rounded-[8px] shadow-[0_12px_40px_rgba(0,0,0,0.6)] z-50 py-1"
                          >
                            <button
                              type="button"
                              onClick={() => handleMessageMember(member.user_id)}
                              data-testid="group-member-message"
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#F5F5F5] hover:bg-[#1A1A1A] transition-colors"
                            >
                              <MessageSquare size={13} /> Message
                            </button>
                            {canPromote && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleChangeRole(member.user_id, member.role === 'admin' ? 'member' : 'admin')
                                }
                                data-testid="group-member-role"
                                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#F5F5F5] hover:bg-[#1A1A1A] transition-colors"
                              >
                                {member.role === 'admin' ? <ShieldOff size={13} /> : <ShieldCheck size={13} />}
                                {member.role === 'admin' ? 'Dismiss as admin' : 'Make group admin'}
                              </button>
                            )}
                            {canManage && (
                              <button
                                type="button"
                                onClick={() => handleRemoveMember(member.user_id)}
                                data-testid="group-member-remove"
                                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
                              >
                                <UserMinus size={13} /> Remove from group
                              </button>
                            )}
                          </motion.div>
                        </>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <>
      <InfoPanelShell
        isOpen={isOpen}
        onClose={onClose}
        title="Group info"
        sections={sections}
        activeSection={section}
        onSectionChange={setSection}
        navTestIdPrefix="group-info-nav-"
        panelTestId="group-info-panel"
      >
        {section === 'info' && renderInfo()}
        {section === 'media' && (
          <MediaLinksDocsSection
            conversationId={convId}
            onJumpToMessage={(msgId) => {
              onClose?.();
              onJumpToMessage?.(msgId);
            }}
            testIdPrefix="group-info-media"
          />
        )}
        {section === 'starred' && (
          <StarredSection
            conversationId={convId}
            onJumpToMessage={(msgId) => {
              onClose?.();
              onJumpToMessage?.(msgId);
            }}
            testIdPrefix="group-info-starred"
          />
        )}
        {section === 'permissions' && renderPermissions()}
        {section === 'encryption' && <EncryptionSection testIdPrefix="group-info-encryption" />}
        {section === 'members' && renderMembers()}
      </InfoPanelShell>

      <ConfirmDialog
        open={confirm === 'clear'}
        title="Clear this chat?"
        body="Every message will be removed from your copy of this chat. Other members keep theirs."
        confirmLabel="Clear chat"
        busy={confirmBusy}
        onConfirm={handleClearChat}
        onCancel={() => setConfirm(null)}
        testId="group-info-clear-confirm"
      />

      <ConfirmDialog
        open={confirm === 'leave'}
        title={`Exit "${conversation.name || 'this group'}"?`}
        body="You will stop receiving messages from this group. Only group admins can add you back."
        confirmLabel="Exit group"
        busy={confirmBusy}
        onConfirm={handleLeave}
        onCancel={() => setConfirm(null)}
        testId="group-info-leave-confirm"
      />

      <NewChatModal
        isOpen={showAddMembers}
        onClose={() => setShowAddMembers(false)}
        onSelectContact={handleAddMember}
      />

      <CreateGroupModal
        isOpen={showSimilarGroup}
        onClose={() => setShowSimilarGroup(false)}
        prefillMembers={similarGroupMembers}
        prefillName={conversation.name ? `${conversation.name} (2)` : ''}
        prefillDescription={conversation.description || ''}
        onGroupCreated={(group) => {
          setShowSimilarGroup(false);
          onClose?.();
          onGroupCreated?.(group);
          if (group?._id) setActiveConversation(group._id);
        }}
      />
    </>
  );
};
