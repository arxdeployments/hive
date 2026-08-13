import { expect, test } from '@playwright/test';

/**
 * The API answers errors in three shapes and a caller cannot tell which one it
 * is about to get.
 *
 * `HTTPException` serialises to `{"detail": "<sentence>"}`; a request that fails
 * pydantic validation serialises to `{"detail": [{loc, msg, type}, ...]}` — a
 * LIST, not a sentence; and a handful of routes answer `{"message": ...}`.
 *
 * Thirty-six call sites wrote `err.response?.data?.detail || 'fallback'` by
 * hand, which handles only the first. An array is truthy, so `||` does not fall
 * through and the ARRAY reaches toast.error(). sonner renders whatever it is
 * handed straight into the tree, React throws "Objects are not valid as a React
 * child", and because <Toaster> is mounted above the router — a sibling of
 * <Routes> inside the single top-level ErrorBoundary — the throw took the whole
 * SPA down to "Something went wrong. Please reload the page."
 *
 * A one-character display name in the admin user editor was enough to do it.
 *
 * Driven against the real module rather than a copy: this is a pure function, so
 * the honest test is the function, and the repo already imports `/src/...` off
 * the Vite dev server this way (see livekit-local-media.spec.js).
 */

const BLANK = '/e2e-api-error-shape';

test.describe('apiError', () => {
  test.beforeEach(async ({ page }) => {
    await page.route(`**${BLANK}`, (route) =>
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>apiError</title>' })
    );
    await page.goto(BLANK);
  });

  test('collapses every error shape to a renderable string', async ({ page }) => {
    const seen = await page.evaluate(async () => {
      const { apiError } = await import('/src/utils/helpers.js');
      const call = (data) => apiError({ response: { data } }, 'FALLBACK');
      return {
        // The shape every hand-written call site already handled.
        sentence: call({ detail: 'Email already registered' }),
        // The shape that took the app down. FastAPI's 422 body, verbatim.
        validation: call({
          detail: [{
            loc: ['body', 'display_name'],
            msg: 'String should have at least 2 characters',
            type: 'string_too_short',
          }],
        }),
        // The third shape, which nothing handled.
        message: call({ message: 'Upload too large' }),
        // Degenerate bodies must reach the caller's own copy, not crash.
        emptyDetail: call({ detail: '' }),
        objectDetail: call({ detail: { nested: 'thing' } }),
        emptyArray: call({ detail: [] }),
        arrayNoMsg: call({ detail: [{ loc: ['body'], type: 'x' }] }),
        nullBody: call(null),
        noResponse: apiError(new Error('network down'), 'FALLBACK'),
        // Every return value's type, which is the property that matters: this
        // function can only hand toast.error() a string.
        allStrings: [
          call({ detail: 'x' }),
          call({ detail: [{ msg: 'y' }] }),
          call({ message: 'z' }),
          call({ detail: [] }),
          call(null),
        ].every((v) => typeof v === 'string'),
      };
    });

    expect(seen.sentence).toBe('Email already registered');
    // The regression itself: a readable sentence out of the validation list,
    // never the list. `msg` is the half meant for people; loc and type are for
    // programs.
    expect(seen.validation).toBe('String should have at least 2 characters');
    expect(seen.message).toBe('Upload too large');

    // Anything that is not a non-empty string falls through to the caller's copy.
    expect(seen.emptyDetail).toBe('FALLBACK');
    expect(seen.objectDetail).toBe('FALLBACK');
    expect(seen.emptyArray).toBe('FALLBACK');
    expect(seen.arrayNoMsg).toBe('FALLBACK');
    expect(seen.nullBody).toBe('FALLBACK');
    expect(seen.noResponse).toBe('FALLBACK');

    expect(seen.allStrings, 'apiError returned a non-string, which is what crashed the SPA').toBe(true);
  });
});
