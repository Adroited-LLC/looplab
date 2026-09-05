// Loads the SoundTouch AudioWorklet processor as a Blob URL.
// The SoundTouch ES-module source is imported as raw text, stripped of its
// export statement (so it works as a classic script), and combined with the
// inline processor code before being registered.

import soundtouchSrc from './soundtouch-dist.js?raw';

const PROCESSOR_NAME = 'looplab-processor';

const processorCode = /* js */ `
// ─── AudioWorkletProcessor ────────────────────────────────────────────────────
class LoopLabProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this._st = new SoundTouch();
    this._st.tempo = 1.0;
    this._st.pitch = 1.0;
    this._st.stretch.setParameters(sampleRate, 0, 0, 8);
    this._tempo = 1;
    this._position = 0;
    this._finished = false;

    // Audio buffer (set via postMessage)
    this._dataL = null;   // Float32Array left channel
    this._dataR = null;   // Float32Array right channel
    this._totalFrames = 0;

    // Playback state
    this._playing   = false;
    this._readPos   = 0;     // current position in original frames
    this._loopOn    = false;
    this._loopStart = 0;     // frames
    this._loopEnd   = 0;     // frames

    // Reused buffers
    this._interleavedIn  = null;
    this._interleavedOut = null;
    this._chunkSize      = 512;

    // Position report throttle
    this._reportCount    = 0;
    this._reportInterval = 1024; // ~23 ms at 44100 Hz

    this.port.onmessage = ({ data }) => {
      switch (data.type) {
        case 'audio':
          this._dataL      = new Float32Array(data.left);
          this._dataR      = new Float32Array(data.right);
          this._totalFrames = this._dataL.length;
          this._playing    = false;
          this._loopOn     = false;
          this._loopStart  = 0;
          this._loopEnd    = this._totalFrames;
          this._reset(0);
          break;
        case 'play':
          if (this._finished) this._reset(0);
          this._playing = this._totalFrames > 0;
          break;
        case 'pause':
          this._playing = false;
          break;
        case 'seek':
          this._reset(data.frame);
          break;
        case 'tempo':
          this._tempo = Math.max(0.1, Math.min(4.0, data.value));
          this._st.tempo = this._tempo;
          this._reset(this._position);
          break;
        case 'pitch':
          this._st.pitchSemitones = data.value;
          this._reset(this._position);
          break;
        case 'loop':
          this._loopStart = Math.max(0, Math.min(this._totalFrames, Math.floor(data.startFrame)));
          this._loopEnd   = Math.max(0, Math.min(this._totalFrames, Math.floor(data.endFrame)));
          this._loopOn    = Boolean(data.enabled) && this._loopEnd > this._loopStart;
          this._reset(this._loopOn && this._position >= this._loopEnd
            ? this._loopStart : this._position);
          break;
      }
    };
  }

  _reset(frame) {
    this._position = Math.max(0, Math.min(this._totalFrames, frame));
    this._readPos = Math.floor(this._position);
    this._finished = false;
    this._reportCount = 0;
    this._st.clear();
  }

  // Keep feeding through loop boundaries. At EOF, silence supplies the
  // lookahead SoundTouch needs to release the final real samples.
  _feedChunk() {
    if (!this._interleavedIn) {
      this._interleavedIn = new Float32Array(this._chunkSize * 2);
    }
    const end = this._loopOn ? this._loopEnd : this._totalFrames;
    const fade = this._loopOn
      ? Math.min(Math.round(sampleRate * 0.003), Math.floor((end - this._loopStart) / 2))
      : 0;
    for (let i = 0; i < this._chunkSize; i++) {
      if (this._loopOn && this._readPos >= end) this._readPos = this._loopStart;
      let left = 0;
      let right = 0;
      if (this._readPos < end) {
        // A short fade at each selected edge suppresses hard-cut clicks
        // without shortening the loop or discarding the stretch buffers.
        let gain = 1;
        if (fade > 0) {
          gain = Math.min(1, (end - 1 - this._readPos) / fade);
          if (this._readPos >= this._loopStart) {
            gain = Math.min(gain, (this._readPos - this._loopStart) / fade);
          }
        }
        left = this._dataL[this._readPos] * gain;
        right = this._dataR[this._readPos] * gain;
        this._readPos++;
      }
      this._interleavedIn[i * 2] = left;
      this._interleavedIn[i * 2 + 1] = right;
    }
    this._st.inputBuffer.putSamples(this._interleavedIn, 0, this._chunkSize);
    this._st.process();
  }

  process(_inputs, outputs) {
    const outL = outputs[0]?.[0];
    const outR = outputs[0]?.[1];
    if (!outL) return true;

    const n = outL.length; // 128

    if (!this._playing || !this._dataL) {
      outL.fill(0);
      if (outR) outR.fill(0);
      return true;
    }

    // Fill SoundTouch output buffer until we have enough
    let safety = 0;
    while (this._st.outputBuffer.frameCount < n && safety++ < 200) {
      this._feedChunk();
      if (!this._playing) break;
    }

    const available = this._st.outputBuffer.frameCount;
    const remaining = this._loopOn ? n
      : Math.max(0, Math.ceil((this._totalFrames - this._position) / this._tempo - 1e-7));
    const toRead = Math.min(available, n, remaining);

    if (toRead > 0) {
      if (!this._interleavedOut || this._interleavedOut.length !== toRead * 2) {
        this._interleavedOut = new Float32Array(toRead * 2);
      }
      this._st.outputBuffer.receiveSamples(this._interleavedOut, toRead);
      for (let i = 0; i < toRead; i++) {
        outL[i] = this._interleavedOut[i * 2];
        if (outR) outR[i] = this._interleavedOut[i * 2 + 1];
      }
    }
    for (let i = toRead; i < n; i++) {
      outL[i] = 0;
      if (outR) outR[i] = 0;
    }

    // Track samples heard, not the processor's lookahead input cursor.
    this._position += toRead * this._tempo;
    if (this._loopOn && this._position >= this._loopEnd) {
      this._position = this._loopStart +
        (this._position - this._loopEnd) % (this._loopEnd - this._loopStart);
    }
    if (!this._loopOn && this._position >= this._totalFrames - 1e-7) {
      this._position = this._totalFrames;
      this._playing = false;
      this._finished = true;
      this.port.postMessage({ type: 'position', frame: this._position });
      this.port.postMessage({ type: 'ended' });
      return true;
    }

    // Report position
    this._reportCount += n;
    if (this._reportCount >= this._reportInterval) {
      this._reportCount = 0;
      this.port.postMessage({ type: 'position', frame: this._position });
    }

    return true;
  }
}

registerProcessor('${PROCESSOR_NAME}', LoopLabProcessor);
`;

let _loaded = false;

export async function loadWorklet(ctx: AudioContext): Promise<void> {
  if (_loaded) return;

  // Strip the ES module export statement — classes are still in scope
  const stripped = soundtouchSrc.replace(
    /^export\s*\{[^}]+\};\s*$/m,
    '// exports removed for worklet'
  );

  const fullCode = stripped + '\n' + processorCode;
  const blob = new Blob([fullCode], { type: 'application/javascript' });
  const url  = URL.createObjectURL(blob);

  try {
    await ctx.audioWorklet.addModule(url);
    _loaded = true;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export { PROCESSOR_NAME };
