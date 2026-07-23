import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { MessageSquarePlus, Users, MoreVertical, Search, LogOut, User, Settings, Building2 } from 'lucide-react';
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
import useCallStore from '../../stores/callStore';

const FILTER_TABS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'groups', label: 'Groups' },
];

export const ChatSidebar = ({ onSelectConversation, isMobile, onBack }) => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { conversations, setConversations, activeConversationId, typingUsers, clearUnread } = useChatStore();

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [activeTab, setActiveTab] = useState('chats');
  const [showNewChat, setShowNewChat] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [showGlobalSearch, setShowGlobalSearch] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchConversations = useCallback(async () => {
    try {
      const { data } = await client.get('/api/conversations', {
        params: { search, filter }
      });
      setConversations(data.data);
    } catch (err) {
      console.error('Failed to fetch conversations', err);
    } finally {
      setLoading(false);
    }
  }, [search, filter, setConversations]);

  useEffect(() => {
    const timer = setTimeout(fetchConversations, 300);
    return () => clearTimeout(timer);
  }, [fetchConversations]);

  // Light refresh every 15s as fallback (WS handles most updates now)
  useEffect(() => {
    const interval = setInterval(fetchConversations, 15000);
    return () => clearInterval(interval);
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

  const handleLogout = async () => {
    await logout();
    toast.success('Logged out successfully');
    navigate('/login');
  };

  const handleConversationClick = (conv) => {
    onSelectConversation(conv._id);
    // Mark as read via API
    if (conv.unread_count > 0) {
      client.put(`/api/conversations/${conv._id}/read`).catch(() => {});
      clearUnread(conv._id);
    }
  };

  return (
    <div className="h-full flex flex-col bg-[#0F0F0F] border-r border-[#1F1F1F] overflow-hidden" data-testid="chat-sidebar">
      {/* Header */}
      <div className="h-[60px] flex items-center justify-between px-4 border-b border-[#1F1F1F] flex-shrink-0">
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setShowProfile(true)}>
          <div className="w-9 h-9 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium">
            {user?.name?.charAt(0)?.toUpperCase() || 'U'}
          </div>
          {!isMobile && (
            <span className="text-sm font-medium text-[#F5F5F5]">{user?.name}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
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
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              data-testid="sidebar-menu-button"
              className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
            >
              <MoreVertical size={20} />
            </button>
            <AnimatePresence>
              {showMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95, y: -4 }}
                    transition={{ duration: 0.15 }}
                    className="absolute right-0 top-full mt-1 w-48 bg-[#141414] border border-[#1F1F1F] rounded-[8px] shadow-lg z-50 py-1"
                  >
                    <button onClick={() => { setShowProfile(true); setShowMenu(false); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#A3A3A3] hover:bg-[#1A1A1A] hover:text-[#F5F5F5] transition-colors">
                      <User size={16} /> Profile
                    </button>
                    <button onClick={() => { setShowMenu(false); navigate('/settings'); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#A3A3A3] hover:bg-[#1A1A1A] hover:text-[#F5F5F5] transition-colors">
                      <Settings size={16} /> Settings
                    </button>
                    {user?.role === 'admin' && (
                      <>
                        <div className="border-t border-[#1F1F1F] my-1" />
                        <button onClick={() => { setShowMenu(false); navigate('/org-admin'); }}
                          data-testid="manage-org-button"
                          className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#10B981] hover:bg-[#10B981]/10 transition-colors">
                          <Building2 size={16} /> Manage Organization
                        </button>
                      </>
                    )}
                    <div className="border-t border-[#1F1F1F] my-1" />
                    <button
                      onClick={handleLogout}
                      data-testid="chat-logout-button"
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-[#EF4444] hover:bg-[#EF4444]/10 transition-colors"
                    >
                      <LogOut size={16} /> Logout
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
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
            } catch (err) { toast.error('Failed to open conversation'); }
            setSearch(''); setShowGlobalSearch(false);
          }}
          onSelectMessage={(convId, msgId) => { onSelectConversation(convId); setSearch(''); setShowGlobalSearch(false); }}
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
          <AnimatePresence>
            {conversations.map((conv, idx) => (
              <motion.div
                key={conv._id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: idx * 0.03 }}
              >
                <ConversationItem
                  conversation={conv}
                  currentUserId={user?.id}
                  isActive={activeConversationId === conv._id}
                  onClick={() => handleConversationClick(conv)}
                  typingUsers={typingUsers}
                />
              </motion.div>
            ))}
          </AnimatePresence>
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
