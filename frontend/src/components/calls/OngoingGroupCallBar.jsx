import { Phone, Video } from 'lucide-react';
import useCallStore, { hasLiveCall } from '../../stores/callStore';
import wsClient from '../../services/websocket';

/**
 * "A call is happening in here — join it."
 *
 * The affordance `activeGroupCalls` was always missing. The server has published
 * `call:group_active` to every other member since group calls were built, and
 * `setActiveGroupCall` has been recording it in the store the whole time — but nothing
 * ever read that map. So a group call was joinable for exactly as long as its ringing
 * screen was on your screen: dismiss it, be looking at another conversation, arrive
 * late, or leave and want back in, and there was no way into a call that was still
 * running. (iOS at least routes `startGroupCall` into a join when it sees one; the web
 * had nothing.)
 *
 * Rendered in the conversation, not as a global banner: a call belongs to a
 * conversation, and showing it in context is what makes "who is already in it" mean
 * anything. Hidden while this client is itself in a call, because the useful action
 * then is not "join" — you are in one — and offering it would invite the
 * two-legs-of-the-same-user problem `evict_other_devices` exists to clean up.
 */
export const OngoingGroupCallBar = ({ conversationId }) => {
  const active = useCallStore((s) => (conversationId ? s.activeGroupCalls[conversationId] : null));
  const busy = useCallStore(hasLiveCall);

  if (!active || !active.call_id || busy) return null;

  const participants = Array.isArray(active.participants) ? active.participants : [];
  const isVideo = active.call_type === 'video';

  // Named rather than counted where it fits. "Alice and Priya are on a call" tells you
  // whether to join; "2 participants" does not.
  const names = participants.map((p) => p?.display_name).filter(Boolean);
  const who = names.length === 0
    ? 'A call is in progress'
    : names.length === 1
      ? `${names[0]} is on a call`
      : names.length === 2
        ? `${names[0]} and ${names[1]} are on a call`
        : `${names[0]}, ${names[1]} and ${names.length - 2} more are on a call`;

  const join = () => {
    const store = useCallStore.getState();
    // Show the connecting UI immediately. The server answers
    // `call:group_participants`, which is where the SFU join actually happens — see
    // the handler in services/websocket.js.
    store.initiateCall(
      active.call_id,
      active.call_type || 'video',
      true,
      conversationId,
      participants[0] || null
    );
    store.setCallState('connecting');
    wsClient.send({ type: 'call:join', call_id: active.call_id });
  };

  return (
    <div
      className="flex items-center gap-3 px-4 py-2 bg-[#10B981]/10 border-b border-[#10B981]/25"
      data-testid="ongoing-group-call-bar"
    >
      <span className="flex-shrink-0 w-7 h-7 rounded-full bg-[#10B981]/20 flex items-center justify-center">
        {isVideo
          ? <Video size={14} className="text-[#10B981]" />
          : <Phone size={14} className="text-[#10B981]" />}
      </span>
      <p className="flex-1 min-w-0 text-[13px] text-[#F5F5F5] truncate">{who}</p>
      <button
        type="button"
        onClick={join}
        data-testid="join-group-call-btn"
        className="flex-shrink-0 h-7 px-3 rounded-full bg-[#10B981] text-[#0A0A0A] text-[12px] font-semibold hover:bg-[#059669] transition-colors"
      >
        Join
      </button>
    </div>
  );
};

export default OngoingGroupCallBar;
