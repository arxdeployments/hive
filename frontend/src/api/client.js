import axios from 'axios';

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

export const refreshSession = () =>
  axios.post(
    `${API_BASE}/api/auth/refresh`,
    {},
    { withCredentials: true, headers: { 'X-Requested-With': 'XMLHttpRequest' } }
  );

client.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    const isAuthPath = originalRequest?.url?.includes('/api/auth/');

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthPath) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => client(originalRequest));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        await refreshSession();
        processQueue(null);
        return client(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError);
        localStorage.removeItem('user');
        if (window.location.pathname !== '/login') {
          window.location.href = '/login';
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
