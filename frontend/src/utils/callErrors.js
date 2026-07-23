import { toast } from 'sonner';

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
