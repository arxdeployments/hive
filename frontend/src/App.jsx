import React, { Suspense, lazy } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AnimatePresence } from 'framer-motion';
import { Loader2 } from 'lucide-react';

// Eager: the two hot entry screens.
import Login from './pages/Login';
import Chat from './pages/Chat';

// Lazy: the admin & org-admin portals load only when their routes are hit,
// keeping the messenger's initial bundle lean.
const Dashboard = lazy(() => import('./pages/admin/Dashboard'));
const Organizations = lazy(() => import('./pages/admin/Organizations'));
const Departments = lazy(() => import('./pages/admin/Departments'));
const UsersPage = lazy(() => import('./pages/admin/Users'));
const SettingsPage = lazy(() => import('./pages/admin/Settings'));
const CrossOrgGroups = lazy(() => import('./pages/admin/CrossOrgGroups'));
const OrgAdminDashboard = lazy(() => import('./pages/OrgAdmin/OrgAdminDashboard'));
const OrgAdminUsers = lazy(() => import('./pages/OrgAdmin/OrgAdminUsers'));
const OrgAdminDepartments = lazy(() => import('./pages/OrgAdmin/OrgAdminDepartments'));
const OrgAdminSettings = lazy(() => import('./pages/OrgAdmin/OrgAdminSettings'));
const UserSettings = lazy(() => import('./pages/Settings'));
import NotFound from './pages/NotFound';

// Layout (part of the lazy admin surfaces)
const AdminLayout = lazy(() =>
  import('./components/layout/AdminLayout').then((m) => ({ default: m.AdminLayout }))
);
const OrgAdminLayout = lazy(() =>
  import('./components/org-admin/OrgAdminLayout').then((m) => ({ default: m.OrgAdminLayout }))
);

const RouteFallback = () => (
  <div className="min-h-screen bg-[#0A0A0A] flex items-center justify-center">
    <Loader2 className="w-8 h-8 text-[#10B981] animate-spin" />
  </div>
);

// Shared
import { ErrorBoundary } from './components/shared/ErrorBoundary';
import { OfflineBanner } from './components/shared/OfflineBanner';
import { IncomingCallOverlay } from './components/calls/IncomingCallOverlay';
import { OutgoingCallScreen } from './components/calls/OutgoingCallScreen';
import { MinimizedCallBanner } from './components/calls/MinimizedCallBanner';
import { CallAudioSink } from './components/calls/CallAudioSink';
import { RealtimeSession } from './components/shared/RealtimeSession';
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

/**
 * Landing route for "/".
 *
 * There was no "/" route at all, so the bare domain fell through to the "*"
 * catch-all and rendered NotFound — every visitor who typed rxhive.org got a 404
 * with a "Go to Chat" button as the only way out.
 *
 * Role routing mirrors LoginRedirect exactly (superadmin -> /admin, everyone
 * else -> /chat) so the two entry points can never disagree about where a given
 * user belongs. Unauthenticated visitors are sent to /login rather than being
 * rendered the login form in place, so the address bar matches what is on screen
 * and a refresh does not bounce them.
 */
const RootRedirect = () => {
  const { user, loading } = useAuth();
  if (loading) return <RouteFallback />;
  if (!user) return <Navigate to="/login" replace />;
  return user.role === 'superadmin'
    ? <Navigate to="/admin" replace />
    : <Navigate to="/chat" replace />;
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
        {/* Realtime socket, scoped to the SESSION rather than to /chat. It lived
            inside the chat page, so navigating anywhere else disconnected it
            with no path back — see RealtimeSession for the full account. Sits
            with the call overlays because it has the same requirement: outlive
            every route. */}
        <RealtimeSession />
        <OfflineBanner />
        <IncomingCallOverlay />
        <OutgoingCallScreen />
        <ActiveCallView />
        <MinimizedCallBanner />
        {/* Remote call audio. Mounted here, outside every route and every
            call-UI visibility gate, because it used to live inside
            ActiveCallView — which returns null when the call is minimised, so
            minimising silenced the other party while LiveKit kept streaming. */}
        <CallAudioSink />
        {/* Toasts are confirmations, not reading material: they clear quickly and
            can always be dismissed outright. Rapid toggles (mute/unmute) used to
            stack and cover the content underneath, so cap how many show at once. */}
        <Toaster
          position="top-right"
          duration={2000}
          closeButton
          visibleToasts={2}
          gap={8}
          toastOptions={{
            style: {
              background: '#141414',
              border: '1px solid #1F1F1F',
              color: '#F5F5F5',
              fontSize: '14px',
            },
            classNames: {
              closeButton: 'rxhive-toast-close',
            },
          }}
          theme="dark"
        />
        <AnimatePresence mode="wait">
          <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Bare domain. Must come before the "*" catch-all below, which was
                previously the only thing matching "/". */}
            <Route path="/" element={<RootRedirect />} />

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
          </Suspense>
        </AnimatePresence>
      </AuthProvider>
    </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
