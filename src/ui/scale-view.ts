import type { SavedScale } from '../project/file';
import { noteName, STANDARD, type Note } from '../transcription/guitar';
import { activePitches, estimateKey, estimateScale, fretboardPositions, keyName, PITCH_CLASSES, SCALES, scaleNotes, type KeyEstimate, type ScaleName } from '../transcription/scales';
import { enhanceSelects } from './dark-select';
export class ScaleView {
  private root=4;
  private scale:ScaleName='minorPentatonic';
  private follow=true;
  private estimate:KeyEstimate|null=null;
  private notes:Note[]=[];
  private offset=0;
  private duration=0;
  private tuning=[...STANDARD];
  private capo=0;
  private active:number[]=[];
  private coverage="";
  constructor(private host:HTMLElement){
    host.innerHTML=`<div class="scale-controls">
      <label>Root<select name="scale-root">${PITCH_CLASSES.map((n,i)=>`<option value="${i}" ${i===4?'selected':''}>${n}</option>`).join('')}</select></label>
      <label>Scale<select name="scale-family">${Object.entries(SCALES).map(([key,value])=>`<option value="${key}">${value.name}</option>`).join('')}</select></label>
      <label>Frets<select name="scale-frets"><option value="0">0–12</option><option value="12">12–24</option></select></label>
      <button class="btn" data-use-key disabled>Use estimated key</button>
    </div>
    <p class="key-estimate"></p>
    <div class="scale-heading"><h3></h3><p class="scale-note-list"></p></div>
    <div class="scale-neck" aria-label="Scale fretboard"></div>
    <div class="scale-legend"><span class="legend-root">Root</span><span class="legend-scale">Scale note</span><span class="legend-active">Detected note</span><span class="legend-outside">Detected outside scale</span></div>
    <p class="scale-playing"></p>
    <p class="transcribe-help">Dots show every available position, not a prescribed fingering. Frets are relative to the capo; high string is on top. Outside-scale notes are part of the music, not necessarily mistakes.</p>`;
    this.field('scale-root').addEventListener('change',()=>{this.root=Number(this.field('scale-root').value);this.follow=false;this.draw();});
    this.field('scale-family').addEventListener('change',()=>{this.scale=this.field('scale-family').value as ScaleName;this.follow=false;this.draw();});
    this.field('scale-frets').addEventListener('change',()=>this.draw());
    host.querySelector('[data-use-key]')!.addEventListener('click',()=>{this.follow=true;this.applyEstimate();this.draw();});
    enhanceSelects(host);this.draw();
  }
  private field(name:string){return this.host.querySelector<HTMLSelectElement>(`select[name="${name}"]`)!;}
  setTuning(tuning:number[],capo:number){this.tuning=[...tuning];this.capo=capo;this.draw();}
  startSong(){this.follow=true;this.coverage="";this.clear();}
  setCoverage(text:string){this.coverage=text;this.draw();}
  clear(){this.coverage="";this.notes=[];this.estimate=null;this.offset=0;this.duration=0;this.active=[];this.draw();}
  setNotes(notes:Note[],offset:number,duration:number){
    this.notes=notes.map(n=>({...n,startTimeSeconds:Math.max(0,n.startTimeSeconds),durationSeconds:Math.max(0,Math.min(n.durationSeconds,duration-Math.max(0,n.startTimeSeconds)))})).filter(n=>n.durationSeconds>0);this.offset=offset;this.duration=duration;this.active=[];
    this.estimate=estimateKey(this.notes,duration);
    if(this.follow)this.applyEstimate();
    this.draw();
  }
  snapshot():SavedScale {return {root:this.root,scale:this.scale,follow:this.follow,frets:Number(this.field('scale-frets').value),notes:this.notes,offset:this.offset,duration:this.duration,estimate:this.estimate};}
  restore(state:SavedScale){
    this.root=state.root;this.scale=state.scale;this.follow=state.follow;this.notes=state.notes;
    this.offset=state.offset;this.duration=state.duration;this.estimate=state.estimate;this.active=[];
    this.field('scale-root').value=String(state.root);this.field('scale-family').value=state.scale;this.field('scale-frets').value=String(state.frets);
    enhanceSelects(this.host);this.draw();
  }
  private applyEstimate(){
    const key=this.estimate?.candidates[0];if(!key)return;
    this.root=key.root;
    this.scale=estimateScale(this.notes,this.duration,key);
    this.field('scale-root').value=String(this.root);this.field('scale-family').value=this.scale;
    enhanceSelects(this.host);
  }
  setTime(time:number){
    const active=activePitches(this.notes,time-this.offset,this.duration);
    if(active.join()===this.active.join())return;
    this.active=active;this.drawNeck();
  }
  private draw(){
    const summary=this.host.querySelector('.key-estimate')!;
    if(this.estimate){
      const [best,...alternatives]=this.estimate.candidates;
      summary.textContent=`${this.estimate.tentative?'Tentative key':'Estimated key'} (${this.offset.toFixed(1)}–${(this.offset+this.duration).toFixed(1)}s): ${keyName(best)} · also consider ${alternatives.map(keyName).join(' or ')}. ${this.follow?'Scale chosen from detected notes; other scales may also fit.':'Using your chosen scale.'}`;
    }else summary.textContent=this.duration?'Not enough tonal evidence to estimate a key. Choose a root and scale by ear.':'Open a song to detect its key and scale automatically.';
    if(this.coverage)summary.textContent+=' '+this.coverage;
    this.host.querySelector<HTMLButtonElement>('[data-use-key]')!.disabled=!this.estimate;
    this.host.querySelector('h3')!.textContent=`${PITCH_CLASSES[this.root]} ${SCALES[this.scale].name.toLowerCase()}`;
    this.host.querySelector('.scale-note-list')!.textContent=scaleNotes(this.root,this.scale).map(n=>PITCH_CLASSES[n]).join(' · ');
    this.drawNeck();
  }
  private drawNeck(){
    const first=Number(this.field('scale-frets').value),last=Math.min(first+12,24-this.capo);
    const count=last-first+1,width=880,height=212,left=48,spacing=800/count;
    const x=(f:number)=>left+(f-first+.5)*spacing;
    let svg=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${PITCH_CLASSES[this.root]} ${SCALES[this.scale].name.toLowerCase()}, frets ${first} to ${last}, capo ${this.capo}">`;
    for(let fret=first;fret<=last;fret++){
      svg+=`<text x="${x(fret)}" y="18" text-anchor="middle" fill="#94a3b8" font-size="12">${fret}</text><line x1="${left+(fret-first)*spacing}" x2="${left+(fret-first)*spacing}" y1="35" y2="185" stroke="#3d3d58"/>`;
    }
    for(let s=0;s<6;s++){
      const y=42+(5-s)*27;
      svg+=`<text x="18" y="${y+4}" fill="#94a3b8" font-size="12">${noteName(this.tuning[s]+this.capo)}</text><line x1="${left}" x2="848" y1="${y}" y2="${y}" stroke="#64748b" stroke-width="${1+(5-s)*.18}"/>`;
    }
    for(const point of fretboardPositions(this.tuning,this.capo,this.root,this.scale,first,last,this.active)){
      if(!point.inScale&&!point.active)continue;
      const y=42+(5-point.string)*27;
      const outside=point.active&&!point.inScale;
      const fill=outside?'#fda4af':point.active?'#22d3ee':'#29354b';
      const stroke=point.root?'#fbbf24':point.active?fill:'#64748b';
      const text=point.active?'#0b0b10':point.root?'#fde68a':'#cbd5e1';
      svg+=`<g data-midi="${point.midi}" data-active="${point.active}" data-root="${point.root}" data-in-scale="${point.inScale}"><title>String ${6-point.string}, fret ${point.fret}: ${noteName(point.midi)}${point.root?' (root)':''}${point.active?' — detected':''}${outside?', outside scale':''}</title><circle cx="${x(point.fret)}" cy="${y}" r="11" fill="${fill}" stroke="${stroke}" stroke-width="${point.root?3:1}"/><text x="${x(point.fret)}" y="${y+4}" fill="${text}" text-anchor="middle" font-size="10" font-weight="600">${point.name}</text></g>`;
    }
    this.host.querySelector('.scale-neck')!.innerHTML=svg+'</svg>';
    this.host.querySelector('.scale-playing')!.textContent=this.active.length?`Detected now: ${this.active.map(noteName).join(' · ')}. Bright dots are possible positions for those pitches.`:'No detected notes at this position. The scale stays visible for practice.';
  }
}
