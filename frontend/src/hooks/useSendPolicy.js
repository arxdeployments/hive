import { useCallback, useEffect, useState } from 'react';
import client from '../api/client';

/**
 * What this user is allowed to send, for driving the composer.
 *
 * A RENDERING HINT, NOT A CONTROL. The server checks every send at claim time,
 * and it has to: `accept` on a file input is advisory, drag-and-drop and paste
 * ignore it completely, and three different clients consume these endpoints.
 * Everything here exists so a restricted user sees a greyed-out option instead
 * of picking a file and getting a rejection toast.
 *
 * Fails OPEN on purpose. If the fetch errors we return the permissive default,
 * so a blip in this request degrades the UI to "offer everything" rather than
 * "offer nothing" — and the server still refuses whatever is not allowed. The
 * opposite choice would let one failed request make the app look broken.
 *
 * Re-fetches on `rxhive:access-changed`, the event the socket raises when an
 * administrator edits a rule or policy affecting this user.
 */

export const PERMISSIVE = {
  text: true,
  image: true,
  video: true,
  audio: true,
  document: true,
  doc_extensions: null,
  allowed_extensions: null, // null = "no restriction known", not "nothing allowed"
  source: 'default',
};

export function useSendPolicy() {
  const [policy, setPolicy] = useState(PERMISSIVE);

  const load = useCallback(async () => {
    try {
      const { data } = await client.get('/api/users/me/send-policy');
      setPolicy(data || PERMISSIVE);
    } catch {
      setPolicy(PERMISSIVE);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onChanged = () => load();
    window.addEventListener('rxhive:access-changed', onChanged);
    return () => window.removeEventListener('rxhive:access-changed', onChanged);
  }, [load]);

  return policy;
}

/**
 * Build an `accept` string from the policy, falling back to the caller's own
 * default when the policy places no restriction.
 *
 * The fallback matters: these lists are duplicated in four places
 * (services/storage.py, this frontend, the iOS composer, and
 * utils/audioFormat.js), and a policy-driven `accept` that silently returned ""
 * when unrestricted would widen the picker rather than leave it alone.
 */
export function acceptFor(policy, category, fallback) {
  const allowed = policy?.allowed_extensions;
  if (!Array.isArray(allowed)) return fallback;
  const byCategory = {
    image: (e) => ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(e),
    video: (e) => ['.mp4', '.mov', '.webm', '.m4v'].includes(e),
    audio: (e) => ['.mp3', '.m4a', '.wav', '.ogg', '.aac', '.opus', '.weba'].includes(e),
    document: (e) =>
      !['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.webm', '.m4v',
        '.mp3', '.m4a', '.wav', '.ogg', '.aac', '.opus', '.weba'].includes(e),
  };
  const picked = allowed.filter(byCategory[category] || (() => false));
  return picked.length ? picked.join(',') : fallback;
}

/** True when a file the user picked by drag or paste is not permitted. */
export function isBlockedFile(policy, file) {
  const allowed = policy?.allowed_extensions;
  if (!Array.isArray(allowed)) return false;
  const name = file?.name || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) return true; // no extension: storage.classify would reject it anyway
  return !allowed.includes(name.slice(dot).toLowerCase());
}
