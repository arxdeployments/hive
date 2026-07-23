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
    return localStorage.getItem('rxhive_notif_sound') === 'false';
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
    } catch {}
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
