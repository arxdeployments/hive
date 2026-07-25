// Fail fast and loudly if the API side of the stack isn't actually up.
// Without this, a dead API shows up as unexplained locator timeouts deep in a
// test — which is precisely how this suite misled us once already.
const API = process.env.E2E_API_URL || 'http://127.0.0.1:8000';
const DEADLINE_MS = 30000;

export default async function globalSetup() {
  const started = Date.now();
  let lastError = 'no response';

  while (Date.now() - started < DEADLINE_MS) {
    try {
      const resp = await fetch(`${API}/api/health`);
      const body = await resp.json();
      if (resp.ok && body.status === 'healthy') {
        console.log(
          `[e2e] API healthy at ${API} ` +
            `(db=${body.database}, redis=${body.redis}, livekit=${body.livekit ?? 'not reported'})`
        );
        // Not fatal — only the calling specs need the SFU, and they skip
        // themselves. But say it once here so a whole skipped call suite is
        // never mistaken for a passing one.
        if (body.livekit && body.livekit !== 'connected') {
          console.warn(
            `[e2e] LiveKit is ${body.livekit} — calling tests will skip. Start it with:\n` +
              `  LIVEKIT_KEYS="devkey: devsecret-at-least-32-characters-long" livekit-server --dev`
          );
        }
        return;
      }
      lastError = `status=${resp.status} body=${JSON.stringify(body)}`;
    } catch (err) {
      lastError = err.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error(
    `[e2e] API at ${API} is not healthy after ${DEADLINE_MS / 1000}s (${lastError}).\n` +
      `Start the stack first:\n` +
      `  docker compose -f infra/docker-compose.yml up -d\n` +
      `or run the backend directly (needs Postgres, Redis, MinIO):\n` +
      `  cd backend && .venv/bin/uvicorn app.main:app`
  );
}
