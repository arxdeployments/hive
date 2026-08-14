/**
 * Contact Info — WhatsApp-parity two-column drawer.
 *
 *   <ContactInfoPanel contact={user} conversation={conv} isOpen={bool} onClose={fn} initialSection="info" />
 *
 * Left rail: Info · Media, links and docs · Starred · Encryption · Groups in common.
 * Every nav item carries data-testid="contact-info-nav-<section>".
 *
 * HARD RULE: this panel never renders a phone number. WhatsApp puts the phone
 * number under the contact's name; RX HIVE is an org directory keyed on work
 * email, so the email goes there instead, alongside the department.
 * There is no phone field in the wire contract — do not add one.
 *
 * Organization and "about" are deliberately absent: nothing the panel can reach
 * carries them for *another* user — participants come from
 * enrich.serialize_user_brief and the roster from GET /api/users/contacts, and
 * neither sends `org_name` or `about` (only /api/auth/me exposes your own about).
 * Both rows rendered a permanent em dash. Do not re-add them without a wire
 * field to fill them.
 *
 * `contact` is optional: when it is omitted the other participant of a direct
 * conversation is used, which is how ChatPanel opens the panel today.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiError } from '../../utils/helpers';
import {
  Check,
  Copy,
  FolderTree,
  Info,
  Image as ImageIcon,
  Lock,
  Mail,
  Phone,
  Search,
  Star,
  Users,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import client from '../../api/client';
import useChatStore from '../../stores/chatStore';
import useCallStore from '../../stores/callStore';
import wsClient from '../../services/websocket';
import { useAuth } from '../../contexts/AuthContext';
import { InfoPanelShell } from './info/InfoPanelShell';
import { MediaLinksDocsSection } from './info/MediaLinksDocsSection';
import { StarredSection } from './info/StarredSection';
import { EncryptionSection } from './info/EncryptionSection';
import {
  Avatar,
  EmptyState,
  LoadingState,
  QuickAction,
  SectionHeading,
  ToggleRow,
} from './info/InfoPanelPrimitives';

const formatPresence = (person) => {
  if (!person) return '';
  if (person.status === 'online') return 'online';
  if (person.last_seen) {
    const d = new Date(person.last_seen);
    if (Number.isNaN(d.getTime())) return 'offline';
    const now = new Date();
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
    if (d.toDateString() === now.toDateString()) return `last seen today at ${time}`;
    return `last seen ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${time}`;
  }
  return 'offline';
};

/** One read-only identity row (email / department). */
const DetailRow = ({ icon: Icon, label, value, onCopy, copied, testId }) => (
  <div className="flex items-center gap-3 px-4 py-3" data-testid={testId}>
    {Icon && <Icon size={18} className="text-[#A3A3A3] shrink-0" />}
    <div className="flex-1 min-w-0">
      <p className="text-[11px] uppercase tracking-[0.08em] text-[#A3A3A3]">{label}</p>
      <p className="text-sm text-[#F5F5F5] truncate mt-0.5">{value || '—'}</p>
    </div>
    {onCopy && value && (
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy ${label.toLowerCase()}`}
        data-testid={testId ? `${testId}-copy` : undefined}
        className="shrink-0 p-2 text-[#A3A3A3] hover:text-[#10B981] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
      >
        {copied ? <Check size={15} className="text-[#10B981]" /> : <Copy size={15} />}
      </button>
    )}
  </div>
);

export const ContactInfoPanel = ({
  contact,
  conversation,
  isOpen,
  onClose,
  initialSection = 'info',
  currentUserId,
  onJumpToMessage,
  onSearchMessages,
  onSelectConversation,
}) => {
  const { user } = useAuth();
  const myUserId = currentUserId || user?.id;
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const updateConversation = useChatStore((s) => s.updateConversation);

  const [section, setSection] = useState(initialSection);
  const [directory, setDirectory] = useState(null); // roster row: email + department
  const [groups, setGroups] = useState([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState(false);
  const [muted, setMuted] = useState(false);
  const [mutePending, setMutePending] = useState(false);
  const [copied, setCopied] = useState(false);

  const convId = conversation?._id;
  const participants = useMemo(() => conversation?.participants || [], [conversation]);

  // The contact prop wins; otherwise fall back to the other side of a direct chat.
  const base = useMemo(() => {
    if (contact) return contact;
    if (conversation?.type === 'direct') {
      return participants.find((p) => p.user_id !== myUserId) || null;
    }
    return null;
  }, [contact, conversation?.type, participants, myUserId]);

  const targetId = base?.user_id || base?.id || null;

  // Presence lives on the conversation participant even when `contact` came from
  // a stale roster row, so prefer the participant for status/last_seen.
  const livePresence = useMemo(
    () => participants.find((p) => p.user_id === targetId) || null,
    [participants, targetId]
  );

  const person = useMemo(() => {
    if (!base) return null;
    return {
      user_id: targetId,
      display_name: base.display_name || base.name || 'Unknown',
      avatar_url: base.avatar_url || livePresence?.avatar_url || null,
      status: livePresence?.status || base.status || 'offline',
      last_seen: livePresence?.last_seen || base.last_seen || null,
      email: base.email || directory?.email || '',
      department: base.department_name || base.department || directory?.department_name || '',
    };
  }, [base, targetId, livePresence, directory]);

  useEffect(() => {
    if (isOpen) {
      setSection(initialSection || 'info');
      setCopied(false);
    }
  }, [isOpen, initialSection, targetId]);

  useEffect(() => {
    const mine = participants.find((p) => p.user_id === myUserId);
    setMuted(Boolean(conversation?.is_muted ?? mine?.is_muted ?? false));
  }, [conversation?.is_muted, participants, myUserId]);

  /**
   * Email and department are not on the conversation participant wire shape, so
   * when the caller did not hand us a directory-shaped `contact` we resolve the
   * row from the org roster (already cached in the chat store when available).
   */
  useEffect(() => {
    if (!isOpen || !targetId) return;
    if (base?.email && (base?.department_name || base?.department)) {
      setDirectory(null);
      return;
    }
    const cached = useChatStore.getState().contacts?.find((c) => c.id === targetId);
    if (cached) {
      setDirectory(cached);
      return;
    }
    let cancelled = false;
    // One record, asked for by id.
    //
    // This used to GET the entire org roster and run `rows.find(c => c.id === …)`
    // in the browser — 5.5 MB on a 25,000-user tenant, to read one row. That was
    // only ever viable while /contacts was unbounded; now that it is capped, the
    // find would simply have missed for anyone outside the first page and the
    // panel would have rendered blank with no error to explain it.
    client
      .get(`/api/users/directory/${targetId}`)
      .then(({ data }) => {
        if (cancelled) return;
        setDirectory(data || null);
        // Keep the shared contacts map warm for whoever reads it next, without
        // claiming to have loaded a roster we did not fetch.
        if (data?.id) useChatStore.getState().upsertContact(data);
      })
      .catch(() => {
        if (!cancelled) setDirectory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, targetId, base?.email, base?.department_name, base?.department]);

  const loadGroups = useCallback(async () => {
    if (!targetId) return;
    setGroupsLoading(true);
    setGroupsError(false);
    try {
      const { data } = await client.get(`/api/users/${targetId}/groups-in-common`);
      setGroups(data?.data || []);
    } catch {
      setGroups([]);
      setGroupsError(true);
    } finally {
      setGroupsLoading(false);
    }
  }, [targetId]);

  useEffect(() => {
    if (isOpen && section === 'groups') loadGroups();
  }, [isOpen, section, loadGroups]);

  const handleCall = (callType) => {
    if (!targetId) return;
    if (useCallStore.getState().callState !== 'idle') {
      toast.error('You are already in a call');
      return;
    }
    wsClient.send({
      type: 'call:initiate',
      callee_id: targetId,
      call_type: callType,
      conversation_id: convId,
    });
    useCallStore.getState().initiateCall(null, callType, false, convId);
    onClose?.();
  };

  const handleCopyEmail = async () => {
    if (!person?.email) return;
    try {
      await navigator.clipboard.writeText(person.email);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Could not copy the email address');
    }
  };

  const handleToggleMute = async (next) => {
    if (!convId) return;
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
      toast.error(apiError(err, 'Failed to change mute'));
    } finally {
      setMutePending(false);
    }
  };

  const openGroup = (groupId) => {
    onClose?.();
    if (onSelectConversation) onSelectConversation(groupId);
    else setActiveConversation(groupId);
  };

  const sections = [
    { id: 'info', label: 'Info', icon: Info },
    { id: 'media', label: 'Media, links and docs', icon: ImageIcon },
    { id: 'starred', label: 'Starred', icon: Star },
    { id: 'encryption', label: 'Encryption', icon: Lock },
    { id: 'groups', label: 'Groups in common', icon: Users },
  ];

  if (!person) return null;

  const renderInfo = () => (
    <div className="p-5 space-y-6">
      {/* Identity — email under the name, never a phone number. */}
      <div className="flex flex-col items-center text-center">
        <Avatar name={person.display_name} src={person.avatar_url} size={112} />
        <h2 className="text-xl font-semibold text-[#F5F5F5] mt-4">{person.display_name}</h2>
        <p className="text-sm text-[#A3A3A3] mt-1 break-all" data-testid="contact-info-email-inline">
          {person.email || 'Email not available'}
        </p>
        <p
          className={`text-xs mt-1 ${person.status === 'online' ? 'text-[#10B981]' : 'text-[#A3A3A3]'}`}
        >
          {formatPresence(person)}
        </p>
      </div>

      {/* Quick actions */}
      <div className="flex gap-2">
        <QuickAction icon={Phone} label="Audio" onClick={() => handleCall('voice')} testId="contact-info-action-audio" />
        <QuickAction icon={Video} label="Video" onClick={() => handleCall('video')} testId="contact-info-action-video" />
        <QuickAction
          icon={Search}
          label="Search"
          disabled={!convId}
          onClick={() => {
            onClose?.();
            onSearchMessages?.();
          }}
          testId="contact-info-action-search"
        />
      </div>

      {/* Directory details */}
      <div>
        <SectionHeading className="px-1 mb-2">Directory</SectionHeading>
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[10px] divide-y divide-[#1F1F1F]">
          <DetailRow
            icon={Mail}
            label="Email"
            value={person.email}
            onCopy={handleCopyEmail}
            copied={copied}
            testId="contact-info-email"
          />
          <DetailRow
            icon={FolderTree}
            label="Department"
            value={person.department}
            testId="contact-info-department"
          />
        </div>
      </div>

      {/* Chat settings */}
      {convId && (
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[10px] divide-y divide-[#1F1F1F]">
          <ToggleRow
            label="Mute notifications"
            description={muted ? 'You will not be notified about new messages' : 'Notifications are on'}
            checked={muted}
            busy={mutePending}
            onChange={handleToggleMute}
            testId="contact-info-mute-toggle"
          />
        </div>
      )}
    </div>
  );

  const renderGroups = () => {
    if (groupsLoading) return <LoadingState label="Loading groups…" />;
    if (groupsError) {
      return (
        <div className="flex flex-col items-center py-16 gap-3">
          <p className="text-sm text-[#A3A3A3]">Couldn&apos;t load groups in common.</p>
          <button
            type="button"
            onClick={loadGroups}
            className="px-3 py-1.5 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    if (groups.length === 0) {
      return (
        <EmptyState
          icon={Users}
          title="No groups in common"
          hint={`You and ${person.display_name} are not in any of the same groups yet.`}
        />
      );
    }
    return (
      <div className="p-4 space-y-1" data-testid="contact-info-groups-list">
        <p className="text-xs text-[#A3A3A3] px-1 pb-1">
          {groups.length} {groups.length === 1 ? 'group' : 'groups'} in common
        </p>
        {groups.map((group) => (
          <button
            key={group._id}
            type="button"
            onClick={() => openGroup(group._id)}
            data-testid="contact-info-group-item"
            className="w-full flex items-center gap-3 p-2.5 rounded-[8px] hover:bg-[#141414] transition-colors text-left"
          >
            <Avatar name={group.name || 'Group'} src={group.avatar_url} size={38} />
            <span className="flex-1 min-w-0">
              <span className="block text-sm text-[#F5F5F5] truncate">{group.name || 'Group'}</span>
              <span className="block text-xs text-[#A3A3A3] truncate">
                {(group.participants || [])
                  .map((p) => (p.user_id === myUserId ? 'You' : p.display_name))
                  .filter(Boolean)
                  .slice(0, 4)
                  .join(', ')}
                {(group.participants || []).length > 4 && ` +${group.participants.length - 4}`}
              </span>
            </span>
            {group.cross_org && (
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-[#10B981]/15 text-[#10B981] shrink-0">
                Cross-Org
              </span>
            )}
          </button>
        ))}
      </div>
    );
  };

  return (
    <>
      <InfoPanelShell
        isOpen={isOpen}
        onClose={onClose}
        title="Contact info"
        sections={sections}
        activeSection={section}
        onSectionChange={setSection}
        navTestIdPrefix="contact-info-nav-"
        panelTestId="contact-info-panel"
      >
        {section === 'info' && renderInfo()}
        {section === 'media' &&
          (convId ? (
            <MediaLinksDocsSection
              conversationId={convId}
              onJumpToMessage={(msgId) => {
                onClose?.();
                onJumpToMessage?.(msgId);
              }}
              testIdPrefix="contact-info-media"
            />
          ) : (
            <EmptyState icon={ImageIcon} title="No chat yet" hint="Start a chat to share media, links and docs." />
          ))}
        {section === 'starred' &&
          (convId ? (
            <StarredSection
              conversationId={convId}
              onJumpToMessage={(msgId) => {
                onClose?.();
                onJumpToMessage?.(msgId);
              }}
              testIdPrefix="contact-info-starred"
            />
          ) : (
            <EmptyState icon={Star} title="No starred messages" hint="Start a chat to star messages." />
          ))}
        {section === 'encryption' && <EncryptionSection testIdPrefix="contact-info-encryption" />}
        {section === 'groups' && renderGroups()}
      </InfoPanelShell>
    </>
  );
};
