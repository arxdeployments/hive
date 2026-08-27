/**
 * The two notification preferences, read in one place.
 *
 * Settings.jsx stores these by assigning a boolean to localStorage, so the value
 * on disk is the string "true" or "false" — never "off". Four readers had grown
 * up around them in three different dialects: callSounds compared against
 * 'false', IncomingCallOverlay accepted either, and both readers in websocket.js
 * compared against 'off' alone. Those last two could therefore never be true, so
 * turning either toggle off in Settings did nothing at all: message tones kept
 * playing and desktop notifications kept appearing for every message.
 *
 * 'off' is still honoured so a profile written by an older build keeps working.
 */

const OFF_VALUES = new Set(['false', 'off']);
const ON_VALUES = new Set(['true', 'on']);

function isOff(key) {
  return isExplicitOff(localStorage.getItem(key));
}

/**
 * Pure, and exported so the distinctions here can be tested without a DOM.
 *
 * Note what isExplicitOn is NOT: the negation of isExplicitOff. An ABSENT value
 * is neither — off by the first test and on by the second — and that asymmetry is
 * the point. 'off' is the value where a raw `!== 'false'` comparison gets it
 * wrong, which is why callers must use these rather than compare strings: a
 * legacy profile storing 'off' read as ENABLED, and Settings then persisted
 * 'true' over it, silently re-enabling what the user had switched off.
 */
export function isExplicitOff(value) {
  return OFF_VALUES.has(value);
}

export function isExplicitOn(value) {
  return ON_VALUES.has(value);
}

/** True when the user has turned notification sounds off. */
export function isSoundMuted() {
  return isOff('rxhive_notif_sound');
}

/**
 * True when the user has turned desktop notifications off.
 *
 * Unset counts as ON, and that default is deliberate for THIS reader: it gates
 * whether an open tab may draw its own notification, which costs nothing and
 * needs no more than the OS permission the user has already granted.
 */
export function isDesktopNotifDisabled() {
  return isOff('rxhive_desktop_notif');
}

/**
 * True only when the user has EXPLICITLY turned desktop notifications on.
 *
 * The same key, read to a deliberately stricter standard, because the two
 * questions asked of it are not the same question:
 *
 *   isDesktopNotifDisabled — "may this tab draw a notification?" Unset means yes.
 *   this                   — "may we create a server-side push subscription for
 *                            this person without asking them?" Unset means no.
 *
 * Unset is the NORMAL state of a fresh sign-in, because the sign-out teardown in
 * lib/pushTeardown.js clears the key. Reading unset as consent would subscribe
 * whoever signed in next on a shared workstation to push they never asked for.
 */
export function wantsDesktopNotifications() {
  return isExplicitOn(localStorage.getItem('rxhive_desktop_notif'));
}
