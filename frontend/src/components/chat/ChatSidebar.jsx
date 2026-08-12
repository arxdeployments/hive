import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { MessageSquarePlus, Users, Search, Settings } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { ConversationItem } from './ConversationItem';
import { NewChatModal } from './NewChatModal';
import { CreateGroupModal } from './CreateGroupModal';
import { GlobalSearchResults } from './GlobalSearchResults';
import { ProfileDrawer } from './ProfileDrawer';
import useChatStore from '../../stores/chatStore';
import client from '../../api/client';

import { CallsTab } from '../calls/CallsTab';
import { WorkspaceSwitcher } from '../shared/WorkspaceSwitcher';
import useCallStore from '../../stores/callStore';

const FILTER_TABS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'groups', label: 'Groups' },
];

export const ChatSidebar = ({ onSelectConversation, isMobile }) => {
  const { user } = useAuth();
  const navigate = useNavigate();
  // Narrow selectors: `useChatStore()` subscribed the whole sidebar (and every
  // row in it) to every store write, including message traffic in threads that
  // aren't even shown here. `typingUsers` is deliberately not read at this level
  // — each ConversationItem subscribes to its own slice, so one person typing
  // re-renders one row instead of the entire list.
  const conversations = useChatStore(s => s.conversations);
  const activeConversationId = useChatStore(s => s.activeConversationId);
  const wsConnected = useChatStore(s => s.wsConnected);
  const setConversations = useChatStore(s => s.setConversations);
  const clearUnread = useChatStore(s => s.clearUnread);

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [activeTab, setActiveTab] = useState('chats');
  const [showNewChat, setShowNewChat] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [loading, setLoading] = useState(true);
  // Whether the LAST load failed. Distinguishes "this account has no
  // conversations" from "we never found out", which rendered identically.
  const [loadFailed, setLoadFailed] = useState(false);

  // Only the newest load may write. `search` is in the deps below, so every
  // keystroke rebuilds this callback and re-runs the effect — several loads are
  // in flight at once and nothing makes them return in the order they were sent.
  // A two-character prefix matching every thread is slower to answer than the
  // five-character one typed after it, so the sidebar could settle on a search
  // the box no longer contains. The reconnect poll, the visibility handler and
  // both retry buttons stack more callers on top of that.
  const reqSeqRef = useRef(0);

  const fetchConversations = useCallback(async () => {
    const seq = ++reqSeqRef.current;
    try {
      const { data } = await client.get('/api/conversations', {
        params: { search, filter }
      });
      if (seq !== reqSeqRef.current) return;
      setConversations(data.data);
      setLoadFailed(false);
    } catch (err) {
      console.error('Failed to fetch conversations', err);
      // The list is left exactly as it was — a failed refresh must not blank a
      // sidebar that is already showing good data. The flag decides whether the
      // EMPTY state may claim "No conversations yet" — a statement about the
      // account, and one that was being made on the strength of a request that
      // never came back — and, when rows were kept, whether the refresh warning
      // goes up over them.
      if (seq === reqSeqRef.current) setLoadFailed(true);
    } finally {
      if (seq === reqSeqRef.current) setLoading(false);
    }
  }, [search, filter, setConversations]);

  useEffect(() => {
    const timer = setTimeout(fetchConversations, 300);
    // Bumping as well as clearing: if the timer already fired, the request it
    // started is in the air and this keystroke (or an unmount) disowns it, rather
    // than leaving a 300ms window in which it could still write.
    return () => { clearTimeout(timer); reqSeqRef.current++; };
  }, [fetchConversations]);

  /**
   * No polling while the socket is up.
   *
   * The 15s interval predates a working WebSocket. Now that the socket delivers
   * new_message, conversation_created/updated, member_*, presence and
   * profile_updated, the poll added nothing but cost: four requests a minute at
   * idle, and — because it replaced the whole list with freshly deserialized
   * objects — a full re-render of every row each time, which also clobbered the
   * locally-bumped order and any just-cleared unread badge.
   *
   * What is left is a genuine safety net for the only case the socket cannot
   * cover: it being down. The socket's own reconnect handler re-syncs the list
   * (_syncAfterReconnect), and returning to a backgrounded tab re-syncs too,
   * since a socket can die while hidden without the close event landing.
   */
  useEffect(() => {
    if (wsConnected) return undefined;
    const interval = setInterval(fetchConversations, 15000);
    return () => clearInterval(interval);
  }, [wsConnected, fetchConversations]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchConversations();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fetchConversations]);

  const handleSelectContact = async (contactId) => {
    try {
      const { data } = await client.post('/api/conversations/direct', {
        participant_id: contactId
      });
      setShowNewChat(false);
      // Refresh conversations
      await fetchConversations();
      onSelectConversation(data._id);
    } catch (err) {
      toast.error(err.response?.data?.detail || 'Failed to create conversation');
    }
  };

  const handleConversationClick = useCallback((conv) => {
    onSelectConversation(conv._id);
    // Clear the badge immediately; ChatPanel issues the PUT /read for every open
    // path (this one included), so doing it here too just doubled the request.
    if (conv.unread_count > 0) clearUnread(conv._id);
  }, [onSelectConversation, clearUnread]);

  return (
    <div className="h-full flex flex-col bg-[#0F0F0F] border-r border-[#1F1F1F] overflow-hidden" data-testid="chat-sidebar">
      {/* Header */}
      <div className="h-[60px] flex items-center justify-between px-4 border-b border-[#1F1F1F] flex-shrink-0">
        {/* A real <button>, matching the identity control in the ChatPanel header.
            This is the only route to the profile drawer anywhere in the app — the
            overflow menu no longer offers "Profile" and the settings page has no
            name/About/avatar editing — so a bare div with an onClick left a
            keyboard-only user unable to reach their own profile at all.

            The avatar becomes a <span> because a <button> may only contain
            phrasing content; the classes on it already set display:flex, so
            nothing moves. `flex` likewise overrides the button's inline-block
            default and `text-left` cancels the UA's centring, so the pointer
            experience is byte-for-byte what it was. */}
        <button
          type="button"
          onClick={() => setShowProfile(true)}
          aria-label={user?.name ? `Open profile for ${user.name}` : 'Open your profile'}
          data-testid="sidebar-profile-button"
          className="flex items-center gap-3 cursor-pointer min-w-0 text-left rounded-[6px] focus:outline-none focus-visible:ring-1 focus-visible:ring-[#10B981]"
        >
          <span className="w-9 h-9 shrink-0 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium">
            {user?.name?.charAt(0)?.toUpperCase() || 'U'}
          </span>
          {!isMobile && (
            // truncate + the min-w-0 above: this span had no way to shrink, so
            // the header's min-content was avatar + full name + every control.
            // Anything added to the right-hand group then overflowed a sidebar
            // that is a fixed 300px (or 360px at lg) and overflow-hidden, with
            // the page itself position:fixed — so it clipped silently instead of
            // scrolling. The name is the one thing here that can safely give.
            <span className="text-sm font-medium text-[#F5F5F5] truncate">{user?.name}</span>
          )}
        </button>
        <div className="flex items-center gap-1 shrink-0">
          {/* Renders only for org admins; returns null for everyone else, so the
              header is unchanged for ordinary users.
              ALWAYS compact, not just on mobile: the labelled form is ~154px and
              the three icon buttons alone already fill a 300px sidebar. Labels
              live on the admin side, where the header is full width. */}
          <WorkspaceSwitcher compact className="mr-1" />
          <button
            onClick={() => setShowNewChat(true)}
            data-testid="new-chat-button"
            className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
            title="New Chat"
          >
            <MessageSquarePlus size={20} />
          </button>
          <button
            onClick={() => setShowCreateGroup(true)}
            data-testid="new-group-button"
            className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
            title="New Group"
          >
            <Users size={20} />
          </button>
          {/* Settings, opened directly.
              This replaces a three-dot menu whose only contents were Profile,
              Settings and Logout. Profile was already reachable by tapping the
              avatar to the left, so the menu mostly existed to hide two links
              behind an extra click. Logout now lives on the Settings page, which
              is where a destructive account action belongs — next to the account
              it acts on, rather than one hover away from "New group". */}
          <button
            onClick={() => navigate('/settings')}
            data-testid="sidebar-settings-button"
            aria-label="Settings"
            title="Settings"
            className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
          >
            <Settings size={20} />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0 relative">
        <div className="relative">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
          <input
            type="text"
            placeholder="Search conversations..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setShowGlobalSearch(e.target.value.trim().length > 0); }}
            onFocus={() => { if (search.trim()) setShowGlobalSearch(true); }}
            data-testid="conversation-search"
            className="w-full h-9 pl-9 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none transition-all"
          />
        </div>
        <GlobalSearchResults
          query={search}
          isOpen={showGlobalSearch && search.trim().length > 0}
          onSelectConversation={(id) => { onSelectConversation(id); setSearch(''); setShowGlobalSearch(false); }}
          onSelectContact={async (contactId) => {
            try {
              const { data } = await client.post('/api/conversations/direct', { participant_id: contactId });
              await fetchConversations();
              onSelectConversation(data._id);
            } catch { toast.error('Failed to open conversation'); }
            setSearch(''); setShowGlobalSearch(false);
          }}
          onSelectMessage={(convId) => { onSelectConversation(convId); setSearch(''); setShowGlobalSearch(false); }}
          onClose={() => setShowGlobalSearch(false)}
        />
      </div>

      {/* Chats / Calls Tab Switcher */}
      <div className="flex border-b border-[#1F1F1F] flex-shrink-0">
        {[{ key: 'chats', label: 'Chats', icon: '💬' }, { key: 'calls', label: 'Calls', icon: '📞' }].map(tab => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex-1 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === tab.key ? 'text-[#10B981]' : 'text-[#A3A3A3] hover:text-[#F5F5F5]'
            }`}>
            {tab.label}
            {tab.key === 'calls' && useCallStore.getState().missedCallCount > 0 && (
              <span className="absolute top-1.5 right-[30%] w-4 h-4 bg-[#EF4444] rounded-full text-[10px] text-white flex items-center justify-center">
                {useCallStore.getState().missedCallCount}
              </span>
            )}
            {activeTab === tab.key && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#10B981]" />}
          </button>
        ))}
      </div>

      {activeTab === 'calls' ? (
        <CallsTab />
      ) : (
      <>
      {/* Filter Tabs */}
      <div className="px-3 py-1.5 flex gap-2 flex-shrink-0">
        {FILTER_TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            data-testid={`filter-${tab.key}`}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              filter === tab.key
                ? 'bg-[#10B981] text-white'
                : 'bg-[#1A1A1A] text-[#A3A3A3] hover:bg-[#2D2D2D]'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Conversation List */}
      <div className="flex-1 overflow-y-auto scrollable-area min-h-0">
        {/* A refresh that failed over a list we still have. The empty-state
            branch below cannot cover this — it is gated on having nothing left
            to show — so without this the sidebar presents stale threads as
            current: the same lie the ChatPanel strip exists to prevent, and the
            more likely one, since the reconnect poll and the visibility handler
            both refresh a list that is already populated.

            Sibling of the branch chain rather than a fourth arm of it: those
            arms are mutually exclusive and this has to render ALONGSIDE the
            rows. Sticky rather than absolute so it stays reachable once the
            user scrolls a long list, and it cannot overlap the skeleton — that
            needs `loading`, which only ever goes false. */}
        {loadFailed && conversations.length > 0 && (
          <div
            role="alert"
            data-testid="conversations-refresh-error"
            className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-2 bg-[#0A0A0A]/95 border-b border-[#1F1F1F]"
          >
            <span className="text-xs text-[#A3A3A3]">Couldn&apos;t refresh conversations.</span>
            <button
              type="button"
              onClick={fetchConversations}
              data-testid="conversations-refresh-retry"
              className="px-2 py-1 text-xs text-[#10B981] border border-[#10B981]/40 rounded-[6px] hover:bg-[#10B981]/10 transition-colors flex-shrink-0"
            >
              Try again
            </button>
          </div>
        )}
        {loading ? (
          <div className="space-y-1 p-2">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-3">
                <div className="w-11 h-11 rounded-full bg-[#1A1A1A] animate-pulse flex-shrink-0" />
                <div className="flex-1">
                  <div className="h-4 w-28 bg-[#1A1A1A] rounded animate-pulse" />
                  <div className="h-3 w-40 bg-[#1A1A1A] rounded animate-pulse mt-1.5" />
                </div>
              </div>
            ))}
          </div>
        ) : conversations.length === 0 && loadFailed ? (
          /* An empty list we could not verify. "No conversations yet" is a claim
             about the account; making it off the back of a request that failed
             tells the user their history is gone. */
          <div className="text-center py-16 px-4" data-testid="conversations-load-error">
            <p className="text-sm text-[#A3A3A3] mb-3">Couldn&apos;t load your conversations.</p>
            <button
              onClick={fetchConversations}
              data-testid="conversations-retry"
              className="px-4 py-2 rounded-[6px] text-sm font-medium border border-[#10B981]/40 text-[#10B981] hover:bg-[#10B981]/10 transition-colors"
            >
              Try again
            </button>
          </div>
        ) : conversations.length === 0 ? (
          <div className="text-center py-16 px-4">
            <MessageSquarePlus size={32} className="text-[#A3A3A3]/30 mx-auto mb-3" />
            <p className="text-sm text-[#A3A3A3] mb-3">No conversations yet</p>
            <button
              onClick={() => setShowNewChat(true)}
              className="px-4 py-2 rounded-[6px] text-sm font-medium bg-[#10B981] text-[#0A0A0A] hover:bg-[#059669] transition-colors"
            >
              Start a Conversation
            </button>
          </div>
        ) : (
          // No AnimatePresence: none of these children declare an `exit`, so it
          // tracked presence for every row and bought nothing. The stagger is
          // capped too — at 0.03s per index a 40-thread list took over a second
          // to finish appearing.
          conversations.map((conv, idx) => (
            <motion.div
              key={conv._id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: Math.min(idx, 8) * 0.02 }}
            >
              <ConversationItem
                conversation={conv}
                currentUserId={user?.id}
                isActive={activeConversationId === conv._id}
                onClick={handleConversationClick}
              />
            </motion.div>
          ))
        )}
      </div>
      </>
      )}

      {/* New Chat Modal */}
      <NewChatModal
        isOpen={showNewChat}
        onClose={() => setShowNewChat(false)}
        onSelectContact={handleSelectContact}
      />

      {/* Create Group Modal */}
      <CreateGroupModal
        isOpen={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
        onGroupCreated={(group) => {
          fetchConversations();
          onSelectConversation(group._id);
        }}
      />

      {/* Profile Drawer */}
      <ProfileDrawer isOpen={showProfile} onClose={() => setShowProfile(false)} />
    </div>
  );
};
