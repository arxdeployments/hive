import { isSoundMuted } from '../utils/notificationPrefs';

/**
 * Call sound manager using Web Audio API.
 * Respects user's notification sound settings.
 */
class CallSoundManager {
  constructor() {
    this._ctx = null;
    this._activeOscillators = [];
    this._ringtoneInterval = null;
  }

  _getContext() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return this._ctx;
  }

  _isMuted() {
    return isSoundMuted();
  }

  _playTone(freq, duration, volume = 0.1) {
    try {
      const ctx = this._getContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
      this._activeOscillators.push(osc);
      // Drop it again when it finishes. `stopAll` was the only thing that ever
      // emptied this array, which is survivable for call tones — a call has a
      // bounded number of them — but playMessage() below runs once per inbound
      // message, and a long session would otherwise retain an oscillator node
      // for every message ever received.
      osc.onended = () => {
        const i = this._activeOscillators.indexOf(osc);
        if (i !== -1) this._activeOscillators.splice(i, 1);
      };
    } catch {}
  }

  /**
   * The inbound-message tone.
   *
   * Lives here rather than in websocket.js, which had its own copy that
   * constructed a brand new AudioContext for every single message and never
   * closed one. Browsers cap concurrent contexts — Chrome at six — so after the
   * sixth message the constructor threw, the throw was swallowed by that
   * method's own catch, and message tones simply stopped for the rest of the
   * session while each abandoned context kept its audio thread alive.
   */
  playMessage() {
    if (this._isMuted()) return;
    this._playTone(800, 0.3, 0.1);
  }

  playRingtone() {
    // Always play ringtone (safety - even if sounds muted)
    this.stopAll();
    const play = () => {
      this._playTone(800, 0.15, 0.15);
      setTimeout(() => this._playTone(600, 0.15, 0.15), 200);
      setTimeout(() => this._playTone(800, 0.15, 0.15), 400);
    };
    play();
    this._ringtoneInterval = setInterval(play, 2000);
  }

  playRingback() {
    if (this._isMuted()) return;
    this.stopAll();
    const play = () => {
      this._playTone(440, 0.5, 0.08);
      setTimeout(() => this._playTone(440, 0.5, 0.08), 600);
    };
    play();
    this._ringtoneInterval = setInterval(play, 3000);
  }

  playConnected() {
    if (this._isMuted()) return;
    this._playTone(880, 0.15, 0.1);
    setTimeout(() => this._playTone(1100, 0.2, 0.1), 150);
  }

  playEnded() {
    if (this._isMuted()) return;
    this._playTone(600, 0.15, 0.08);
    setTimeout(() => this._playTone(400, 0.25, 0.08), 150);
  }

  playParticipantJoined() {
    if (this._isMuted()) return;
    this._playTone(700, 0.1, 0.06);
    setTimeout(() => this._playTone(900, 0.15, 0.06), 100);
  }

  playParticipantLeft() {
    if (this._isMuted()) return;
    this._playTone(600, 0.1, 0.06);
    setTimeout(() => this._playTone(400, 0.15, 0.06), 100);
  }

  stopAll() {
    if (this._ringtoneInterval) {
      clearInterval(this._ringtoneInterval);
      this._ringtoneInterval = null;
    }
    this._activeOscillators.forEach(osc => {
      try { osc.stop(); } catch {}
    });
    this._activeOscillators = [];
  }
}

const callSounds = new CallSoundManager();
export default callSounds;
