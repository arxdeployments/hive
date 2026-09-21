/**
 * The bubbles a wholesale message-window replace must not delete.
 *
 * Both fetch paths in ChatPanel end with `setMessages(convId, fetched)`, which
 * replaces the array outright. Anything the server has never seen — a send
 * still in flight, or one that failed — exists only in that array, so a replace
 * that does not carry it deletes the user's message with no bubble, no error
 * and nothing to retry.
 *
 * ## Why 'sending' and not only 'failed'
 *
 * fetchMessages used to keep 'failed' alone, on the grounds that the ack
 * deadline in websocket.js resolves every unacked send to 'failed' before the
 * reconnect that triggers a refetch. That holds for the reconnect path. It does
 * not hold for the other one: fetchMessages also runs when a conversation is
 * OPENED, where no socket has been lost, no deadline has elapsed, and a send
 * made moments earlier is legitimately still 'sending'.
 *
 * What happened then is that the send vanished. Measured at the store level:
 *
 *     after the optimistic send        [older, my new message]
 *     after the in-flight fetch lands  [older]
 *     after message_ack                [older]
 *
 * The ack cannot put it back — `replaceOptimisticMessage` matches on temp_id
 * and no-ops when the bubble is gone — and nothing else will, because the API
 * excludes the sender from its own `new_message` broadcast
 * (services/messaging.py: `conversation_recipients(..., exclude=sender.id)`).
 * The message is on the server and in the sidebar's last-message preview, and
 * absent from the thread until the next fetch.
 *
 * The jump path already kept 'sending' for this reason. This is the same rule,
 * applied to the path that needed it too.
 *
 * ## Dedupe
 *
 * `client_msg_id` is the sender's temp_id, cleaned (services/messaging.py
 * `_clean_client_msg_id` strips and length-checks it, nothing more), so a
 * fetched message carrying one identifies the local bubble that produced it.
 * Without this a send that DID land comes back twice: once from the server and
 * once as the optimistic copy sitting under it, inviting the user to resend.
 *
 * Only our own messages carry a key here — the API withholds other senders' —
 * which is what keeps `filter(Boolean)` from matching a stranger's.
 */
const LOCAL_ONLY_STATUSES = new Set(['sending', 'failed']);

export function carryOverLocalOnly(existing, fetched) {
  const landed = new Set((fetched || []).map((m) => m.client_msg_id).filter(Boolean));
  return (existing || []).filter(
    (m) => LOCAL_ONLY_STATUSES.has(m.status) && !landed.has(m.temp_id),
  );
}
