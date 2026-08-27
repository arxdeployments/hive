/**
 * The single axios instance every screen talks to, and the 401 refresh-and-replay
 * that keeps a cookie session alive.
 *
 * Changes vs the previous build (both were logging out working sessions):
 * - The refresh was skipped for every URL containing '/api/auth/', which caught
 *   /api/auth/me. AuthContext calls /me on every mount, so a reload more than 15
 *   minutes (the access-cookie lifetime) after the last activity 401'd, was
 *   never refreshed, and threw away a refresh cookie good for another 29 days.
 *   Only the endpoints whose 401 means "wrong credentials" are excluded now.
 * - A refresh that never reached the server used to clear the stored user and
 *   hard-redirect to /login. Being offline, a timeout, a proxy 502 mid-deploy, a
 *   429 from the shared-IP limiter and a 500 while Redis is down all leave the
 *   cookies intact; only the auth server rejecting the refresh cookie ends the
 *   session, so only that signs the user out.
 */
import axios from 'axios';
import { tearDownPush } from '../lib/pushTeardown';

const API_BASE = import.meta.env.VITE_BACKEND_URL || '';

// Auth rides in httpOnly cookies — no tokens in JS, nothing in localStorage.
// X-Requested-With doubles as the CSRF header the API requires on mutations.
const client = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
  },
});

// Request interceptor — never let the JSON default above ride on a FormData body.
//
// axios 1.x transformRequest does:
//     return hasJSONContentType ? JSON.stringify(formDataToJSON(data)) : data;
// (axios 1.18.1, dist line 1512). Because this instance sets Content-Type:
// application/json as a DEFAULT ON EVERY REQUEST, any FormData body was being
// serialised into JSON before it left the browser — the File never became a
// multipart part, so FastAPI's File(None) resolved to None and /api/upload
// answered 400 "No file provided" for every attachment and every avatar.
//
// Clearing the header here (interceptors run before transformRequest) makes
// hasJSONContentType false, so the FormData passes through untouched; the xhr
// adapter then sets multipart/form-data itself, with the boundary that only the
// browser can generate. Doing it centrally means a new upload call site cannot
// reintroduce the bug by forgetting a per-request header override.
client.interceptors.request.use((config) => {
  if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
    // config.headers is an AxiosHeaders instance in axios 1.x (case-insensitive
    // .delete); the plain-object branch is a guard for older/mocked shapes.
    if (typeof config.headers?.delete === 'function') {
      config.headers.delete('Content-Type');
    } else if (config.headers) {
      delete config.headers['Content-Type'];
    }
  }
  return config;
});

// Response interceptor — on 401, refresh the cookie session once (single-flight)
// and replay the failed requests.
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error) => {
  failedQueue.forEach((prom) => (error ? prom.reject(error) : prom.resolve()));
  failedQueue = [];
};

// The only endpoints where 401 answers the question that was asked instead of
// reporting a stale access cookie: /login and /refresh reject the credentials
// presented, and /change-password reports an incorrect current password (backend
// auth.py change_password). Refreshing in response to those would loop or bury
// the real error. /me and /logout are ordinary protected endpoints — they must
// refresh and replay like anything else, whatever their path prefix suggests.
const CREDENTIAL_401_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/change-password',
]);

// Classify on the pathname alone. Substring-matching the whole URL let a query
// string decide the outcome, so '/api/reports?next=/api/auth/login' would have
// been read as a credential check and denied the refresh it needed.
const pathnameOf = (url) => {
  try {
    return new URL(url ?? '', window.location.origin).pathname;
  } catch {
    return '';
  }
};

// Only the auth server rejecting the refresh cookie proves the session is over.
// A refresh that was never DELIVERED — no response at all, a 5xx, a 429 — says
// nothing about the cookies, so the user stays signed in and the request that
// triggered all this surfaces its own error to the screen that made it.
export const sessionRejected = (refreshError) => {
  const status = refreshError?.response?.status;
  return status === 401 || status === 403;
};

