import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import client, { setSignOutReason } from '../api/client';
import useChatStore from '../stores/chatStore';
import { tearDownPush } from '../lib/pushTeardown';

/**
 * Both sign-outs that stay inside the SPA end up here.
 *
 * The third one does not need it: api/client.js tears an expired session down
 * with `window.location.href`, and a document navigation takes the heap with it.
 * These two are React Router transitions, so the previous user's threads and
 * message bodies would otherwise still be in memory when the next person signs
 * in on the same tab. Call it before setUser(null), so nothing renders from the
 * old data on the frame the route guard redirects.
 */
const dropSessionData = () => {
  useChatStore.getState().reset();
};

const AuthContext = createContext(null);

/**
 * The localStorage mirror of /api/auth/me. It exists only to survive a boot where
 * the server could not be reached; the httpOnly cookies, not this, decide whether
 * the session is real, and every request still proves that against the API.
 */
const cachedUser = () => {
  try {
    return JSON.parse(localStorage.getItem('user') || 'null');
  } catch {
    return null;
  }
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const checkAuth = useCallback(async () => {
    try {
      // Session lives in httpOnly cookies; /me is the source of truth.
      const { data } = await client.get('/api/auth/me');
      setUser(data);
      localStorage.setItem('user', JSON.stringify(data));
    } catch (err) {
      // Tell "the server says this session is finished" apart from "we could not
      // ask". Every failure used to clear the cache and drop to the login screen,
      // so a boot with no network signed out a user whose cookies were still
      // good. client.js has already tried refresh-and-replay by the time we get
      // here, so a 401/403 is terminal; anything else is a transport failure and
      // the cached user stands until a request can actually reach the server.
      const status = err.response?.status;
      if (status === 401 || status === 403) {
        localStorage.removeItem('user');
        dropSessionData();
        // Same reason as logout(), minus the API call: this session is already
        // refused, so a DELETE would 401 and re-enter the refresh interceptor for
        // a session that is over. Unsubscribing the browser is the half that
        // stops delivery anyway — the abandoned endpoint then answers 404/410 and
        // services/push.py prunes the row on the next send.
        await tearDownPush({ nav: navigator, storage: localStorage });
        // This path is a SOFT sign-out — the route guards render
        // <Navigate to="/login">, a React transition rather than a document
        // navigation — so unlike client.js the message could have lived in
        // state. It uses the same channel anyway so there is one way to say
        // this, and so Login needs only one reader.
        setSignOutReason('expired');
        setUser(null);
      } else {
        setUser(cachedUser());
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = async (email, password) => {
    const { data } = await client.post('/api/auth/login', { email, password });
    // Belt as well as braces. Signing out clears this, so by here it is normally
    // already empty — but that makes the guarantee "every sign-out remembered to
    // clean up", and this makes it "a session always starts empty", which does
    // not depend on having found every way a session can end.
    dropSessionData();
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    // Before the logout POST, not after: DELETE /api/notifications/subscribe
    // authenticates as this user, and the POST below is what clears the cookies
    // it needs. Awaited rather than fired off, because the whole point is that it
    // finishes while the session still exists.
    //
    // Without this the browser stayed subscribed and the push_subscriptions row
    // stayed bound to the user signing out, so every message sent to them went on
    // arriving as an OS notification on this machine — sender's name in the title
    // and 120 characters of the message body (services/messaging.py:_push_preview)
    // — to whoever used it next, on the lock screen included. The heap teardown
    // below never covered it: a push notification is delivered by the service
    // worker, which outlives the tab.
    await tearDownPush({ nav: navigator, api: client, storage: localStorage });
    try {
      await client.post('/api/auth/logout');
    } catch {
      // ignore — cookies are cleared server-side; local state resets regardless
    }
    localStorage.removeItem('user');
    dropSessionData();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
};
