export const STANDARD = [40, 45, 50, 55, 59, 64]; // low to high
export interface Note { pitchMidi: number; startTimeSeconds: number; durationSeconds: number; amplitude: number }
export interface Moment { start: number; end: number; notes: number[]; strength: number; shapes: number[][]; choice: number; edited?: boolean }
const NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export function noteName(midi: number): string { return NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1); }
export function chordName(notes: number[]): string {
  const pcs = [...new Set(notes.map(n => n % 12))].sort((a,b) => a-b);
  if (!pcs.length) return 'Rest';
  if (notes.length === 1) return noteName(notes[0]);
  if (pcs.length === 1) return NAMES[pcs[0]] + ' octaves';
  const kinds: [string, number[]][] = [['', [0,4,7]], ['m',[0,3,7]], ['5',[0,7]], ['7',[0,4,7,10]], ['maj7',[0,4,7,11]], ['m7',[0,3,7,10]], ['sus2',[0,2,7]], ['sus4',[0,5,7]], ['dim',[0,3,6]]];
  for (const root of pcs) for (const [suffix, intervals] of kinds) {
    if (intervals.length === pcs.length && intervals.every(i => pcs.includes((root+i)%12))) {
      const bass = Math.min(...notes)%12;
      return NAMES[root]+suffix+(bass === root ? '' : '/'+NAMES[bass]);
    }
  }
  return pcs.map(n => NAMES[n]).join(' · ');
}

// Exact pitch assignments: one note per string. Never add chord tones to
// make an uncertain detection look like a familiar chord.
export function fingerings(notes: number[], tuning = STANDARD, capo = 0, previous?: number[]): number[][] {
  const pitches = [...new Set(notes)].sort((a,b)=>a-b);
  if (pitches.length > 6) return [];
  const candidates: { frets: number[]; cost: number }[] = [];
  const visit = (index: number, frets: number[]) => {
    if (index === pitches.length) {
      const pressed = frets.filter(f=>f>0);
      const span = pressed.length ? Math.max(...pressed)-Math.min(...pressed) : 0;
      if (span > 5) return;
      const position = pressed.length ? Math.min(...pressed) : 0;
      const fingers = new Set(pressed).size;
      if (fingers > 4) return;
      const movement = previous ? frets.reduce((s,f,i)=>s+(f>=0 && previous[i]>=0 ? Math.abs(f-previous[i]) : 0),0)*.15 : 0;
      const openBonus = frets.filter(f=>f===0).length * .35;
      candidates.push({frets:[...frets],cost: span*2+position*.25+fingers*.4+movement-openBonus});
      return;
    }
    for (let string=0;string<6;string++) {
      const fret = pitches[index]-tuning[string]-capo;
      if (frets[string]===-1 && fret>=0 && fret<=24-capo) {
        frets[string]=fret; visit(index+1,frets); frets[string]=-1;
      }
    }
  };
  visit(0, Array(6).fill(-1));
  return candidates.sort((a,b)=>a.cost-b.cost).slice(0,8).map(c=>c.frets);
}

export function groupNotes(raw: Note[], offset: number, duration: number, tuning = STANDARD, capo = 0): Moment[] {
  const notes = raw.filter(n => n.durationSeconds >= .08 && n.amplitude >= .15 && n.pitchMidi >= Math.min(...tuning)+capo && n.pitchMidi <= Math.max(...tuning)+24)
    .map(n=>({...n,startTimeSeconds:Math.max(0,n.startTimeSeconds),durationSeconds:Math.min(n.durationSeconds,duration-Math.max(0,n.startTimeSeconds))}))
    .filter(n=>n.durationSeconds>0).sort((a,b)=>a.startTimeSeconds-b.startTimeSeconds);
  // Group strummed attacks within 60ms, retaining earlier ringing notes.
  const attacks: number[] = [];
  for (const n of notes) if (!attacks.length || n.startTimeSeconds-attacks[attacks.length-1]>.06) attacks.push(n.startTimeSeconds);
  const moments: Moment[]=[];
  for (let i=0;i<attacks.length;i++) {
    const start=attacks[i];
    const active=notes.filter(n=>n.startTimeSeconds<=start+.06 && n.startTimeSeconds+n.durationSeconds>start+.04);
    const ranked=[...active].sort((a,b)=>b.amplitude-a.amplitude);
    const pitches=[...new Set(ranked.map(n=>n.pitchMidi))].slice(0,6).sort((a,b)=>a-b);
    if (!pitches.length) continue;
    const end=Math.min(duration, attacks[i+1] ?? duration, Math.max(...active.map(n=>n.startTimeSeconds+n.durationSeconds)));
    const previous=moments[moments.length-1]?.shapes[0];
    moments.push({start:offset+start,end:offset+end,notes:pitches,strength:active.reduce((s,n)=>s+n.amplitude,0)/active.length,shapes:fingerings(pitches,tuning,capo,previous),choice:0});
  }
  return moments;
}
export function tabText(moments: Moment[], tuning: number[], capo: number): string {
  const lines = [`LoopLab — approximate guitar transcription`, `Tuning (low to high): ${tuning.map(noteName).join(' ')} | Capo: ${capo}`, 'Frets are relative to capo. Each column is an attack, not a rhythmic subdivision.', ''];
  for(let block=0;block<moments.length;block+=12) {
    const part=moments.slice(block,block+12);
    lines.push('Time '+part.map(m=>m.start.toFixed(2).padStart(7)).join(''));
    for(let s=5;s>=0;s--) lines.push(noteName(tuning[s]).padEnd(4)+'|'+part.map(m=>String(m.shapes[m.choice]?.[s] ?? '?').replace('-1','x').padStart(7,'-')).join('')+'|');
    lines.push('');
  }
  return lines.join('\n');
}
