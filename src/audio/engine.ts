import { loadWorklet, PROCESSOR_NAME } from './worklet-loader';

export type PlaybackStatus = 'stopped' | 'playing' | 'paused';

export interface EngineState {
  status:         PlaybackStatus;
  currentTime:    number;
  duration:       number;
  tempo:          number;   // 0.1 – 4.0
  pitchSemitones: number;   // -12 – +12
  pitchCents:     number;   // -100 – +100
  volume:         number;   // 0 – 1.5
  pan:            number;   // -1 – +1
  loopEnabled:    boolean;
  loopStart:      number;
  loopEnd:        number;
}

type TimeListener    = (t: number) => void;
type StatusListener  = (s: PlaybackStatus) => void;
type EndedListener   = () => void;

export class AudioEngine {
  private ctx!:        AudioContext;
  private worklet!:    AudioWorkletNode;
  private gainNode!:   GainNode;
  private panNode!:    StereoPannerNode;

  private _state: EngineState = {
    status:         'stopped',
    currentTime:    0,
    duration:       0,
    tempo:          1.0,
    pitchSemitones: 0,
    pitchCents:     0,
    volume:         1.0,
    pan:            0,
    loopEnabled:    false,
    loopStart:      0,
    loopEnd:        0,
  };

  private sampleRate  = 44100;
  private _onTime:    TimeListener[]   = [];
  private _onStatus:  StatusListener[] = [];
  private _onEnded:   EndedListener[]  = [];

  get state() { return this._state; }

  // ── Initialisation ──────────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.ctx = new AudioContext({ latencyHint: 'playback' });

    await loadWorklet(this.ctx);

    this.worklet = new AudioWorkletNode(this.ctx, PROCESSOR_NAME, {
      numberOfInputs:    0,
      numberOfOutputs:   1,
      outputChannelCount: [2],
    });

    this.panNode  = this.ctx.createStereoPanner();
    this.gainNode = this.ctx.createGain();

    this.worklet.connect(this.panNode);
    this.panNode.connect(this.gainNode);
    this.gainNode.connect(this.ctx.destination);

    this.worklet.port.onmessage = ({ data }) => {
      if (data.type === 'position') {
        const t = data.frame / this.sampleRate;
        this._state.currentTime = t;
        this._onTime.forEach(fn => fn(t));
      } else if (data.type === 'ended') {
        this._state.status = 'stopped';
        this._state.currentTime = 0;
        this._emitStatus();
        this._onEnded.forEach(fn => fn());
      }
    };

    // Resume AudioContext when the page becomes visible (important for Tauri/Android)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') this.ctx.resume();
    });
  }

  // ── Audio loading ────────────────────────────────────────────────────────────

  async loadBuffer(buffer: AudioBuffer): Promise<void> {
    this.sampleRate         = buffer.sampleRate;
    this._state.duration    = buffer.duration;
    this._state.currentTime = 0;
    this._state.loopEnabled = false;
    this._state.loopStart   = 0;
    this._state.loopEnd     = buffer.duration;

    const L = buffer.getChannelData(0);
    const R = buffer.numberOfChannels > 1
      ? buffer.getChannelData(1)
      : buffer.getChannelData(0);

    // Copy into new ArrayBuffers (transfer ownership, keep AudioBuffer intact)
    const leftCopy  = new Float32Array(L).buffer;
    const rightCopy = new Float32Array(R).buffer;

    this.worklet.port.postMessage(
      { type: 'audio', left: leftCopy, right: rightCopy },
      [leftCopy, rightCopy]
    );

    if (this._state.status !== 'stopped') {
      this._state.status = 'stopped';
      this._emitStatus();
    }
  }

  async decodeFile(ab: ArrayBuffer): Promise<AudioBuffer> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return this.ctx.decodeAudioData(ab);
  }

  // ── Transport ────────────────────────────────────────────────────────────────

  play(): void {
    if (!this._state.duration) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.worklet.port.postMessage({ type: 'play' });
    this._state.status = 'playing';
    this._emitStatus();
  }

  pause(): void {
    if (this._state.status !== 'playing') return;
    this.worklet.port.postMessage({ type: 'pause' });
    this._state.status = 'paused';
    this._emitStatus();
  }

  stop(): void {
    this.worklet.port.postMessage({ type: 'pause' });
    this._state.status = 'stopped';
    this.seek(0);
    this._emitStatus();
  }

  togglePlay(): void {
    if (this._state.status === 'playing') this.pause();
    else this.play();
  }

  seek(time: number): void {
    const t = Math.max(0, Math.min(this._state.duration, time));
    this._state.currentTime = t;
    const frame = Math.floor(t * this.sampleRate);
    this.worklet.port.postMessage({ type: 'seek', frame });
    this._onTime.forEach(fn => fn(t));
  }

  skipBy(seconds: number): void {
    this.seek(this._state.currentTime + seconds);
  }

  // ── Parameters ───────────────────────────────────────────────────────────────

  setTempo(tempo: number): void {
    this._state.tempo = Math.max(0.1, Math.min(4.0, tempo));
    this.worklet.port.postMessage({ type: 'tempo', value: this._state.tempo });
  }

  setSpeedPercent(pct: number): void {
    this.setTempo(pct / 100);
  }

  setPitch(semitones: number, cents = 0): void {
    this._state.pitchSemitones = semitones;
    this._state.pitchCents     = cents;
    const totalSemitones = semitones + cents / 100;
    this.worklet.port.postMessage({ type: 'pitch', value: totalSemitones });
  }

  setVolume(v: number): void {
    this._state.volume = Math.max(0, Math.min(1.5, v));
    this.gainNode.gain.setTargetAtTime(this._state.volume, this.ctx.currentTime, 0.01);
  }

  setPan(pan: number): void {
    this._state.pan = Math.max(-1, Math.min(1, pan));
    this.panNode.pan.setTargetAtTime(this._state.pan, this.ctx.currentTime, 0.01);
  }

  // ── Loop ─────────────────────────────────────────────────────────────────────

  setLoop(enabled: boolean, start?: number, end?: number): void {
    if (start !== undefined) this._state.loopStart = start;
    if (end   !== undefined) this._state.loopEnd   = end;
    this._state.loopEnabled = enabled;
    this._pushLoop();
  }

  setLoopStart(t: number): void {
    this._state.loopStart = Math.max(0, Math.min(t, this._state.loopEnd - 0.01));
    this._pushLoop();
  }

  setLoopEnd(t: number): void {
    this._state.loopEnd = Math.min(this._state.duration, Math.max(t, this._state.loopStart + 0.01));
    this._pushLoop();
  }

  toggleLoop(): void {
    this.setLoop(!this._state.loopEnabled);
  }

  private _pushLoop(): void {
    this.worklet.port.postMessage({
      type:       'loop',
      enabled:    this._state.loopEnabled,
      startFrame: Math.floor(this._state.loopStart * this.sampleRate),
      endFrame:   Math.floor(this._state.loopEnd   * this.sampleRate),
    });
  }

  // ── Utility ──────────────────────────────────────────────────────────────────

  getAudioContext(): AudioContext { return this.ctx; }

  onTimeUpdate(fn: TimeListener)   { this._onTime.push(fn); }
  onStatusChange(fn: StatusListener) { this._onStatus.push(fn); }
  onEnded(fn: EndedListener)       { this._onEnded.push(fn); }

  private _emitStatus() {
    this._onStatus.forEach(fn => fn(this._state.status));
  }
}
