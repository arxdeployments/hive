import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AnimatePresence } from 'framer-motion';
import { Loader2 } from 'lucide-react';

// Pages
import Login from './pages/Login';
import Chat from './pages/Chat';
import Dashboard from './pages/admin/Dashboard';
import Organizations from './pages/admin/Organizations';
import Departments from './pages/admin/Departments';
import UsersPage from './pages/admin/Users';
import SettingsPage from './pages/admin/Settings';
import CrossOrgGroups from './pages/admin/CrossOrgGroups';

// Org Admin Pages
import OrgAdminDashboard from './pages/OrgAdmin/OrgAdminDashboard';
import OrgAdminUsers from './pages/OrgAdmin/OrgAdminUsers';
import OrgAdminDepartments from './pages/OrgAdmin/OrgAdminDepartments';
import OrgAdminSettings from './pages/OrgAdmin/OrgAdminSettings';
import NotFound from './pages/NotFound';
import UserSettings from './pages/Settings';

// Layout
import { AdminLayout } from './components/layout/AdminLayout';
import { OrgAdminLayout } from './components/org-admin/OrgAdminLayout';

// Shared
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { OfflineBanner } from './components/shared/OfflineBanner';
import { IncomingCallOverlay } from './components/calls/IncomingCallOverlay';
import { OutgoingCallScreen } from './components/calls/OutgoingCallScreen';
import { MinimizedCallBanner } from './components/calls/MinimizedCallBanner';
import { ActiveCallView } from './components/calls/ActiveCallView';

// Route guards
const AuthRoute = ({ children }) => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-[#10B981] animate-spin mx-auto mb-3" />
          <p className="text-sm text-[#A3A3A3]">Checking session...</p>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return children;
};

const SuperAdminRoute = ({ children }) => {
  const { user, loading, logout } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 text-[#10B981] animate-spin mx-auto mb-3" />
          <p className="text-sm text-[#A3A3A3]">Checking session...</p>
        </div>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  if (user.role !== 'superadmin') {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
        <div className="bg-[#141414] border border-[#1F1F1F] rounded-[8px] p-8 max-w-sm text-center">
          <p className="text-[#EF4444] font-medium mb-2">Access Denied</p>
          <p className="text-sm text-[#A3A3A3] mb-4">You don't have permission to access the admin panel.</p>
          <button
            onClick={() => logout()}
            className="px-4 py-2 text-sm bg-[#1A1A1A] border border-[#2D2D2D] text-[#F5F5F5] rounded-[6px] hover:bg-[#2D2D2D] transition-colors"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return children;
};

const LoginRedirect = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-[#10B981] animate-spin" />
      </div>
    );
  }

  if (user) {
    return user.role === 'superadmin'
      ? <Navigate to="/admin" replace />
      : <Navigate to="/chat" replace />;
  }

  return <Login />;
};

const OrgAdminRoute = ({ children }) => {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center"><Loader2 className="w-8 h-8 text-[#10B981] animate-spin" /></div>;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== 'admin') return <Navigate to="/chat" replace />;
  return children;
};

function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <AuthProvider>
        <OfflineBanner />
        <IncomingCallOverlay />
        <OutgoingCallScreen />
        <ActiveCallView />
        <MinimizedCallBanner />
        <Toaster
          position="top-right"
          duration={4000}
          toastOptions={{
            style: {
              background: '#141414',
              border: '1px solid #1F1F1F',
              color: '#F5F5F5',
              fontSize: '14px',
            },
          }}
          theme="dark"
        />
        <AnimatePresence mode="wait">
          <Routes>
            <Route path="/login" element={<LoginRedirect />} />

            <Route
              path="/chat"
              element={
                <AuthRoute>
                  <Chat />
                </AuthRoute>
              }
            />

            <Route
              path="/admin"
              element={
                <SuperAdminRoute>
                  <AdminLayout />
                </SuperAdminRoute>
              }
            >
              <Route index element={<Dashboard />} />
              <Route path="organizations" element={<Organizations />} />
              <Route path="departments" element={<Departments />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="cross-org-groups" element={<CrossOrgGroups />} />
            </Route>

            <Route
              path="/org-admin"
              element={
                <OrgAdminRoute>
                  <OrgAdminLayout />
                </OrgAdminRoute>
              }
            >
              <Route index element={<OrgAdminDashboard />} />
              <Route path="users" element={<OrgAdminUsers />} />
              <Route path="departments" element={<OrgAdminDepartments />} />
              <Route path="settings" element={<OrgAdminSettings />} />
            </Route>

            <Route path="/settings" element={<AuthRoute><UserSettings /></AuthRoute>} />

            <Route path="/404" element={<NotFound />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AnimatePresence>
      </AuthProvider>
    </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
