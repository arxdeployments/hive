import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, Search, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import client from '../../api/client';
import useCallStore from '../../stores/callStore';

/**
 * Pull more people into a group call that is already running.
 *
 * Multi-select rather than the one-tap-per-person flow `NewChatModal` uses, because the
 * server takes the whole list in one request and answers PER INVITEE — one round trip
 * for "add these four" gives an accurate partial result ("two added, one is in another
 * org, one is already here"), where four separate requests would race each other
 * against the call's capacity and report success for invites the last one made
 * impossible.
 *
 * Everyone already on the call is shown but not selectable. Hiding them instead would
 * be worse: the reason somebody opens this list is to find a specific person, and a
 * name silently missing from it reads as "they are not in this organisation".
 */

/** Server outcome → what to actually tell the user. */
const OUTCOME_LABEL = {
  invited: null, // counted, not listed one by one
  already_invited: 'is already on the call',
  unavailable: 'is unavailable',
  different_org: 'is outside your organisation',
  call_full: 'could not be added — the call is full',
};

export const AddParticipantsModal = ({ isOpen, onClose, callId }) => {
  const remoteParticipants = useCallStore((s) => s.remoteParticipants);
  const pendingInvitees = useCallStore((s) => s.pendingInvitees);

  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState([]);
  // `loaded` distinguishes "the roster came back empty" from "the roster has not come
  // back yet". Without it the debounce window rendered "No contacts in your
  // organisation" over a list that was about to arrive.
  const [loaded, setLoaded] = useState(false);
  const [sending, setSending] = useState(false);

  // Who is already accounted for. Read from the store rather than passed in, so the
  // list stays right if somebody joins or answers while this is open.
  const onCall = useMemo(() => {
    const ids = new Set(remoteParticipants.map((p) => p.id));
    pendingInvitees.forEach((p) => ids.add(p.id));
    return ids;
  }, [remoteParticipants, pendingInvitees]);

  const fetchContacts = useCallback(async () => {
    try {
      const { data } = await client.get('/api/users/contacts', { params: { search } });
      setContacts(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[call] could not load contacts for the invite list', err);
      toast.error('Could not load your contacts');
    } finally {
      setLoaded(true);
    }
  }, [search]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = setTimeout(fetchContacts, 250);
    return () => clearTimeout(timer);
  }, [isOpen, fetchContacts]);

  // A fresh sheet each time it opens — a selection carried over from the last invite
  // would silently re-invite people on the next one.
  useEffect(() => {
    if (isOpen) return;
    setSelected([]);
    setSearch('');
    setLoaded(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const toggle = (id) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const handleInvite = async () => {
    if (!selected.length || sending) return;
    // Never build `/api/calls/null/invite`. The id is the server's, learned from
    // `call:group_started` / `call:group_participants`; if it is missing something
    // upstream failed to record it and the request would be a 422 the user cannot act on.
    if (!callId) {
      console.error('[call] cannot invite: this client has no call id');
      toast.error('Could not add anyone — the call id is missing');
      return;
    }
    setSending(true);
    try {
      const { data } = await client.post(`/api/calls/${callId}/invite`, { user_ids: selected });
      const outcome = data?.outcome || {};
      const invited = data?.invited || [];

      // Optimistic placeholders for the ones that were actually rung. The server also
      // sends `call:participants_invited` to everyone in the call including us, so this
      // only wins the race — `addPendingInvitees` drops duplicates.
      if (invited.length) {
        useCallStore.getState().addPendingInvitees(
          invited
            .map((id) => contacts.find((c) => c.id === id))
            .filter(Boolean)
            .map((c) => ({ id: c.id, display_name: c.display_name, avatar_url: c.avatar_url })),
        );
        toast.success(
          invited.length === 1 ? 'Ringing them now' : `Ringing ${invited.length} people now`,
        );
      }

      // Anything that did NOT go through is named. A flat "invites sent" for a partial
      // result is how you end up waiting for somebody who was never called.
      const refused = Object.entries(outcome).filter(([, v]) => v !== 'invited');
      for (const [id, reason] of refused) {
        const who = contacts.find((c) => c.id === id)?.display_name || 'That person';
        const label = OUTCOME_LABEL[reason];
        toast.info(label ? `${who} ${label}` : `${who} could not be added`);
      }
      if (!invited.length && !refused.length) toast.info('Nobody was added');
      onClose?.();
    } catch (err) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === 'string' ? detail : 'Could not add anyone to the call');
    } finally {
      setSending(false);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        // Above the call screens, which sit at 9998/9999.
        className="fixed inset-0 z-[10000] flex items-center justify-center p-4"
        onClick={onClose}
      >
        <div className="absolute inset-0 bg-black/70 backdrop-blur-[4px]" />
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
          onClick={(e) => e.stopPropagation()}
          data-testid="add-participants-modal"
          className="relative bg-[#141414] border border-[#1F1F1F] rounded-[12px] w-full max-w-[420px] max-h-[70vh] shadow-[0_18px_60px_rgba(0,0,0,0.6)] flex flex-col overflow-hidden"
        >
          <div className="flex items-center justify-between px-5 py-4 border-b border-[#1F1F1F]">
            <h3 className="text-base font-semibold text-[#F5F5F5]">Add to call</h3>
            <button
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 text-[#A3A3A3] hover:text-[#F5F5F5] hover:bg-[#1A1A1A] rounded-[6px] transition-colors"
            >
              <X size={18} />
            </button>
          </div>

          <div className="px-4 py-3">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#A3A3A3]" />
              <input
                type="text"
                placeholder="Search by name or email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                data-testid="add-participants-search"
                className="w-full h-10 pl-10 pr-4 bg-[#1A1A1A] border border-[#2D2D2D] rounded-[6px] text-sm text-[#F5F5F5] placeholder:text-[#A3A3A3] focus:border-[#10B981] focus:outline-none transition-colors"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {!loaded ? (
              <div className="space-y-2 px-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-3 p-2">
                    <div className="w-9 h-9 rounded-full bg-[#1A1A1A] animate-pulse" />
                    <div className="flex-1">
                      <div className="h-4 w-24 bg-[#1A1A1A] rounded animate-pulse" />
                      <div className="h-3 w-16 bg-[#1A1A1A] rounded animate-pulse mt-1" />
                    </div>
                  </div>
                ))}
              </div>
            ) : contacts.length === 0 ? (
              <p className="text-sm text-[#A3A3A3] text-center py-10">
                {search ? 'Nobody matches that search' : 'No contacts in your organisation'}
              </p>
            ) : (
              <div className="space-y-0.5">
                {contacts.map((contact) => {
                  const already = onCall.has(contact.id);
                  const isSelected = selected.includes(contact.id);
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      disabled={already}
                      onClick={() => toggle(contact.id)}
                      data-testid="add-participant-item"
                      data-user-id={contact.id}
                      aria-pressed={isSelected}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-[6px] text-left transition-colors ${
                        already ? 'opacity-45 cursor-default' : 'hover:bg-[#1A1A1A]'
                      }`}
                    >
                      <div className="w-9 h-9 rounded-full bg-[#10B981]/10 flex items-center justify-center text-[#10B981] text-sm font-medium flex-shrink-0">
                        {contact.display_name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[#F5F5F5] truncate">{contact.display_name}</p>
                        <p className="text-xs text-[#A3A3A3] truncate">
                          {already ? 'On the call' : contact.department_name || contact.email}
                        </p>
                      </div>
                      <span
                        className={`w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 ${
                          isSelected ? 'bg-[#10B981] border-[#10B981]' : 'border-[#2D2D2D]'
                        }`}
                      >
                        {isSelected && <Check size={13} className="text-white" />}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="px-4 py-3 border-t border-[#1F1F1F]">
            <button
              type="button"
              onClick={handleInvite}
              disabled={!selected.length || sending}
              data-testid="add-participants-confirm"
              className="w-full h-10 rounded-[6px] bg-[#10B981] text-white text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[#0EA271] transition-colors"
            >
              <UserPlus size={16} />
              {sending
                ? 'Adding…'
                : selected.length
                  ? `Add ${selected.length} to call`
                  : 'Select people to add'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

export default AddParticipantsModal;
