import { toast } from 'sonner';

/**
 * User-facing text per CallJoinError reason (see services/livekitClient.js).
 *
 * Every message names the thing to check. "Could not connect the call" is
 * useless: a stopped SFU and a browser-blocked microphone produced the exact
 * same toast, and both are common enough that the user could not tell which
 * one they were looking at.
 */
const JOIN_FAILURE_MESSAGES = {
  sfu_unreachable: 'Call server unreachable — check that LiveKit is running.',
  sfu_rejected: 'Call server rejected this call. Try again, or contact your admin.',
  sfu_error: 'Call server error — the call could not be established.',
  permission_denied:
    'Microphone blocked. Allow microphone access in your browser settings, then call again.',
  device_missing: 'No microphone found. Connect one and try again.',
  device_busy: 'Your microphone is in use by another app. Close it and try again.',
  media_failed: 'Could not start your microphone.',
  call_unavailable: 'That call is no longer active.',
  token_failed: 'Could not authorize the call. Check your connection and try again.',
};

/**
 * Report a failed LiveKit join: a specific toast for the user and the
 * underlying error in the console for whoever debugs it.
 * @returns {string} the reason code, for callers that branch on it.
 */
export const handleCallJoinError = (error, context = 'join') => {
  const reason = error?.reason || 'unknown';
  const message = JOIN_FAILURE_MESSAGES[reason] || 'Could not connect the call.';
  // Log the cause, not just our wrapper — the LiveKit/DOMException underneath
  // is what actually says which host or device failed.
  console.error(`[call:${context}] join failed (${reason}):`, error?.cause || error);
  toast.error(message, { duration: 8000 });
  return reason;
};

/** The camera failed but the mic did not — the call is live, just audio-only. */
export const notifyCameraUnavailable = (reason) => {
  const message =
    reason === 'permission_denied'
      ? 'Camera blocked — continuing with audio only.'
      : reason === 'device_busy'
        ? 'Camera in use by another app — continuing with audio only.'
        : 'No camera available — continuing with audio only.';
  toast.warning(message, { duration: 6000 });
};

/**
 * A camera the user asked for MID-CALL and could not have.
 *
 * Deliberately not `notifyCameraUnavailable`: that says "continuing with audio only",
 * which is the right sentence when a call is being established and the wrong one
 * entirely when somebody has just pressed the camera button on a call that is already
 * running — nothing is "continuing", their tap simply did not take, and the button has
 * gone back to off. This says that instead.
 */
export const notifyCameraToggleFailed = (reason) => {
  const message =
    reason === 'permission_denied'
      ? 'Camera blocked — allow camera access in your browser settings.'
      : reason === 'device_busy'
        ? 'Camera is in use by another app — close it and try again.'
        : reason === 'device_missing'
          ? 'No camera found.'
          : 'Could not turn on your camera.';
  toast.error(message, { duration: 6000 });
};

/**
 * A microphone that would not do what it was told MID-CALL.
 *
 * Both directions get a toast, which is where this differs from the camera: a
 * failed MUTE leaves a live microphone on a call the user believes they have
 * gone quiet on, and a control quietly springing back is far too soft a way to
 * say so. Reached when `setTrackEnabled` awaits a `republishPromise` that a
 * mid-reconnect `restartTrack()` rejected — which fails either direction — and,
 * for unmute, when reopening a device the browser has ended underneath us.
 *
 * Worded passively on purpose: the rejoin path re-mutes automatically, so this
 * also fires without anyone having pressed anything.
 */
export const notifyMicToggleFailed = (enabled, reason) => {
  if (!enabled) {
    toast.error('Your microphone could not be muted — it is still picking up sound.', { duration: 6000 });
    return;
  }
  const message =
    reason === 'permission_denied'
      ? 'Microphone blocked — allow microphone access in your browser settings.'
      : reason === 'device_busy'
        ? 'Microphone is in use by another app — close it and try again.'
        : reason === 'device_missing'
          ? 'No microphone found.'
          : 'Could not turn on your microphone.';
  toast.error(message, { duration: 6000 });
};

