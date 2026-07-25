import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.E2E_WEB_PORT || 5173);
const API_URL = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const BASE_URL = process.env.E2E_BASE_URL || `http://127.0.0.1:${WEB_PORT}`;

// When E2E_NO_SERVER=1 the suite runs against an already-running stack
// (fast local loop). Otherwise Playwright boots the web server itself and
// waits for the API to be healthy, so a half-up stack fails loudly at startup
// instead of surfacing as mysterious locator timeouts mid-run.
const webServer = process.env.E2E_NO_SERVER
  ? undefined
  : [
      {
        command: `npm run dev -- --port ${WEB_PORT} --host 127.0.0.1`,
        url: BASE_URL,
        reuseExistingServer: true,
        timeout: 60000,
      },
    ];

export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  globalSetup: './tests/global-setup.js',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    actionTimeout: 15000,
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: [
        // Synthetic camera/mic so calls can be exercised without hardware,
        // and auto-granted permission prompts so nothing blocks on a dialog.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  metadata: { apiUrl: API_URL },
  webServer,
});
