/**
 * The web half of parity item 34 (docs/IOS_TO_WEB_PARITY.md): a read receipt is
 * only sent for a thread that is showing its newest messages.
 *
 * The server stamps last_read_at with the current time whatever anchor a receipt
 * names (backend/app/services/messaging.py, mark_read). So a receipt sent too early
 * tells the sender that messages the reader never saw have been Read. The web sent
 * such receipts from ChatPanel's open effect (beside the fetch, before the page
 * arrived and even when it never did) and from websocket.js (over a jump's slice,
 * a loading first page, or a failed fetch), and the sidebar zeroed the badge on the
 * click. iOS fixed the same class in batch 71, and CodeRabbit asked for the web to
 * match — then, reviewing that port, found four more ways it could still lie.
 *
 * There is no component harness in this repo (no jsdom, no testing-library), so,
 * like chatRequestOrdering.test.js, these pin the wiring in the source. Each
 * assertion was checked by deleting the code it guards and watching it fail.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const read = (rel) => readFileSync(join(import.meta.dirname, rel), 'utf8');
const panel = read('ChatPanel.jsx');
const sidebar = read('ChatSidebar.jsx');
const socket = read('../../services/websocket.js');
const receipts = read('../../services/readReceipts.js');
const store = read('../../stores/chatStore.js');

/** The source from `start` up to and including the next `closer`. */
function block(source, start, closer) {
  const from = source.indexOf(start);
  assert.notEqual(from, -1, `not found: ${start}`);
  const to = source.indexOf(closer, from + start.length);
  assert.notEqual(to, -1, `no end for: ${start}`);
  return source.slice(from, to + closer.length);
}

