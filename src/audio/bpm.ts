import { analyze, guess } from 'web-audio-beat-detector';

export interface BpmResult {
  bpm:    number;
  offset: number;  // seconds to first beat
}

/** Analyse an AudioBuffer for tempo. Returns BPM + first-beat offset.
 *  Tries the web-audio-beat-detector library first (accurate but needs Workers),
 *  then falls back to a self-contained energy-autocorrelation detector. */
export async function detectBpm(buffer: AudioBuffer): Promise<BpmResult> {
  try {
    const result = await guess(buffer);
    if (result.bpm > 0) return { bpm: Math.round(result.bpm), offset: result.offset };
    throw new Error('invalid');
  } catch {
    try {
      const bpm = await analyze(buffer);
      if (bpm > 0) return { bpm: Math.round(bpm), offset: 0 };
      throw new Error('invalid');
    } catch {
      return { bpm: _detectBpmFallback(buffer), offset: 0 };
    }
  }
}

/** Energy-autocorrelation BPM detector — no Workers, runs on main thread.
 *  Accurate to ±2 BPM for typical music (60–200 BPM range). */
function _detectBpmFallback(buffer: AudioBuffer): number {
  const sr   = buffer.sampleRate;
  const ch0  = buffer.getChannelData(0);

  // ── 1. Compute RMS energy in 10ms frames ─────────────────────────────────
  const frameSize  = Math.round(sr * 0.01);       // 10ms
  const numFrames  = Math.floor(ch0.length / frameSize);
  const energy     = new Float32Array(numFrames);

  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const off = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const s = ch0[off + i];
      sum += s * s;
    }
    energy[f] = Math.sqrt(sum / frameSize);
  }

  // ── 2. Autocorrelation over the BPM range 60–200 ─────────────────────────
  //   period in frames: frameRate = sr/frameSize = 100 fps
  const fps        = sr / frameSize;
  const minPeriod  = Math.round(fps * 60 / 200);   // 200 BPM
  const maxPeriod  = Math.round(fps * 60 / 60);     // 60 BPM
  // Use at most 30 seconds of audio for speed
  const N          = Math.min(numFrames, Math.round(fps * 30));

  // Precompute mean and variance for normalisation
  let mean = 0;
  for (let i = 0; i < N; i++) mean += energy[i];
  mean /= N;
  let variance = 0;
  for (let i = 0; i < N; i++) { const d = energy[i] - mean; variance += d * d; }

  if (variance < 1e-10) return 120; // silent / no dynamics

  let bestCorr   = -Infinity;
  let bestPeriod = minPeriod;

  for (let p = minPeriod; p <= maxPeriod; p++) {
    let corr = 0;
    const count = N - p;
    for (let i = 0; i < count; i++) {
      corr += (energy[i] - mean) * (energy[i + p] - mean);
    }
    corr /= count * variance;   // normalised to [-1, 1]

    // Prefer harmonically consistent periods (reward multiples)
    const halfP = Math.round(p / 2);
    if (halfP >= minPeriod) {
      let halfCorr = 0;
      const hCount = N - halfP;
      for (let i = 0; i < hCount; i++) {
        halfCorr += (energy[i] - mean) * (energy[i + halfP] - mean);
      }
      halfCorr /= hCount * variance;
      corr = corr * 0.7 + halfCorr * 0.3;
    }

    if (corr > bestCorr) {
      bestCorr   = corr;
      bestPeriod = p;
    }
  }

  const raw = fps * 60 / bestPeriod;

  // Normalise into 80–160 BPM by halving/doubling
  let bpm = raw;
  while (bpm < 80)  bpm *= 2;
  while (bpm > 160) bpm /= 2;

  return Math.round(bpm);
}
