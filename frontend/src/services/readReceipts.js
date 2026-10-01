import client from '../api/client';
import useChatStore from '../stores/chatStore';

/**
 * Tell the server, and so the sender, that a thread has been read.
 *
 * The one place the web sends `PUT /read`. The server stamps last_read_at with the
 * current time whatever anchor it is given (backend/app/services/messaging.py,
 * mark_read), so a receipt is only honest when the newest messages are on screen.
 * The web used to send it from ChatPanel's open effect beside the fetch — before
 * the page arrived, and even when it never did — and the sidebar zeroed the badge
 * on the click. Parity item 34 (docs/IOS_TO_WEB_PARITY.md) records the rule; iOS
 * has the same one.
 *
 * Re-checked here, at the moment of sending, like iOS's isThreadOnScreen: the
 * thread must still be the open one and the tab visible. A fetch can outlive the
 * visit, and a tab can be hidden while one is in flight.
 *
 * `requireCurrent` is for a caller that has not just fetched the newest page — a
 * cached window being reopened, or a click on the thread already open. Those may
 * only vouch for a window that is the newest page and still current
 * (chatStore.windowCurrent). A caller that HAS just put the newest page on screen
 * omits it: that page is the newest whether or not the socket is up to keep it so.
 *
 * Returns whether a receipt was sent.
 */
export function markThreadRead(convId, { requireCurrent = false } = {}) {
  const state = useChatStore.getState();
  if (state.activeConversationId !== convId) return false;
  if (document.visibilityState !== 'visible') return false;
  if (requireCurrent && !state.windowCurrent[convId]) return false;
  client.put(`/api/conversations/${convId}/read`).catch(() => {});
  state.clearUnread(convId);
  return true;
}
