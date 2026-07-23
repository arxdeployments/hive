import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, FolderTree, Settings, ArrowLeft } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

const navItems = [
  { path: '/org-admin', icon: LayoutDashboard, label: 'Overview', exact: true },
  { path: '/org-admin/users', icon: Users, label: 'Users' },
  { path: '/org-admin/departments', icon: FolderTree, label: 'Departments' },
  { path: '/org-admin/settings', icon: Settings, label: 'Org Settings' },
];

export const OrgAdminLayout = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="min-h-screen bg-[#0A0A0A] flex">
      {/* Sidebar */}
      <aside className={`h-screen bg-[#0F0F0F] border-r border-[#1F1F1F] flex flex-col ${collapsed ? 'w-[72px]' : 'w-[260px]'} transition-all duration-300 flex-shrink-0`}>
        <div className="h-16 flex items-center px-4 border-b border-[#1F1F1F] gap-3">
          {!collapsed && (
            <>
              <div className="w-8 h-8 rounded-[6px] bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-bold">O</div>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-bold text-[#F5F5F5] truncate block">Org Admin</span>
                <span className="text-[10px] text-[#10B981]">Organization Panel</span>
              </div>
            </>
          )}
        </div>

        <nav className="flex-1 py-4 px-3 space-y-1">
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <NavLink key={item.path} to={item.path} end={item.exact}
                className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-[6px] text-sm transition-colors ${
                  isActive
                    ? 'bg-[rgba(16,185,129,0.1)] text-[#F5F5F5] border-l-[3px] border-l-[#10B981] rounded-l-none'
                    : 'text-[#A3A3A3] hover:bg-[#141414] hover:text-[#F5F5F5]'
                } ${collapsed ? 'justify-center' : ''}`}>
                <Icon size={20} />
                {!collapsed && <span>{item.label}</span>}
              </NavLink>
            );
          })}
        </nav>

        <div className="border-t border-[#1F1F1F] p-3">
          <button onClick={() => navigate('/chat')}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-[6px] text-sm text-[#A3A3A3] hover:text-[#10B981] hover:bg-[#141414] transition-colors">
            <ArrowLeft size={18} />
            {!collapsed && <span>Back to Chat</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col">
        <header className="h-16 bg-[#0A0A0A]/80 backdrop-blur border-b border-[#1F1F1F] flex items-center justify-between px-6">
          <h2 className="text-lg font-semibold text-[#F5F5F5]">Organization Management</h2>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium">
              {user?.name?.charAt(0) || 'A'}
            </div>
            <span className="text-sm text-[#F5F5F5]">{user?.name}</span>
          </div>
        </header>
        <main className="flex-1 p-6 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
};
