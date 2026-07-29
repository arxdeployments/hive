import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import client from '../api/client';

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
    localStorage.setItem('user', JSON.stringify(data.user));
    setUser(data.user);
    return data.user;
  };

  const logout = async () => {
    try {
      await client.post('/api/auth/logout');
    } catch (err) {
      // ignore — cookies are cleared server-side; local state resets regardless
    }
    localStorage.removeItem('user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
};
