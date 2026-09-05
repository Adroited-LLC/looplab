import type { Note } from './guitar';
export async function preparePassage(buffer: AudioBuffer, start: number, end: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.max(1, Math.ceil((end-start)*22050)), 22050);
  const source = ctx.createBufferSource();
  source.buffer=buffer;
  source.connect(ctx.destination);
  source.start(0,start,end-start);
  return (await ctx.startRendering()).getChannelData(0);
}
export function analyze(samples: Float32Array, sensitivity: number, signal: AbortSignal, progress: (p:number)=>void): Promise<Note[]> {
  return new Promise((resolve,reject)=> {
    if(signal.aborted) { reject(new DOMException('Cancelled','AbortError')); return; }
    const worker=new Worker(new URL('./worker.ts',import.meta.url),{type:'module'});
    const cleanup=()=> {worker.terminate();signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(new DOMException('Cancelled','AbortError'));};
    signal.addEventListener('abort',abort,{once:true});
    worker.onerror=()=>{cleanup();reject(new Error('Could not start the transcriber. Try reopening the app.'));};
    worker.onmessage=({data})=>{
      if(data.type==='progress') progress(data.progress);
      else {cleanup();if(data.type==='result') resolve(data.notes);else reject(new Error(data.message));}
    };
    worker.postMessage({samples,sensitivity,modelUrl:new URL(`${import.meta.env.BASE_URL}models/basic-pitch/model.json`,location.href).href},[samples.buffer]);
  });
}
