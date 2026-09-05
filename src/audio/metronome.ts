// Web Audio clock-based metronome — schedules beats into the future so timing
// stays tight even under JavaScript GC or main-thread load.

export class Metronome {
  private ctx:          AudioContext;
  private bpm          = 120;
  private beatsPerBar  = 4;
  private volume       = 0.8;
  private tempo        = 1.0;   // mirrors AudioEngine speed
  private running      = false;
  private nextBeatTime = 0;
  private beatIndex    = 0;
  private timerId:     ReturnType<typeof setTimeout> | null = null;

  // Look-ahead window and scheduler interval in seconds / ms
  private readonly LOOKAHEAD   = 0.1;   // seconds
  private readonly SCHEDULE_MS = 25;    // ms

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  start(): void {
    if (this.running) return;
    this.running      = true;
    this.nextBeatTime = this.ctx.currentTime + 0.05;
    this.beatIndex    = 0;
    this._schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timerId !== null) clearTimeout(this.timerId);
    this.timerId = null;
  }

  toggle(): boolean {
    if (this.running) { this.stop();  return false; }
    else              { this.start(); return true; }
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(20, Math.min(300, bpm));
  }

  setBeatsPerBar(n: number): void {
    this.beatsPerBar = n;
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
  }

  /** Keep metronome in sync with playback tempo (speed change). */
  setTempo(tempo: number): void {
    this.tempo = tempo;
  }

  isRunning(): boolean { return this.running; }

  private _schedule(): void {
    if (!this.running) return;

    const beatInterval = (60 / this.bpm) / this.tempo;
    const ahead        = this.ctx.currentTime + this.LOOKAHEAD;

    while (this.nextBeatTime < ahead) {
      this._scheduleBeat(this.nextBeatTime, this.beatIndex);
      this.nextBeatTime += beatInterval;
      this.beatIndex     = (this.beatIndex + 1) % this.beatsPerBar;
    }

    this.timerId = setTimeout(() => this._schedule(), this.SCHEDULE_MS);
  }

  private _scheduleBeat(time: number, beat: number): void {
    const isAccent = beat === 0;
    const freq     = isAccent ? 1500 : 880;
    const gain     = isAccent ? this.volume : this.volume * 0.6;

    // Short sine-wave click
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.connect(env);
    env.connect(this.ctx.destination);

    osc.type      = 'sine';
    osc.frequency.value = freq;
    env.gain.setValueAtTime(gain, time);
    env.gain.exponentialRampToValueAtTime(0.0001, time + 0.03);

    osc.start(time);
    osc.stop(time + 0.04);
    osc.onended = () => { osc.disconnect(); env.disconnect(); };
  }
}
