import { BasicPitch, noteFramesToTime, outputToNotesPoly } from '@spotify/basic-pitch';
import * as tf from '@tensorflow/tfjs';

self.onmessage = async ({ data }: MessageEvent<{ samples: Float32Array; modelUrl: string; sensitivity: number }>) => {
  try {
    await tf.setBackend('cpu');
    await tf.ready();
    const model = new BasicPitch(data.modelUrl);
    const frames: number[][] = [], onsets: number[][] = [];
    await model.evaluateModel(data.samples,
      (f, o) => { frames.push(...f); onsets.push(...o); },
      progress => self.postMessage({ type: 'progress', progress }));
    const notes = noteFramesToTime(outputToNotesPoly(frames, onsets, data.sensitivity, data.sensitivity, 7));
    self.postMessage({ type: 'result', notes });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
