import type { Note } from './guitar';
export const PITCH_CLASSES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
export const SCALES = {
  minorPentatonic: { name: 'Minor pentatonic', intervals: [0,3,5,7,10] },
  naturalMinor: { name: 'Natural minor', intervals: [0,2,3,5,7,8,10] },
  minorBlues: { name: 'Minor blues', intervals: [0,3,5,6,7,10] },
  majorPentatonic: { name: 'Major pentatonic', intervals: [0,2,4,7,9] },
  major: { name: 'Major', intervals: [0,2,4,5,7,9,11] },
} as const;
export type ScaleName = keyof typeof SCALES;
export interface KeyCandidate { root: number; mode: 'major'|'minor'; score: number }
export interface KeyEstimate { candidates: KeyCandidate[]; tentative: boolean }
const pc = (n:number) => ((n%12)+12)%12;
export function scaleNotes(root:number,scale:ScaleName):number[] {return SCALES[scale].intervals.map(n=>pc(n+root));}
export function keyName(key:KeyCandidate):string {return `${PITCH_CLASSES[key.root]} ${key.mode}`;}

// Krumhansl–Kessler pitch-class profiles, correlated with duration × note
// strength. These are generic musical weights, not a song database.
// Reference: music21.org/music21docs/moduleReference/moduleAnalysisDiscrete.html
const PROFILES={
  major:[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88],
  minor:[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17],
};
export function estimateKey(notes:Note[], duration:number):KeyEstimate|null {
  const histogram=Array<number>(12).fill(0);
  for(const note of notes){
    if(!Number.isFinite(note.pitchMidi)||!Number.isFinite(note.amplitude)||!Number.isFinite(note.startTimeSeconds)||!Number.isFinite(note.durationSeconds)||note.amplitude<.15||note.durationSeconds<.08)continue;
    const start=Math.max(0,note.startTimeSeconds),end=Math.min(duration,note.startTimeSeconds+note.durationSeconds);
    if(end<=start)continue;
    histogram[pc(Math.round(note.pitchMidi))]+=(end-start)*Math.min(1,note.amplitude);
  }
  const sum=histogram.reduce((s,n)=>s+n,0),distinct=histogram.filter(n=>n>sum*.015).length;
  if(sum<.5||distinct<3)return null;
  const mean=sum/12,variance=histogram.reduce((s,n)=>s+(n-mean)**2,0);
  if(variance<1e-9)return null;
  const candidates:KeyCandidate[]=[];
  for(const mode of ['major','minor'] as const){
    const profile=PROFILES[mode],average=profile.reduce((s,n)=>s+n,0)/12;
    const norm=Math.sqrt(variance*profile.reduce((s,n)=>s+(n-average)**2,0));
    for(let root=0;root<12;root++){
      const score=histogram.reduce((s,n,i)=>s+(n-mean)*(profile[pc(i-root)]-average),0)/norm;
      candidates.push({root,mode,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  if(candidates[0].score<.35)return null;
  return {candidates:candidates.slice(0,3),tentative:distinct<5||candidates[0].score<.7||candidates[0].score-candidates[1].score<.1};
}

export interface ScalePosition { string:number; fret:number; midi:number; name:string; inScale:boolean; root:boolean; active:boolean }
export function fretboardPositions(tuning:number[],capo:number,root:number,scale:ScaleName,startFret:number,endFret:number,active:number[]):ScalePosition[]{
  const allowed=scaleNotes(root,scale),playing=new Set(active),positions:ScalePosition[]=[];
  for(let string=0;string<tuning.length;string++)for(let fret=Math.max(0,startFret);fret<=Math.min(24-capo,endFret);fret++){
    const midi=tuning[string]+capo+fret;
    positions.push({string,fret,midi,name:PITCH_CLASSES[pc(midi)],inScale:allowed.includes(pc(midi)),root:pc(midi)===pc(root),active:playing.has(midi)});
  }
  return positions;
}
export function activePitches(notes:Note[],time:number,duration:number):number[]{
  if(time<0||time>=duration)return [];
  return [...new Set(notes.filter(n=>n.amplitude>=.15&&n.startTimeSeconds<=time&&time<n.startTimeSeconds+n.durationSeconds).map(n=>n.pitchMidi))].sort((a,b)=>a-b);
}

// Prefer the smallest matching vocabulary, adding characteristic tones only
// when they carry sustained evidence rather than a single faint detection.
export function estimateScale(notes:Note[],duration:number,key:KeyCandidate):ScaleName {
  const weights=Array<number>(12).fill(0);
  for(const n of notes){
    if(!Number.isFinite(n.pitchMidi)||!Number.isFinite(n.amplitude)||!Number.isFinite(n.startTimeSeconds)||!Number.isFinite(n.durationSeconds)||n.amplitude<.15||n.durationSeconds<.08)continue;
    const length=Math.max(0,Math.min(duration,n.startTimeSeconds+n.durationSeconds)-Math.max(0,n.startTimeSeconds));
    weights[pc(Math.round(n.pitchMidi)-key.root)]+=length*Math.min(1,n.amplitude);
  }
  const total=weights.reduce((a,b)=>a+b,0);
  const substantial=(interval:number)=>weights[interval]>Math.max(.15,total*.025);
  if(key.mode==='major')return substantial(5)||substantial(11)?'major':'majorPentatonic';
  if(substantial(2)||substantial(8))return 'naturalMinor';
  return substantial(6)?'minorBlues':'minorPentatonic';
}
