import { useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import useCallStore from '../../stores/callStore';
import wsClient from '../../services/websocket';

/**
 * Owns the realtime socket for as long as there is a session.
 *
 * WHY THIS MOVED OUT OF Chat.jsx
 *
 * The connect/disconnect pair used to live in the /chat page, so the socket's
 * lifetime was the ROUTE's lifetime rather than the SESSION's. Leaving /chat
 * called disconnect(), which sets _intentionalClose and _active = false, and
 * _scheduleReconnect bails on both — so nothing ever reconnected. connect() was
 * called from exactly one place in the app, that same page, meaning a user who
 * navigated away was silently offline: no incoming messages, no incoming call
 * ringing, no presence, until they happened to return to /chat.
 *
 * That was survivable while leaving chat was a rare, buried action. It stopped
 * being survivable when the admin panel got a persistent switcher tab, because
 * an org admin now sits in /org-admin for long stretches and would miss calls
 * with no indication anything was wrong.
 *
 * Mounted in App.jsx beside the call overlays, outside <Routes>, for the same
 * reason they are: this has to outlive any single route.
 *
 * Renders nothing. connect() is idempotent — it early-returns while the socket
 * is CONNECTING or OPEN — so a remount cannot produce a second connection.
 */
export const RealtimeSession = () => {
  const { user } = useAuth();
  // Keyed on the id, not the object: checkAuth() mints a new user object on
  // every profile refresh, which would otherwise cycle the socket needlessly.
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return undefined;
    wsClient.connect();
    return () => {
      // Still never tear the socket down while a call is live. This cleanup now
      // fires on LOGOUT rather than on leaving a route, but the guard is kept:
      // a session ending under an active call should not strand LiveKit media
      // with its signalling gone — the hang-up has to be able to get out.
      if (useCallStore.getState().callState === 'idle') {
        wsClient.disconnect();
      }
    };
  }, [userId]);

  return null;
};

export default RealtimeSession;
