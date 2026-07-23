import React, { useState, useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

export const AdminLayout = () => {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 1024);

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) setCollapsed(true);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const toggleSidebar = () => setCollapsed(!collapsed);

  return (
    <div className="min-h-screen bg-[#0A0A0A]">
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} />
      <TopBar onMenuClick={toggleSidebar} collapsed={collapsed} />
      <main
        className={`transition-all duration-300 p-4 md:p-6
          ${collapsed ? 'lg:ml-[72px]' : 'lg:ml-[260px]'}
        `}
      >
        <Outlet />
      </main>
    </div>
  );
};
