// Alphabet kept exactly as the two hand-rolled copies had it, so generated
// passwords keep satisfying the backend policy (>= 10 chars, letters and digits).
// Split into its classes because meeting the letters-and-digits half of that
// policy means *guaranteeing* one of each, not drawing uniformly and hoping: at
// 12 characters from the flat 67-character alphabet, 14% of draws contain no
// digit at all — (57/67)^12 — and enforce_password_policy rejects every one of
// them, so roughly one in seven auto-generated passwords failed user creation
// with "Password must contain both letters and numbers". A missing letter is
// (15/67)^12, about one in 60 million, but is reserved for too since the
// guarantee costs the same either way.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';
const SYMBOLS = '!@#$%';
const CHARS = LETTERS + DIGITS + SYMBOLS;

// The longest password worth generating. bcrypt ignores everything past 72 bytes,
// so enforce_password_policy rejects rather than silently truncates there
// (BCRYPT_MAX_PASSWORD_BYTES, backend/app/core/security.py) — a longer value would
// be refused on submit exactly like the missing-digit case above. Every character
// in the alphabet is single-byte ASCII, so a character count is a byte count and
// the frontend limit is the same number as the backend's.
const MAX_LEN = 72;

// Bytes come from the CSPRNG in blocks rather than one getRandomValues call per
// character, because every draw below can reject and redraw.
function byteReader() {
  const block = new Uint8Array(32);
  let next = block.length;
  return () => {
    if (next >= block.length) {
      crypto.getRandomValues(block);
      next = 0;
    }
    return block[next++];
  };
}

/**
 * Uniform integer in [0, n) for n <= 256, from the platform CSPRNG.
 *
 * `byte % n` on its own is not uniform. For n = 67 the largest whole multiple of
 * the alphabet inside a byte is 201, exactly 67 x 3, so folding all 256 values in
 * with % hands the first 55 characters four byte values each and the last 12 only
 * three — a 33% edge. Bytes at or above that multiple are therefore rejected and
 * redrawn, which leaves every value exactly three and makes the draw uniform by
 * construction rather than merely close. The same rule covers the smaller ranges
 * used for the reserved characters and the shuffle below, where the bias would be
 * larger still: n = 10 splits 256 into 25 slots for six digits and 26 for four.
 *
 * The n <= 256 bound is checked rather than assumed, because exceeding it does not
 * degrade the draw, it hangs the thread: for n > 256, `256 % n` is 256 and `limit`
 * is 0, so `b >= limit` holds for every possible byte and the redraw loop below
 * never terminates. One byte cannot address more than 256 values; a wider range
 * needs a wider draw, not a wider argument.
 */
function uniform(nextByte, n) {
  if (!Number.isInteger(n) || n < 1 || n > 256) {
    throw new RangeError(`uniform: n must be an integer in 1..256, got ${n}`);
  }
  const limit = 256 - (256 % n);
  let b;
  do {
    b = nextByte();
  } while (b >= limit);
  return b % n;
}

/**
 * A password for a real account, from the platform CSPRNG.
 *
 * This existed twice — `generatePassword` in pages/admin/Users.jsx and
 * `genPassword` in pages/OrgAdmin/OrgAdminUsers.jsx — and both drew from
 * Math.random(). That is a seeded PRNG whose internal state is recoverable from
 * a modest run of outputs, so an admin who observes a few generated passwords
 * can predict the ones minted next, including for accounts that are not theirs.
 * The generated value is the credential the new user is handed to sign in with.
 *
 * Always contains at least one letter and one digit, so the result is accepted by
 * enforce_password_policy for any `len` in range. Two characters is the floor at
 * which that guarantee is expressible at all, and a shorter password could not
 * satisfy the policy's length rule regardless, so a smaller `len` is a caller bug
 * rather than something to silently round up. MAX_LEN is the ceiling for the same
 * reason in the other direction: past it the backend refuses the value, so
 * returning one would hand back a credential that cannot be used.
 */
export function generatePassword(len = 12) {
  if (!Number.isInteger(len) || len < 2 || len > MAX_LEN) {
    throw new RangeError(`generatePassword: len must be an integer between 2 and ${MAX_LEN}`);
  }
  const nextByte = byteReader();
  const out = [
    LETTERS[uniform(nextByte, LETTERS.length)],
    DIGITS[uniform(nextByte, DIGITS.length)],
  ];
  while (out.length < len) out.push(CHARS[uniform(nextByte, CHARS.length)]);

  // Fisher-Yates, from the same CSPRNG. Without it the reserved pair stays pinned
  // to positions 0 and 1, which leaks that every generated password begins with a
  // letter followed by a digit and narrows a guess against the remaining len - 2.
  for (let i = out.length - 1; i > 0; i--) {
    const j = uniform(nextByte, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

export default generatePassword;
