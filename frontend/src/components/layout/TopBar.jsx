import React from 'react';
import { useLocation } from 'react-router-dom';
import { Menu, Bell } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';

const pageTitles = {
  '/admin': 'Dashboard',
  '/admin/organizations': 'Organizations',
  '/admin/departments': 'Departments',
  '/admin/users': 'Users',
  '/admin/settings': 'Settings',
  '/admin/cross-org-groups': 'Cross-Org Groups',
};

export const TopBar = ({ onMenuClick, collapsed }) => {
  const location = useLocation();
  const { user } = useAuth();

  const title = pageTitles[location.pathname] || 'Dashboard';

  return (
    <header className={`h-16 bg-[#0A0A0A]/80 backdrop-blur border-b border-[#1F1F1F] flex items-center justify-between px-6 sticky top-0 z-30 transition-all duration-300
      ${collapsed ? 'lg:ml-[72px]' : 'lg:ml-[260px]'}
    `}>
      <div className="flex items-center gap-4">
        <button
          onClick={onMenuClick}
          data-testid="topbar-menu-button"
          className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors duration-150"
        >
          <Menu size={20} />
        </button>
        <h2 className="text-lg font-semibold text-[#F5F5F5]">{title}</h2>
      </div>

      <div className="flex items-center gap-3">
        <button
          className="p-2 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors duration-150 relative"
          data-testid="topbar-notification-button"
        >
          <Bell size={20} />
        </button>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-[6px] hover:bg-[#1A1A1A] transition-colors duration-150 cursor-pointer">
          <div className="w-8 h-8 rounded-full bg-[#10B981]/20 flex items-center justify-center text-[#10B981] text-sm font-medium">
            {user?.name?.charAt(0) || 'A'}
          </div>
          <span className="text-sm text-[#F5F5F5] hidden sm:block">{user?.name}</span>
        </div>
      </div>
    </header>
  );
};
