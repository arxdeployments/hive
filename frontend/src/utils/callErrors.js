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
