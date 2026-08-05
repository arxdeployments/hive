import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  Building2,
  FolderTree,
  Users,
  Globe,
  Settings,
  LogOut,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

const navItems = [
  { path: '/admin', icon: LayoutDashboard, label: 'Dashboard', exact: true },
  { path: '/admin/organizations', icon: Building2, label: 'Organizations' },
  { path: '/admin/departments', icon: FolderTree, label: 'Departments' },
  { path: '/admin/users', icon: Users, label: 'Users' },
  { path: '/admin/cross-org-groups', icon: Globe, label: 'Cross-Org Groups' },
  // Its own entry rather than folded into Settings: this is the screen that
  // decides who can talk to whom, and burying it under a placeholder page would
  // make the product's central policy the hardest thing to find.
  { path: '/admin/settings', icon: Settings, label: 'Settings' },
];

export const Sidebar = ({ collapsed, onToggle }) => {
  const location = useLocation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    toast.success('Logged out successfully');
    navigate('/login');
  };

  const isActive = (item) => {
    if (item.exact) return location.pathname === item.path;
    return location.pathname.startsWith(item.path);
  };

  return (
    <>
      {/* Mobile overlay */}
      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onToggle}
            className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 lg:hidden"
          />
        )}
      </AnimatePresence>

      <aside
        className={`fixed top-0 left-0 h-screen bg-[#0F0F0F] border-r border-[#1F1F1F] z-50 flex flex-col transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]
          ${collapsed ? '-translate-x-full lg:translate-x-0 lg:w-[72px]' : 'translate-x-0 w-[260px]'}
        `}
      >
        {/* Logo */}
        <div className="h-16 flex items-center px-4 border-b border-[#1F1F1F] gap-3">
          {!collapsed && (
            <>
              <span
                className="text-xl font-bold text-[#F5F5F5]"
                style={{ textShadow: '0 0 30px rgba(16,185,129,0.2)' }}
              >
                RxHive
              </span>
              <span className="text-[10px] font-medium text-[#10B981] bg-[#10B981]/10 px-2 py-0.5 rounded-full">
                Admin
              </span>
            </>
          )}
          {collapsed && (
            <span
              className="text-lg font-bold text-[#10B981] mx-auto"
            >
              Rx
            </span>
          )}
        </div>

        {/* Nav items */}
        <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = isActive(item);

            if (item.disabled) {
              return (
                <div
                  key={item.path}
                  className="relative group"
                >
                  <div
                    className={`flex items-center gap-3 px-3 py-2.5 rounded-[6px] text-sm text-[#A3A3A3]/40 cursor-not-allowed
                      ${collapsed ? 'justify-center' : ''}
                    `}
                  >
                    <Icon size={20} />
                    {!collapsed && <span>{item.label}</span>}
                    {!collapsed && (
                      <span className="ml-auto text-[10px] bg-[#1A1A1A] border border-[#2D2D2D] px-1.5 py-0.5 rounded text-[#A3A3A3]/60">
                        Soon
                      </span>
                    )}
                  </div>
                  {collapsed && (
                    <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden group-hover:block z-50">
                      <div className="bg-[#141414] border border-[#1F1F1F] rounded-[6px] px-3 py-1.5 text-xs text-[#A3A3A3] whitespace-nowrap shadow-lg">
                        {item.label} - Coming Soon
                      </div>
                    </div>
                  )}
                </div>
              );
            }

            return (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.exact}
                className="relative group block"
                onClick={() => {
                  if (window.innerWidth < 1024) onToggle();
                }}
              >
                <div
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-[6px] text-sm transition-colors duration-150
                    ${active
                      ? 'bg-[rgba(16,185,129,0.1)] text-[#F5F5F5] border-l-[3px] border-l-[#10B981] rounded-l-none'
                      : 'text-[#A3A3A3] hover:bg-[#141414] hover:text-[#F5F5F5]'
                    }
                    ${collapsed ? 'justify-center' : ''}
                  `}
                >
                  <Icon size={20} className={active ? 'text-[#10B981]' : ''} />
                  {!collapsed && <span>{item.label}</span>}
                </div>
                {collapsed && (
                  <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden group-hover:block z-50">
                    <div className="bg-[#141414] border border-[#1F1F1F] rounded-[6px] px-3 py-1.5 text-xs text-[#F5F5F5] whitespace-nowrap shadow-lg">
                      {item.label}
                    </div>
                  </div>
                )}
              </NavLink>
            );
          })}
        </nav>

        {/* User section at bottom */}
        <div className="border-t border-[#1F1F1F] p-3">
          {!collapsed ? (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-[#10B981]/20 flex items-center justify-center text-[#10B981] text-sm font-medium">
                {user?.name?.charAt(0) || 'A'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-[#F5F5F5] truncate">{user?.name || 'Admin'}</p>
                <p className="text-xs text-[#A3A3A3] truncate">{user?.email}</p>
              </div>
              <button
                onClick={handleLogout}
                data-testid="sidebar-logout-button"
                className="p-2 text-[#A3A3A3] hover:text-[#EF4444] hover:bg-[#EF4444]/10 rounded-[6px] transition-colors duration-150"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <button
              onClick={handleLogout}
              data-testid="sidebar-logout-button"
              className="w-full p-2 text-[#A3A3A3] hover:text-[#EF4444] hover:bg-[#EF4444]/10 rounded-[6px] transition-colors duration-150 flex justify-center"
            >
              <LogOut size={18} />
            </button>
          )}
        </div>
      </aside>
    </>
  );
};
