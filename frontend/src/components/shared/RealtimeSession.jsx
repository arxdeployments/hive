import { useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import useCallStore from '../../stores/callStore';
import wsClient from '../../services/websocket';
import { healPushSubscription } from '../../lib/pwa';

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

  /**
   * Put back a push subscription this user asked for and no longer has.
   *
   * Here rather than in a page for the same reason the socket is: it belongs to
   * the SESSION. And it has to be somewhere, because nothing re-subscribed
   * anywhere — pushManager.subscribe() had two call sites and both were a person
   * clicking something, public/sw.js has no `pushsubscriptionchange` handler, and
   * browsers rotate and expire subscriptions on their own.
   *
   * Batch 38 made that a certainty rather than a possibility: signing out now
   * revokes the subscription on purpose, so somebody who explicitly enabled push
   * lost it at the end of every shift and silently never got it back.
   *
   * Deliberately its own effect, not folded into the socket one below: this must
   * not run again on a reconnect, and it must not be able to delay
   * wsClient.connect(). healPushSubscription never throws, never prompts, and
   * returns false without doing anything unless the user's stored preference is
   * an explicit yes and the OS permission is already granted.
   */
  useEffect(() => {
    if (!userId) return;
    healPushSubscription();
  }, [userId]);

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
