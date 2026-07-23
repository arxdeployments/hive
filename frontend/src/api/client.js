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