// Bumped on every successful refresh. A request that was already ON THE WIRE
// when someone else refreshed comes back 401 against the cookie it was sent
// with — nothing is wrong with the session, it simply predates the rotation. The
// single-flight below only covers requests that 401 while isRefreshing is still
// true; one dispatched before the refresh and answered after it would see the
// flag already cleared and start a whole second rotation.
//
// That matters because the backend rotates refresh tokens single-use: every
// avoidable rotation is another chance to trip the reuse detection, which burns
// the entire session family. iOS calls this refreshGeneration (APIClient.swift).
let refreshGeneration = 0;

// Why the session ended, carried across the hard navigation to /login.
//
// The teardown below is `window.location.href = '/login'`, a full document
// navigation that destroys every in-memory value and any toast already on
// screen — so a React state message cannot survive it and sessionStorage is the
// only channel that can. Without this the user lands on a blank form with no
// idea whether they were signed out, timed out, or the app broke.
export const SIGNOUT_REASON_KEY = 'rxhive_signout_reason';

export const setSignOutReason = (reason) => {
  try { sessionStorage.setItem(SIGNOUT_REASON_KEY, reason); } catch { /* private mode */ }
};

/** Read once and clear, so a later manual visit to /login is not haunted by it. */
export const takeSignOutReason = () => {
  try {
    const v = sessionStorage.getItem(SIGNOUT_REASON_KEY);
    if (v) sessionStorage.removeItem(SIGNOUT_REASON_KEY);
    return v;
  } catch {
    return null;
  }
};

export const refreshSession = () =>
  axios.post(
    `${API_BASE}/api/auth/refresh`,
    {},
    { withCredentials: true, headers: { 'X-Requested-With': 'XMLHttpRequest' } }
  );

// Stamp the generation onto every outgoing request so a 401 can be compared
// against the generation in force when the response arrives.
client.interceptors.request.use((config) => {
  config._generation = refreshGeneration;
  return config;
});

/** Replay a request, marked so its own 401 cannot start another refresh. */
const replay = (config) => client({ ...config, _retry: true });

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const skipRefresh = CREDENTIAL_401_PATHS.has(pathnameOf(originalRequest?.url));

    if (error.response?.status === 401 && !originalRequest._retry && !skipRefresh) {
      // Somebody else refreshed while this was in flight, so the 401 is an
      // artefact of the old cookie rather than evidence about the session.
      // Replay it against the new one instead of rotating again.
      if (originalRequest._generation !== undefined && originalRequest._generation < refreshGeneration) {
        return replay(originalRequest);
      }

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
          // Followers replay through `replay`, which sets _retry. Previously
          // they called client(originalRequest) with the marker unset, so a
          // follower whose replay 401d again re-entered here as a WINNER and
          // fired a second refresh — a redundant rotation racing the first.
        }).then(() => replay(originalRequest));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        await refreshSession();
        refreshGeneration += 1;
        processQueue(null);
        return replay(originalRequest);
      } catch (refreshError) {
        // Drained before either branch: the queue is the only thing holding the
        // waiters' promises, and one left unsettled hangs the screen that made
        // the request for the life of the tab.
        processQueue(refreshError);
        if (sessionRejected(refreshError)) {
          localStorage.removeItem('user');
          // Awaited BEFORE the navigation, and bounded inside. A document
          // navigation kills pending JS, so an un-awaited unsubscribe here would
          // usually not finish — and the subscription surviving is what kept the
          // expired user's message previews arriving on this machine as OS
          // notifications. No `api`: this session has just been refused, so a
          // DELETE would 401 straight back into the branch we are standing in.
          await tearDownPush({ nav: navigator, storage: localStorage });
          setSignOutReason('expired');
          if (window.location.pathname !== '/login') {
            window.location.href = '/login';
          }
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default client;
