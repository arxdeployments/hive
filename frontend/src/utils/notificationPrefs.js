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

function isOff(key) {
  return OFF_VALUES.has(localStorage.getItem(key));
}

/** True when the user has turned notification sounds off. */
export function isSoundMuted() {
  return isOff('rxhive_notif_sound');
}

/** True when the user has turned desktop notifications off. */
export function isDesktopNotifDisabled() {
  return isOff('rxhive_desktop_notif');
}
