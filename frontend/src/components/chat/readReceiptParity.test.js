/**
 * The web half of parity item 34 (docs/IOS_TO_WEB_PARITY.md): a read receipt is
 * only sent for a thread that is showing its newest messages.
 *
 * The server stamps last_read_at with the current time whatever anchor a receipt
 * names (backend/app/services/messaging.py, mark_read). So a receipt sent too early
 * tells the sender that messages the reader never saw have been Read. The web sent
 * such receipts from three places:
 *
 *   - ChatPanel's open effect fired PUT /read alongside fetchMessages(), without
 *     waiting for the page and whether or not it ever arrived;
 *   - websocket.js receipted every new_message in the active conversation, even
 *     while a jump's slice was on screen, while the first page was still loading,
 *     and over a failed fetch's error strip;
 *   - a fetch that answered after the user had left the thread still marked it.
 *
 * And the sidebar zeroed the badge on the click, before any of it was known.
 *
 * iOS fixed the same class in batch 71, and CodeRabbit asked for the web to match.
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
  '}, [conversationId, setMessages, myUserId, markThreadRead, setWindowCurrent]);');

describe('ChatPanel: the thread is marked read once its newest page is on screen', () => {
  it('sends PUT /read from one place only, markThreadRead', () => {
    const sends = code(panel).filter((l) => l.includes('/read`'));
    assert.equal(sends.length, 1, `PUT /read is sent from ${sends.length} places`);
    assert.ok(block(panel, 'const markThreadRead = useCallback(', '}, [clearUnread]);').includes('/read`'));
  });

  it('re-checks, at the moment of sending, that the thread is open and the tab visible', () => {
    const mark = code(block(panel, 'const markThreadRead = useCallback(', '}, [clearUnread]);'));
    const check = mark.findIndex((l) => l === "if (s.activeConversationId !== convId || document.visibilityState !== 'visible') return;");
    const send = mark.findIndex((l) => l.includes('/read`'));
    assert.ok(check !== -1, 'a page that answers after the user left, or in a hidden tab, is marked read');
    assert.ok(check < send);
  });

  it('no longer marks read from the open effect, and leaving disowns the fetch', () => {
    const effect = block(panel, '  useEffect(() => {\n    // Marks the thread read itself', '}, [fetchMessages]);');
    assert.ok(!code(effect).some((l) => l.includes('/read') || l.includes('markThreadRead') || l.includes('clearUnread')),
      'the open effect marks the thread read before its page has arrived');
    assert.ok(code(effect).includes('return () => { fetchSeqRef.current += 1; };'),
      'a fetch that answers after the user left still writes its window');
  });

  it('marks read after a successful fetch has put the page on screen — not before, not on failure', () => {
    const lines = code(fetchBlock());
    const bail = lines.findIndex((l) => l === 'if (seq !== fetchSeqRef.current) return;');
    const write = lines.findIndex((l) => l.startsWith('setMessages(conversationId,'));
    const marks = lines.map((l, i) => (l === 'markThreadRead(conversationId);' ? i : -1)).filter((i) => i !== -1);
    const caught = lines.findIndex((l) => l === '} catch (err) {');
    assert.ok(bail !== -1 && write !== -1 && marks.length && caught !== -1, 'fetchMessages changed shape; re-check this guard');
    const successMark = marks.find((i) => i > bail);
    assert.ok(successMark !== undefined, 'a successful fetch never marks the thread read');
    assert.ok(write < successMark, 'the thread is marked read before its page is written');
    assert.ok(successMark < caught, 'a failed fetch marks the thread read');
  });

  it('marks a cached window read only if it is current', () => {
    const cached = block(panel, 'const fetchMessages = useCallback(', 'setLoading(true);');
    assert.ok(cached.includes('if (useChatStore.getState().windowCurrent[conversationId]) {'),
      'a cached window is marked read without being known to be the newest page');
  });

  it('withdraws "current" for the life of every replacing fetch, and grants it only with the socket up', () => {
    const lines = code(fetchBlock());
    const loading = lines.findIndex((l) => l === 'setLoading(true);');
    const notCurrent = lines.findIndex((l) => l === 'setWindowCurrent(conversationId, false);');
    const request = lines.findIndex((l) => l.includes('await client.get('));
    assert.ok(loading !== -1 && notCurrent !== -1 && request !== -1);
    assert.ok(loading < notCurrent && notCurrent < request,
      'live arrivals are receipted over a spinner or a failed fetch');
    assert.ok(lines.includes('setWindowCurrent(conversationId, connected);'), 'a successful fetch does not grant "current"');
    assert.ok(lines.includes('if (connected) loadedWindowsRef.current.add(conversationId);'),
      'a page fetched with the socket down is reused from cache as if current');
  });

  it('forgets every window the socket was keeping current when it drops', () => {
    const effect = block(panel, '    if (!wsConnected) {', '    }');
    assert.ok(effect.includes('clearWindowsCurrent();'), 'a dropped socket leaves windows vouched for');
  });

  it('records a jump as current only if it reaches the newest message with the socket up', () => {
    assert.ok(panel.includes('setWindowCurrent(conversationId, !data.has_newer && connected);'),
      'a jump\'s slice is recorded as current');
  });
});

describe('websocket.js: a live receipt only for a window that is current', () => {
  const looking = () => block(socket, '        if (looking) {', '          break;\n        }');

  it('receipts the active conversation only while its window is current', () => {
    const lines = code(looking());
    const gate = lines.findIndex((l) => l === 'if (store.windowCurrent?.[convId]) {');
    const receipt = lines.findIndex((l) => l === 'this.sendReadReceipt(convId, msg._id);');
    assert.ok(gate !== -1 && receipt === gate + 1,
      'a new message is receipted while the window on screen is not the newest page');
  });

  it('counts a withheld message as unread, as the server does', () => {
    const lines = code(looking());
    assert.ok(lines.includes("} else if (msg.sender_id && msg.sender_id !== this._currentUserId() && msg.type !== 'system') {"));
    assert.ok(lines.includes('store.incrementUnread(convId);'), 'a withheld message leaves the badge behind the server');
  });
});

describe('ChatSidebar: the badge is not cleared on the click', () => {
  it('leaves another thread\'s badge for ChatPanel to clear once its page is on screen', () => {
    const click = code(block(sidebar, 'const handleConversationClick = useCallback(', '}, [onSelectConversation, clearUnread]);'));
    const clears = click.filter((l) => l.includes('clearUnread('));
    assert.equal(clears.length, 1);
    assert.ok(click.includes('if (conv._id === useChatStore.getState().activeConversationId && conv.unread_count > 0) {'),
      'the sidebar zeroes a thread\'s badge on the click, before its page has arrived');
  });
});
