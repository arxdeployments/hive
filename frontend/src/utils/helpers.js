import { toast } from 'sonner';

export const handleApiError = (error, options = {}) => {
  const status = error?.response?.status;
  const detail = error?.response?.data?.detail;
  const { retry, silent } = options;

  if (silent) return;

  let message = 'Something went wrong. Please try again.';

  if (!error?.response) {
    message = 'Network error. Check your connection.';
  } else {
    switch (status) {
      case 400:
        message = detail || 'Invalid request.';
        break;
      case 401:
        message = 'Session expired. Please log in again.';
        // Auto-redirect happens via axios interceptor
        break;
      case 403:
        message = detail || "You don't have permission to do this.";
        break;
      case 404:
        message = detail || 'Resource not found.';
        break;
      case 422:
        message = detail || 'Invalid input. Please check your data.';
        break;
      case 429:
        message = 'Too many requests. Please wait a moment.';
        break;
      case 500:
        message = 'Server error. Please try again later.';
        break;
      default:
        message = detail || message;
    }
  }

  toast.error(message, {
    duration: 5000,
    action: retry ? { label: 'Retry', onClick: retry } : undefined,
  });

  return message;
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

// Detect and linkify URLs in text
export const linkifyText = (text) => {
  if (!text) return text;
  const urlRegex = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!])/gi;
  const parts = text.split(urlRegex);
  if (parts.length === 1) return text; // No URLs found

  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0; // Reset regex state
      return (
        `<a href="${part}" target="_blank" rel="noopener noreferrer" class="text-[#10B981] hover:underline">${part}</a>`
      );
    }
    return part;
  }).join('');
};

// Check if text contains URLs
export const hasUrls = (text) => {
  if (!text) return false;
  return /(https?:\/\/[^\s<]+)/gi.test(text);
};
