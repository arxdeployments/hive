/**
 * Bound an await that can hang rather than fail.
 *
 * Extracted from pushTeardown.js so the restore path shares it instead of
 * carrying a second copy — the push lifecycle has three of these hazards and
 * they all want the same answer:
 *
 *   - `navigator.serviceWorker.ready` is a PERMANENTLY PENDING promise when no
 *     worker is registered, not a rejected one, and registration is what fails
 *     behind a proxy serving /sw.js as the wrong content type — where
 *     registerServiceWorker() only console.warns.
 *   - the axios instance in api/client.js sets no `timeout`, and axios defaults
 *     to 0, meaning never. A black-holed API leaves a request pending for as
 *     long as the socket lives.
 *   - `pushManager.subscribe()` talks to the push service over the network.
 *
 * Resolves `undefined` on expiry rather than rejecting, so callers distinguish
 * "gave up" from "failed" by checking the value. Callers that need to tell a
 * timeout from a legitimate `undefined` should resolve their promise through
 * `.then(() => true)` and test for that.
 */
export async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
