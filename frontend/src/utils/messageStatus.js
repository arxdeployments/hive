/**
 * Read-receipt (tick) status for a message.
 *
 * Messages loaded from the API carry no `status` field. What they carry is
 * `read_by` / `delivered_to`, derived server-side from each participant's
 * `last_read_at` (see backend `enrich.serialize_message`):
 *
 *   read_by:      [{ user_id, read_at }]
 *   delivered_to: [{ user_id, delivered_at }]
 *
 * Historically `status` was only ever set by live WebSocket events, so after a
 * reload every own message fell back to the default grey/white tick even when
 * the recipient had read it. Deriving the status here gives the load path the
 * same tick state as the live path, from one shared rule set.
 *
 * Both arrays already exclude the sender server-side; we filter on `user_id`
 * anyway so the rule holds regardless of who serialized the payload.
 */

export const MESSAGE_STATUS = {
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read',
  FAILED: 'failed',
};

// Purely client-side states: the message has not round-tripped yet, so receipt
// arrays cannot possibly contradict them. Never derive over an optimistic send.
const CLIENT_OWNED = new Set([MESSAGE_STATUS.SENDING, MESSAGE_STATUS.FAILED]);

const hasSomeoneElse = (receipts, myUserId) =>
  Array.isArray(receipts) &&
  receipts.some((r) => r && r.user_id && r.user_id !== myUserId);

/**
 * Tick state for `message` as seen by `myUserId`.
 * Returns null for messages I did not send — those render no ticks at all.
 */
export function deriveStatus(message, myUserId) {
  if (!message) return null;
  if (!myUserId || !message.sender_id || message.sender_id !== myUserId) return null;
  if (CLIENT_OWNED.has(message.status)) return message.status;
  if (hasSomeoneElse(message.read_by, myUserId)) return MESSAGE_STATUS.READ;
  if (hasSomeoneElse(message.delivered_to, myUserId)) return MESSAGE_STATUS.DELIVERED;
  return MESSAGE_STATUS.SENT;
}

/**
 * Same message with a derived `status`. Returns the original object when
 * nothing changes, so memoised bubbles keep their reference and don't re-render.
 */
export function withDerivedStatus(message, myUserId) {
  if (!message) return message;
  const status = deriveStatus(message, myUserId);
  if (status === null || status === message.status) return message;
  return { ...message, status };
}

/** Map form of {@link withDerivedStatus} for whole pages of messages. */
export function withDerivedStatuses(messages, myUserId) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => withDerivedStatus(m, myUserId));
}

/**
 * Record `readerId` as having read `message` (live `messages_read` event).
 *
 * The receipt arrays are updated alongside `status` so the store stays
 * self-consistent: a later re-derive of the same object cannot silently
 * downgrade a blue tick back to grey.
 *
 * `myUserId` may be unknown (the socket reads it from the localStorage session
 * mirror); in that case we fall back to the pre-existing behaviour of trusting
 * the event and marking anything the reader did not send as read.
 */
export function applyReadReceipt(message, readerId, myUserId, readAt) {
  if (!message || !readerId) return message;
  if (!message.sender_id || message.sender_id === readerId) return message;

  const ts = readAt || new Date().toISOString();
  const readBy = Array.isArray(message.read_by) ? message.read_by : [];
  const deliveredTo = Array.isArray(message.delivered_to) ? message.delivered_to : [];
  const alreadyRead = readBy.some((r) => r && r.user_id === readerId);
  const alreadyDelivered = deliveredTo.some((d) => d && d.user_id === readerId);

  const merged = alreadyRead && alreadyDelivered
    ? message
    : {
      ...message,
      read_by: alreadyRead ? readBy : [...readBy, { user_id: readerId, read_at: ts }],
      delivered_to: alreadyDelivered
        ? deliveredTo
        : [...deliveredTo, { user_id: readerId, delivered_at: ts }],
    };

  const status = myUserId ? deriveStatus(merged, myUserId) : MESSAGE_STATUS.READ;
  if (status === null || status === merged.status) return merged;
  return { ...merged, status };
}
