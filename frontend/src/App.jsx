import { Suspense, lazy, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { AnimatePresence } from 'framer-motion';
import { Loader2 } from 'lucide-react';

// Eager: the login screen, which is what an unauthenticated visitor is here for.
import Login from './pages/Login';
// Eager too, for a different reason: it renders OUTSIDE <Routes> and therefore
// outside the Suspense boundary there, so a lazy import would have nothing to
// suspend into. It is one small form.
import ForcedPasswordChange from './pages/ForcedPasswordChange';

// Lazy: the admin & org-admin portals load only when their routes are hit,
// keeping the messenger's initial bundle lean. Chat joined them for a sharper
// reason: it is the whole messenger, and a visitor sitting on the login form has
// not asked for any of it. Imported eagerly it put 687 kB — the virtualised
// thread, the media editor, the emoji dataset — in front of a two-field form.
// The route below already renders inside the Suspense boundary at the top of
// <Routes>, so this needs nothing else.
//
// Note for anyone tempted by build.rollupOptions.output.manualChunks instead:
// it was measured and it moves 0.92 kB of gzip. Splitting a STATIC import into
// its own file makes Vite emit <link rel="modulepreload"> for it, so the bytes
// are still fetched before first paint — the entry chunk shrinks and the login
// path does not. Only making the import dynamic removes it.
const Chat = lazy(() => import('./pages/Chat'));
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
import { CallConnectivityWatcher } from './components/calls/CallConnectivityWatcher';
import { RealtimeSession } from './components/shared/RealtimeSession';
import { ActiveCallView } from './components/calls/ActiveCallView';
import useCallStore, { hasLiveCall } from './stores/callStore';
import wsClient from './services/websocket';
import livekitClient from './services/livekitLazy';
import callSounds from './services/callSounds';

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

/**
 * Hang up whatever call this tab is in, ahead of the forced password change.
 *
 * The Room is a module singleton in services/livekitClient.js, not something any
 * component owns, so taking the call UI off screen does not take the call down
 * with it. Gating the session over a live call would leave the microphone
 * published to the other side with no hang-up button anywhere on screen.
 *
 * The hang-up frame goes out only over a socket that is open right now. send()
 * reconnects when handed a call frame for a closed socket — the right reaction
 * when a user presses a button, and exactly the wrong one here, where the server
 * has just refused this account. After a 4403 close it therefore never leaves,
 * and the server ends the call for the other side when its reconnect grace
 * window (or, for a call still ringing, the ring timeout) runs out.
 *
 * Every state that is not idle is reset, the two-second 'ended' window included:
 * RealtimeSession's cleanup only drops the socket when the call store is idle,
 * so anything else would leave it connected behind the forced screen.
 */
function endCallForPasswordChange() {
  const call = useCallStore.getState();
  if (call.callState === 'idle') return;
  callSounds.stopAll();
  livekitClient.leave();
  if (hasLiveCall(call) && call.callId && wsClient.isOpen()) {
    // The same frame each state's own button sends: Cancel while it rings out,
    // Decline while it rings in, Hang up once it is up.
    const type = call.callState === 'outgoing_ringing' ? 'call:cancel'
      : call.callState === 'incoming_ringing' ? 'call:decline'
        : 'call:end';
    wsClient.send({ type, call_id: call.callId });
  }
  call.resetCall();
}

/**
 * The forced password change, batch 73.
 *
 * An admin reset leaves the account on a temporary password the admin has seen,
 * so the API refuses it everywhere until its owner chooses a new one. This is
 * the client's half: while `user.must_change_password` is set — from the login
 * or /me payload, or because a request or the socket was refused for it — the
 * whole session below is UNMOUNTED and only the change-password screen renders.
 *
 * Unmounting rather than teaching each piece to stand down is the point.
 * RealtimeSession's cleanup already disconnects the socket, and its push heal is
 * cancelled the same way; the call overlays, <Routes> and every page under them
 * cannot fetch a conversation list, an avatar or an active call if they are not
 * there. Nothing new has to remember the flag. Toaster and OfflineBanner sit
 * outside, because neither talks to the API and the screen needs the first.
 *
 * A call in progress holds the session up for the one render it takes the
 * effect to end it. The order matters: the call has to be idle BEFORE
 * RealtimeSession unmounts, or its cleanup keeps the socket for the call's sake.
 */
const PasswordChangeGate = ({ children }) => {
  const { user } = useAuth();
  const required = Boolean(user?.must_change_password);
  const callInProgress = useCallStore((s) => s.callState !== 'idle');

  useEffect(() => {
    if (required && callInProgress) endCallForPasswordChange();
  }, [required, callInProgress]);

  if (!required || callInProgress) return children;
  return <ForcedPasswordChange />;
};

function App() {
  return (
    <ErrorBoundary>
    <BrowserRouter>
      <AuthProvider>
        <OfflineBanner />
        <PasswordChangeGate>
        {/* Realtime socket, scoped to the SESSION rather than to /chat. It lived
            inside the chat page, so navigating anywhere else disconnected it
            with no path back — see RealtimeSession for the full account. Sits
            with the call overlays because it has the same requirement: outlive
            every route. */}
        <RealtimeSession />
        <IncomingCallOverlay />
        <OutgoingCallScreen />
        <ActiveCallView />
        <MinimizedCallBanner />
        {/* Remote call audio. Mounted here, outside every route and every
            call-UI visibility gate, because it used to live inside
            ActiveCallView — which returns null when the call is minimised, so
            minimising silenced the other party while LiveKit kept streaming. */}
        <CallAudioSink />
        {/* Poor-connection and reconnecting messages. Mounted alongside
            CallAudioSink and for the same reason: a connectivity warning is most
            useful precisely when the call is MINIMISED and the user is doing
            something else, so it cannot live inside a call view. */}
        <CallConnectivityWatcher />
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
        </PasswordChangeGate>
        {/* Toasts are confirmations, not reading material: they clear quickly and
            can always be dismissed outright. Rapid toggles (mute/unmute) used to
            stack and cover the content underneath, so cap how many show at once.
            Outside the password gate, so the forced screen can toast and a toast
            already showing survives the gate opening or closing (a remounted
            Toaster drops what was on screen). */}
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
      </AuthProvider>
    </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
