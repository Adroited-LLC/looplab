import type { Moment, Note } from '../transcription/guitar';
import { SCALES, type KeyEstimate, type ScaleName } from '../transcription/scales';
export interface SavedScale {
  root:number; scale:ScaleName; follow:boolean; frets:number;
  notes:Note[]; offset:number; duration:number; estimate:KeyEstimate|null;
}
export interface AnalysisProject {
  format:'looplab'; version:1; filename:string; audioDuration:number;
  tuning:number[]; capo:number; sensitivity:string;
  moments:Moment[]; resultRange:[number,number]; scale:SavedScale;
  complete:boolean; view:'tab'|'scale'; selected:number; speed:number;
}
const MAGIC='LOOPLAB1';
const MAX_HEADER=64*1024*1024;
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(`Invalid project: ${message}`);}
const num=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max;
const integer=(v:unknown,min:number,max:number)=>num(v,min,max)&&Number.isInteger(v);
export function validateProject(p:any):asserts p is AnalysisProject {
  check(p&&p.format==='looplab'&&p.version===1,'unsupported format or version');
  check(typeof p.filename==='string'&&p.filename.length>0&&p.filename.length<=1024,'recording name');
  check(num(p.audioDuration,.01,86400),'audio duration');
  check(Array.isArray(p.tuning)&&['40,45,50,55,59,64','38,45,50,55,59,64'].includes(p.tuning.join()),'tuning');
  check(integer(p.capo,0,12)&&['0.4','0.25','0.55'].includes(p.sensitivity),'analysis settings');
  check(typeof p.complete==='boolean'&&['tab','scale'].includes(p.view)&&num(p.speed,10,200),'practice settings');
  check(Array.isArray(p.resultRange)&&p.resultRange.length===2&&num(p.resultRange[0],0,p.audioDuration)&&num(p.resultRange[1],p.resultRange[0],p.audioDuration),'tab range');
  const s=p.scale;
  check(s&&integer(s.root,0,11)&&Object.prototype.hasOwnProperty.call(SCALES,s.scale)&&typeof s.follow==='boolean'&&[0,12].includes(s.frets),'scale settings');
  check(num(s.offset,0,p.audioDuration)&&num(s.duration,0,p.audioDuration-s.offset+.001),'scale range');
  check(Array.isArray(s.notes)&&s.notes.length<=200000,'note count');
  for(const n of s.notes)check(n&&integer(n.pitchMidi,0,127)&&num(n.startTimeSeconds,0,s.duration)&&num(n.durationSeconds,0,s.duration-n.startTimeSeconds+.001)&&num(n.amplitude,0,1),'detected note');
  if(s.estimate!==null){
    check(s.estimate&&typeof s.estimate.tentative==='boolean'&&Array.isArray(s.estimate.candidates)&&s.estimate.candidates.length>=1&&s.estimate.candidates.length<=3,'key estimate');
    for(const k of s.estimate.candidates)check(k&&integer(k.root,0,11)&&['major','minor'].includes(k.mode)&&num(k.score,-1,1),'key candidate');
  }
  check(Array.isArray(p.moments)&&p.moments.length<=100000&&integer(p.selected,0,Math.max(0,p.moments.length-1)),'tab count or selection');
  let last=-1;
  for(const m of p.moments){
    check(m&&num(m.start,p.resultRange[0],p.resultRange[1])&&m.start>=last&&num(m.end,m.start,p.resultRange[1])&&num(m.strength,0,1),'tab timing');last=m.start;
    check(Array.isArray(m.notes)&&m.notes.length<=6&&m.notes.every((n:unknown)=>integer(n,0,127)),'tab pitches');
    check(Array.isArray(m.shapes)&&m.shapes.length<=9&&integer(m.choice,0,Math.max(0,m.shapes.length-1))&&(m.edited===undefined||typeof m.edited==='boolean'),'shape selection');
    for(const shape of m.shapes){
      check(Array.isArray(shape)&&shape.length===6&&shape.every((f:unknown)=>integer(f,-1,24-p.capo)),'frets');
      const pitches=[...new Set(shape.flatMap((f:number,i:number)=>f<0?[]:[p.tuning[i]+p.capo+f]))].sort((a:any,b:any)=>a-b);
      check(pitches.join()===[...new Set(m.notes)].sort((a:any,b:any)=>a-b).join(),'shape pitches do not match tab');
    }
  }
  check(!p.complete||(p.resultRange[0]===0&&Math.abs(p.resultRange[1]-p.audioDuration)<.001&&s.offset===0&&Math.abs(s.duration-p.audioDuration)<.001),'incomplete coverage marked complete');
}
async function digest(data:ArrayBuffer){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function encodeProject(project:AnalysisProject,audio:ArrayBuffer):Promise<Blob>{
  validateProject(project);check(audio.byteLength>0,'missing audio');
  const header=new TextEncoder().encode(JSON.stringify({...project,audioBytes:audio.byteLength,audioHash:await digest(audio)}));
  check(header.length<=MAX_HEADER,'analysis is too large');
  const prefix=new Uint8Array(12);prefix.set(new TextEncoder().encode(MAGIC));new DataView(prefix.buffer).setUint32(8,header.length,true);
  return new Blob([prefix,header,audio],{type:'application/octet-stream'});
}
export async function decodeProject(data:ArrayBuffer):Promise<{project:AnalysisProject;audio:ArrayBuffer}>{
  check(data.byteLength>=12,'file is truncated');
  check(new TextDecoder().decode(data.slice(0,8))===MAGIC,'not a LoopLab project');
  const size=new DataView(data).getUint32(8,true);check(size>0&&size<=MAX_HEADER&&size+12<data.byteLength,'header length');
  let project:any;try{project=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data.slice(12,12+size)));}catch{throw new Error('Invalid project: unreadable metadata');}
  validateProject(project);
  const audio=data.slice(12+size);
  check((project as any).audioBytes===audio.byteLength,'audio is truncated');
  check((project as any).audioHash===await digest(audio),'audio checksum mismatch');
  return {project,audio};
}
