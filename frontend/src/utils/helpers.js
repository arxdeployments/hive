/**
 * Collapse a FastAPI error body down to one string that is safe to render.
 *
 * The API answers in three different shapes and a caller cannot tell which one
 * it is about to get. `HTTPException` serialises to `{"detail": "<sentence>"}`;
 * a request that fails pydantic validation serialises to `{"detail": [{loc,
 * msg, type}, ...]}` — a LIST, not a sentence; and a handful of routes answer
 * `{"message": ...}` instead. The naive `err.response?.data?.detail || 'X'`
 * that used to be written out at every call site handles only the first: an
 * array is truthy, so `||` does not fall through, and the array itself reaches
 * toast.error(). sonner renders whatever it is handed straight into the tree,
 * so React throws "Objects are not valid as a React child" from inside
 * <Toaster> — which is mounted above the router, so the throw takes the whole
 * SPA down to the top-level error boundary. A one-character display name in the
 * admin user editor was enough to do it.
 *
 * Every branch is type-checked before it is returned, including `message`:
 * anything that is not a non-empty string falls through to the caller's own
 * fallback copy, so this function can only ever return a string and the crash
 * has nowhere left to come from. The array branch takes the first entry's
 * `msg`, which is the readable half of a validation error ("String should have
 * at least 2 characters"); `loc` and `type` are for programs, not people.
 */
export const apiError = (err, fallback) => {
  const d = err?.response?.data;
  return (
    (typeof d?.detail === 'string' && d.detail) ||
    (Array.isArray(d?.detail) && typeof d.detail[0]?.msg === 'string' && d.detail[0].msg) ||
    (typeof d?.message === 'string' && d.message) ||
    fallback
  );
};

// Format relative timestamps
export const formatRelativeTime = (dateStr) => {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (diffSec < 30) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (msgDate.getTime() === today.getTime()) {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (msgDate.getTime() === yesterday.getTime()) return 'Yesterday';
  if (diffDay < 7) return d.toLocaleDateString('en-US', { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// HTML-escape untrusted text before it goes into markup.
const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// Detect and linkify URLs in text. Output is HTML — every interpolated value
// (both the link and surrounding text) is escaped so message content can never
// inject markup, even if it reached here unsanitized. Only http(s) links are
// produced, so javascript:/data: URLs can't become clickable.
export const linkifyText = (text) => {
  if (!text) return text;
  const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!])/gi;
  const parts = text.split(urlRegex);
  if (parts.length === 1) return escapeHtml(text);

  return parts
    .map((part) => {
      if (urlRegex.test(part)) {
        urlRegex.lastIndex = 0;
        const safe = escapeHtml(part);
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="text-[#10B981] hover:underline">${safe}</a>`;
      }
      return escapeHtml(part);
    })
    .join('');
};

// Check if text contains URLs
export const hasUrls = (text) => {
  if (!text) return false;
  return /(https?:\/\/[^\s<]+)/gi.test(text);
};