/** Lines of `source` that are code, not comments. */
const code = (source) => source.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/**'));

const fetchBlock = () => block(panel, 'const fetchMessages = useCallback(',
  '}, [conversationId, setMessages, myUserId, setWindowCurrent]);');
const jumpBlock = () => block(panel, "params: { around: originalMsgId, limit: 50 },", 'pendingJumpRef.current = originalMsgId;');

describe('services/readReceipts: the one place PUT /read is sent', () => {
  it('is the only sender, across the panel, the sidebar and the socket', () => {
    for (const [name, src] of [['ChatPanel.jsx', panel], ['ChatSidebar.jsx', sidebar], ['websocket.js', socket]]) {
      assert.equal(code(src).filter((l) => l.includes('/read`')).length, 0, `${name} sends PUT /read itself`);
    }
    assert.equal(code(receipts).filter((l) => l.includes('/read`')).length, 1);
  });

  it('re-checks, at the moment of sending, that the thread is open, the tab visible and — when asked — the window current', () => {
    const lines = code(block(receipts, 'export function markThreadRead(', '\n}'));
    const open = lines.indexOf('if (state.activeConversationId !== convId) return false;');
    const visible = lines.indexOf("if (document.visibilityState !== 'visible') return false;");
    const current = lines.indexOf('if (requireCurrent && !state.windowCurrent[convId]) return false;');
    const send = lines.findIndex((l) => l.includes('/read`'));
    assert.ok(open !== -1, 'a page that answers after the user left is marked read');
    assert.ok(visible !== -1, 'a hidden tab is marked read');
    assert.ok(current !== -1, 'a caller that has not just fetched can vouch for a stale window');
    assert.ok(open < send && visible < send && current < send);
  });
});

describe('ChatPanel: the thread is marked read once its newest page is on screen', () => {
  it('no longer marks read from the open effect, and leaving disowns the fetch', () => {
    const effect = block(panel, '  useEffect(() => {\n    // Marks the thread read itself', '}, [fetchMessages]);');
    assert.ok(!code(effect).some((l) => l.includes('markThreadRead') || l.includes('clearUnread')),
      'the open effect marks the thread read before its page has arrived');
    assert.ok(code(effect).includes('return () => { fetchSeqRef.current += 1; };'),
      'a fetch that answers after the user left still writes its window');
  });

  it('marks read after a successful fetch has written the page — with live arrivals kept — not before, not on failure', () => {
    const lines = code(fetchBlock());
    const bail = lines.indexOf('if (seq !== fetchSeqRef.current) return;');
    const live = lines.indexOf('const live = carryOverLiveArrivals(held, fetched);');
    const write = lines.indexOf('setMessages(conversationId, kept.length ? [...fetched, ...kept] : fetched);');
    const mark = lines.indexOf('markThreadRead(conversationId);');
    const caught = lines.indexOf('} catch (err) {');
    assert.ok(bail !== -1 && live !== -1 && write !== -1 && mark !== -1 && caught !== -1,
      'fetchMessages changed shape; re-check this guard');
    assert.ok(lines.includes('const kept = [...live, ...localOnly];'), 'live arrivals are not written back');
    assert.ok(bail < live && live < write, 'live arrivals are not kept when the page replaces the thread');
    assert.ok(write < mark, 'the thread is marked read before its page is written');
    assert.ok(mark < caught, 'a failed fetch marks the thread read');
  });

  it('marks a cached window read only if it is current', () => {
    const cached = block(panel, 'const fetchMessages = useCallback(', 'setLoading(true);');
    assert.ok(code(cached).includes('markThreadRead(conversationId, { requireCurrent: true });'),
      'a cached window is marked read without being known to be the newest page');
  });

  it('withdraws "current" for the life of every replacing fetch, and grants it only with the socket up', () => {
    const lines = code(fetchBlock());
    const loading = lines.indexOf('setLoading(true);');
    const notCurrent = lines.indexOf('setWindowCurrent(conversationId, false);');
    const request = lines.findIndex((l) => l.includes('await client.get('));
    assert.ok(loading !== -1 && notCurrent !== -1 && request !== -1);
    assert.ok(loading < notCurrent && notCurrent < request, 'live arrivals are receipted over a spinner or a failed fetch');
    assert.ok(lines.includes('setWindowCurrent(conversationId, connected);'), 'a successful fetch does not grant "current"');
    assert.ok(lines.includes('if (connected) loadedWindowsRef.current.add(conversationId);'),
      'a page fetched with the socket down is reused from cache as if current');
  });

  it('marks a current window read when a hidden tab becomes visible', () => {
    // CodeRabbit, review of f0f668e: a fetch finishing in a hidden tab marks nothing,
    // and without this nothing told the server until the next message.
    const effect = code(block(panel, "    document.addEventListener('visibilitychange', onVisible);", '}, [conversationId]);'));
    const listener = code(block(panel, '    const onVisible = () => {', '    };'));
    assert.ok(listener.includes("if (document.visibilityState === 'visible') {"));
    assert.ok(listener.includes('markThreadRead(conversationId, { requireCurrent: true });'),
      'a tab coming back into view marks a slice or a stale window read, or nothing at all');
    assert.ok(effect.includes("return () => document.removeEventListener('visibilitychange', onVisible);"),
      'the listener outlives the thread it was added for');
  });

  it('keeps live arrivals for a jump that reaches the newest message, never for a slice', () => {
    const lines = code(jumpBlock());
    assert.ok(lines.includes('const live = data.has_newer ? [] : carryOverLiveArrivals(held, fetched);'),
      'a jump drops live arrivals, or stitches the old end onto a slice');
    assert.ok(lines.includes('setWindowCurrent(conversationId, !data.has_newer && connected);'),
      'a jump\'s slice is recorded as current');
  });
});

describe('chatStore: a socket drop withdraws "current" synchronously', () => {
  it('clears windowCurrent inside setWsConnected(false), not in a React effect', () => {
    const setter = block(store, 'setWsConnected: (connected) => set((state) => {', '  }),');
    assert.ok(code(setter).includes(': { wsConnected: false, wsConnecting: false, windowCurrent: {} };'),
      'a drop leaves windows vouched for until React next commits');
  });
});

describe('websocket.js: a live receipt only for a window that is current', () => {
  const looking = () => block(socket, '        if (looking) {', '          break;\n        }');

  it('receipts the active conversation only while its window is current', () => {
    const lines = code(looking());
    const gate = lines.indexOf('if (store.windowCurrent?.[convId]) {');
    assert.ok(gate !== -1 && lines[gate + 1] === 'this.sendReadReceipt(convId, msg._id);',
      'a new message is receipted while the window on screen is not the newest page');
  });

  it('counts a withheld message as unread, as the server does', () => {
    const lines = code(looking());
    assert.ok(lines.includes("} else if (msg.sender_id && msg.sender_id !== this._currentUserId() && msg.type !== 'system') {"));
    assert.ok(lines.includes('store.incrementUnread(convId);'), 'a withheld message leaves the badge behind the server');
  });
});

describe('ChatSidebar: no badge is cleared outside the guarded path', () => {
  it('marks a re-clicked open thread read only through markThreadRead, and only if current', () => {
    const click = code(block(sidebar, 'const handleConversationClick = useCallback(', '}, [onSelectConversation]);'));
    assert.ok(!click.some((l) => l.includes('clearUnread(')), 'the sidebar zeroes a badge without the read checks');
    assert.ok(click.includes('markThreadRead(conv._id, { requireCurrent: true });'),
      'a re-click on the open thread bypasses the read checks');
  });
});