/**
 * A screen share the user asked for and did not get.
 *
 * A DISMISSED PICKER IS NOT REPORTED. Backing out of the share picker is a
 * normal thing to do, and an error toast on top of it would be noise — but
 * Chromium rejects it with the same `NotAllowedError` as a real block, so the
 * two have to be told apart by message. Chromium's two results are distinct:
 * a cancelled picker is PERMISSION_DENIED ("Permission denied"), while an
 * OS-level refusal — macOS Screen Recording not granted to the browser, which
 * is the case people actually hit and the only one with an action attached —
 * is PERMISSION_DENIED_BY_SYSTEM ("Permission denied by system").
 *
 * Anything we do not recognise at all is still reported, so a wording change
 * upstream costs a spurious toast rather than another silent failure.
 */
export const notifyScreenShareFailed = (error) => {
  // `getDisplayMedia` missing outright: iOS Safari, an insecure context, an old
  // browser. livekit-client throws DeviceUnsupportedError before it ever asks
  // for a screen, and a TypeError means navigator.mediaDevices itself is absent.
  // The Share control renders on every layout including the phone ones, so
  // without this branch every iPhone tap would land on the generic message and
  // send the user looking for a setting that does not exist.
  if (error?.name === 'DeviceUnsupportedError' || error?.name === 'TypeError') {
    toast.error("Screen sharing isn't supported in this browser.", { duration: 6000 });
    return;
  }
  if (error?.name === 'NotAllowedError') {
    if (!/by system/i.test(error?.message || '')) return;
    toast.error(
      'Screen recording is blocked for your browser. Allow it in your system settings, then try again.',
      { duration: 8000 }
    );
    return;
  }
  toast.error('Could not start screen sharing.', { duration: 6000 });
};

/**
 * Stop failed, so the share may still be up — worth saying out loud: it is their
 * screen. Hedged rather than stated, because `unpublishTrack` stops the capture
 * before anything that can throw, so a rejection out of the screen-audio half
 * can leave the video already down.
 */
export const notifyScreenShareStopFailed = () => {
  toast.error('Could not stop screen sharing — your screen may still be shared.', { duration: 8000 });
};

/**
 * Handle call-related errors with user-friendly messages.
 */
export const handleCallError = (error, context = '') => {
  const name = error?.name || '';
  const message = error?.message || '';

  if (name === 'NotAllowedError') {
    toast.error('Camera and microphone access denied. Enable in browser settings.', { duration: 6000 });
    return 'permission_denied';
  }

  if (name === 'NotFoundError') {
    toast.info('No camera found. Starting audio-only call.', { duration: 4000 });
    return 'no_camera';
  }

  if (name === 'NotReadableError') {
    toast.error('Camera or microphone is being used by another app.', { duration: 5000 });
    return 'device_busy';
  }

  if (name === 'OverconstrainedError') {
    toast.error('Requested media settings not supported by your device.', { duration: 4000 });
    return 'overconstrained';
  }

  if (message.includes('Microphone access required')) {
    toast.error('Microphone access is required for calls.', { duration: 5000 });
    return 'mic_required';
  }

  if (context === 'ice_failed') {
    toast.error('Call quality is too poor to continue.', { duration: 4000 });
    return 'ice_failed';
  }

  if (context === 'ws_disconnected') {
    toast.warning('Connection lost. Attempting to reconnect...', { duration: 3000 });
    return 'ws_disconnected';
  }

  if (context === 'call_full') {
    toast.error('This call is full (6/6 participants).', { duration: 4000 });
    return 'call_full';
  }

  if (context === 'org_isolation') {
    toast.error('You can only call people in your organization.', { duration: 4000 });
    return 'org_isolation';
  }

  // Generic
  toast.error(message || 'Call error. Please try again.', { duration: 4000 });
  return 'unknown';
};
