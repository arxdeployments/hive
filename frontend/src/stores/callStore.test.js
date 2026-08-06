import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import useCallStore, { LINK_OK, LINK_RECONNECTING } from './callStore.js';

/**
 * Store-level tests, run by Node's own test runner (`npm run test:unit`).
 *
 * The Playwright suite in ../../tests covers calling end to end, but it needs a
 * backend and a live LiveKit SFU, and it cannot easily land a second call inside
 * the two-second window this file is about. Nothing here touches the DOM.
 */

const store = () => useCallStore.getState();

/** Put the store in the state a real connected call leaves behind. */
function fillLiveCallState() {
  store().initiateCall('call-a', 'video', false, 'conv-a', { id: 'peer', name: 'Peer' });
  store().addRemoteParticipant({ id: 'u1', name: 'One', identity: 'u1#dev' });
  store().addPendingInvitees([{ id: 'u2', name: 'Two' }]);
  store().setPeerState('u1', { state: LINK_RECONNECTING, quality: 'poor' });
  store().callConnected();
  useCallStore.setState({
    localStream: { id: 'local' },
    localScreenStream: { id: 'screen' },
    isScreenSharing: true,
    isMuted: true,
    isCameraOn: false,
    isMinimized: true,
    speakerOn: false,
    activeSpeakerIds: ['u1'],
    networkQuality: 'poor',
    localUser: { id: 'me' },
  });
}

describe('callStore', () => {
  beforeEach(() => {
    // A real epoch, not the mock clock's default 0: callConnected keeps an
    // existing `callStartTime` with `||`, which a start time of 0 would defeat.
    mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_700_000_000_000 });
  });

  afterEach(() => {
    store().resetCall();
    mock.timers.reset();
  });

  // The bug: endCall only schedules resetCall two seconds later, and a call
  // starting inside that window cancels the timer. Everything resetCall would
  // have cleared was then inherited by the replacement call.
  for (const [label, startCallB] of [
    ['an outgoing call', () => store().initiateCall('call-b', 'voice', false, 'conv-b')],
    ['an incoming call', () => store().receiveIncomingCall('call-b', { id: 'caller' }, 'voice')],
  ]) {
    it(`inherits nothing from the previous call when ${label} starts inside the ended window`, () => {
      fillLiveCallState();
      store().endCall();
      mock.timers.tick(1000); // still inside the 2s "Call ended" card

      startCallB();

      const s = store();
      assert.equal(s.callId, 'call-b');
      assert.deepEqual(s.remoteParticipants, []);
      assert.deepEqual(s.pendingInvitees, []);
      assert.deepEqual(s.peerStates, {});
      assert.equal(s.localStream, null);
      assert.equal(s.localScreenStream, null);
      assert.equal(s.isScreenSharing, false);
      assert.equal(s.callDuration, 0);
      assert.equal(s.callStartTime, null);
      assert.equal(s.durationInterval, null);
      assert.equal(s.endTimer, null);
      assert.equal(s.isMuted, false);
      assert.equal(s.isMinimized, false);
      assert.equal(s.speakerOn, true);
      assert.deepEqual(s.activeSpeakerIds, []);
      assert.equal(s.networkQuality, 'good');
      assert.equal(s.localUser, null);
      assert.equal(s.mediaLinkState, LINK_OK);
    });
  }

  it('does not let the cancelled teardown timer reset the replacement call', () => {
    fillLiveCallState();
    store().endCall();
    store().receiveIncomingCall('call-b', { id: 'caller' }, 'voice');

    mock.timers.tick(5000); // well past when call A's timer would have fired

    assert.equal(store().callState, 'incoming_ringing');
    assert.equal(store().callId, 'call-b');
  });

  it('times the replacement call from its own connect, not the previous call', () => {
    fillLiveCallState();
    mock.timers.tick(30_000); // 30s on call A's clock
    store().endCall();
    store().initiateCall('call-b', 'voice', false, 'conv-b');

    const startedAt = Date.now();
    store().callConnected();
    mock.timers.tick(3000);

    // One interval, seeded fresh: exactly 3 ticks, and no leftover 30s.
    assert.equal(store().callDuration, 3);
    assert.equal(store().callStartTime, startedAt);
  });

  it('keeps the start time across a reconnect within one call', () => {
    store().initiateCall('call-a', 'voice');
    store().callConnected();
    const startedAt = store().callStartTime;

    mock.timers.tick(5000);
    store().callConnected(); // re-join after a blip

    assert.equal(store().callStartTime, startedAt);
    assert.equal(store().callDuration, 5);
  });

  it('leaves miniPosition alone across calls', () => {
    store().setMiniPosition({ x: 12, y: 34 });
    store().initiateCall('call-a', 'voice');
    store().endCall();
    store().initiateCall('call-b', 'voice');
    assert.deepEqual(store().miniPosition, { x: 12, y: 34 });
    store().resetCall();
    assert.deepEqual(store().miniPosition, { x: 12, y: 34 });
  });
});
