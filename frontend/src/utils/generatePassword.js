// Alphabet kept exactly as the two hand-rolled copies had it, so generated
// passwords keep satisfying the backend policy (>= 10 chars, letters and digits).
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';

// Largest whole multiple of the alphabet inside a byte: 201, which is exactly
// 67 x 3. Bytes at or above it are rejected and redrawn rather than folded in
// with %, which would hand the first 55 characters four byte values each and the
// last 12 only three — a 33% edge. Rejecting leaves every character with exactly
// three, so the draw is uniform by construction, not merely close.
const LIMIT = 256 - (256 % CHARS.length);

/**
 * A password for a real account, from the platform CSPRNG.
 *
 * This existed twice — `generatePassword` in pages/admin/Users.jsx and
 * `genPassword` in pages/OrgAdmin/OrgAdminUsers.jsx — and both drew from
 * Math.random(). That is a seeded PRNG whose internal state is recoverable from
 * a modest run of outputs, so an admin who observes a few generated passwords
 * can predict the ones minted next, including for accounts that are not theirs.
 * The generated value is the credential the new user is handed to sign in with.
 */
export function generatePassword(len = 12) {
  const out = [];
  const buf = new Uint8Array(len);
  while (out.length < len) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < LIMIT && out.length < len) out.push(CHARS[b % CHARS.length]);
    }
  }
  return out.join('');
}

export default generatePassword;
