import type { AnalysisProject } from '../project/file';
import { ScaleView } from './scale-view';
import { enhanceSelects, focusSelect, isSelectEditing } from './dark-select';
import { analyze, preparePassage } from '../transcription/client';
import { STANDARD, chordName, fingerings, groupNotes, noteName, tabText, type Moment, type Note } from '../transcription/guitar';
interface Hooks { saveProject:()=>void; openProject:()=>void;  selection:()=>[number,number]; seek:(t:number)=>void; practice:(a:number,b:number)=>void; togglePlay:()=>void; speed:()=>number; setSpeed:(percent:number)=>void }
export class Transcriber {
  private panel=document.createElement('section');
  private buffer: AudioBuffer | null=null;
  private job: AbortController | null=null;
  private moments: Moment[]=[];
  private selected=0;
  private tuning=[...STANDARD];
  private capo=0;
  private filename='';
  private resultRange: [number,number]=[0,0];
  private scaleView!: ScaleView;
  private view: 'tab'|'scale'='scale';
  private time=0;
  private complete=false;
  private renderedPage=-1;
  private renderedCount=-1;
  constructor(private hooks: Hooks) {
    this.panel.id='transcriber';
    this.panel.setAttribute('aria-labelledby','transcribe-title');
    this.panel.innerHTML=`
      <header class="transcribe-header"><div><h2 id="transcribe-title">Guitar practice</h2></div><div class="practice-views" aria-label="Practice view"><button class="btn btn-sm" data-action="view-tab" aria-pressed="false">Tab</button><button class="btn btn-sm" data-action="view-scale" aria-pressed="true">Scale map</button></div></header>
      <div class="project-actions"><button class="btn" data-action="open-project">Open project</button><button class="btn" data-action="save-project">Save project…</button><span>Projects include audio, analysis and tab edits.</span></div>
      <div class="transcribe-settings">
        <label>From (seconds)<input name="from" type="number" min="0" step="0.1" value="0"></label>
        <label>To (seconds)<input name="to" type="number" min="0" step="0.1" value="10"></label>
        <button class="btn" data-action="selection">Use A/B selection</button>
        <label>Tuning<select name="tuning"><option value="standard">Standard · E A D G B E</option><option value="drop-d">Drop D · D A D G B E</option></select></label>
        <label>Capo<select name="capo">${Array.from({length:13},(_,i)=>`<option value="${i}">${i===0?'None':i}</option>`).join('')}</select></label>
        <label>Detection<select name="sensitivity"><option value="0.4">Balanced</option><option value="0.25">More notes</option><option value="0.55">Fewer notes</option></select></label>
        <button class="btn btn-primary" data-action="analyze">Transcribe passage</button><button class="btn" data-action="cancel" hidden>Cancel</button>
      </div>
      <p class="transcribe-status" role="status" aria-live="polite">Open audio, then choose up to 30 seconds. Works best with isolated guitar.</p>
      <div class="scale-view"></div>
      <p class="tab-empty transcribe-help" hidden>Tab appears as the song is analyzed. You can also transcribe a selected passage.</p>
      <div class="transcribe-results" hidden>
        <div class="tab-workspace"><div class="transcribe-toolbar"><span>Tab · high E on top</span><label class="practice-speed">Speed<select name="practice-speed"><option value="25">25%</option><option value="50">50%</option><option value="75">75%</option><option value="100">100%</option></select></label><button class="btn btn-sm" data-action="play">Play / pause</button><button class="btn btn-sm" data-action="passage">Loop passage</button><button class="btn btn-sm" data-action="export">Export tab</button></div><p class="transcribe-help">Click a column to seek. Columns mark attacks; spacing is not musical notation.</p><div class="tab-pages"><button class="btn btn-sm" data-action="tab-prev">Previous page</button><span class="tab-page-label"></span><button class="btn btn-sm" data-action="tab-next">Next page</button></div><div class="tab-timeline" aria-label="Detected passage"></div></div>
        <aside class="shape-editor"><h3 class="shape-name"></h3><p class="shape-notes"></p><div class="fretboard"></div><p class="shape-quality"></p><div class="shape-actions"><button class="btn btn-sm" data-action="shape">Try another shape</button><button class="btn btn-sm" data-action="practice">Loop this moment</button></div><fieldset><legend>Correct frets · low to high · x = silent</legend><div class="fret-inputs"></div></fieldset><p class="transcribe-help">Frets are relative to the capo. Shape suggestions preserve detected pitches; they may not match the original fingering.</p></aside>
      </div>
      <p class="transcribe-footnote">Audio stays on this device. Powered by Basic Pitch. Bends, slides and doubled notes may need correction. Analysis uses the original recording, before speed or pitch changes.</p>`;
    document.querySelector('.waveform-section')!.insertAdjacentElement('afterend',this.panel);
    this.scaleView=new ScaleView(this.panel.querySelector<HTMLElement>('.scale-view')!);
    this.panel.addEventListener('click',event=>{
      const action=(event.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action;
      if(action==='view-tab'||action==='view-scale'){this.view=action==='view-tab'?'tab':'scale';this.results(this.moments.length>0);}
      if(action==='save-project')this.hooks.saveProject();
      if(action==='open-project')this.hooks.openProject();
      if(action==='tab-prev'||action==='tab-next'){this.selected=Math.max(0,Math.min(this.moments.length-1,(Math.floor(this.selected/100)+(action==='tab-next'?1:-1))*100));this.render();}
      if(action==='selection')this.range();
      if(action==='analyze')void this.run();
      if(action==='cancel')this.cancel();
      if(action==='play')this.hooks.togglePlay();
      if(action==='shape') {const m=this.moments[this.selected]; if(m?.shapes.length){m.choice=(m.choice+1)%m.shapes.length;this.render();}}
      if(action==='practice'){const m=this.moments[this.selected];if(m)this.hooks.practice(m.start,m.end);}
      if(action==='passage' && this.moments.length)this.hooks.practice(...this.resultRange);
      if(action==='export')this.export();
    });
    this.field('practice-speed').addEventListener('change',()=>this.hooks.setSpeed(Number(this.field('practice-speed').value)));
    // Settings describe the results; never silently relabel old tab.
    for(const name of ['tuning','capo','sensitivity'])this.field(name).addEventListener('change',()=>{this.cancel();this.moments=[];this.complete=false;this.renderedCount=-1;this.results(false);this.scaleView.clear();this.scaleView.setTuning(this.field('tuning').value==='drop-d'?[38,45,50,55,59,64]:[...STANDARD],Number(this.field('capo').value));this.status('Settings changed. Transcribe again to generate matching tab.');if(this.buffer)void this.analyzeSong();});
    this.syncSpeed(this.hooks.speed());
  }
  private field(name:string) {return this.panel.querySelector<HTMLInputElement|HTMLSelectElement>(`[name="${name}"]`)!;}
  private status(text:string){this.panel.querySelector('.transcribe-status')!.textContent=text;}
  private results(show:boolean){
    this.panel.querySelector<HTMLElement>('.transcribe-results')!.hidden=!show||this.view!=='tab';
    this.panel.querySelector<HTMLElement>('.scale-view')!.hidden=this.view!=='scale';
    this.panel.querySelector<HTMLElement>('.tab-empty')!.hidden=show||this.view!=='tab';
    this.panel.querySelector('[data-action="view-tab"]')!.setAttribute('aria-pressed',String(this.view==='tab'));
    this.panel.querySelector('[data-action="view-scale"]')!.setAttribute('aria-pressed',String(this.view==='scale'));
  }
  setBuffer(buffer:AudioBuffer|null,filename:string,saved?:AnalysisProject){this.cancel();this.buffer=buffer;this.filename=filename;this.moments=[];this.complete=false;this.renderedCount=-1;this.scaleView.clear();this.results(false);this.range();this.status(buffer?'Listening for the song’s key and scale…':'Open an audio file to start.');if(buffer&&saved){this.restoreProject(saved);return;}if(buffer){this.scaleView.startSong();this.view='scale';this.results(false);void this.analyzeSong();}}
  project():AnalysisProject {
    if(!this.buffer)throw new Error('Open a song before saving a project.');
    return JSON.parse(JSON.stringify({format:'looplab',version:1,filename:this.filename,audioDuration:this.buffer.duration,tuning:this.tuning,capo:this.capo,sensitivity:this.field('sensitivity').value,moments:this.moments,resultRange:this.resultRange,scale:this.scaleView.snapshot(),complete:this.complete,view:this.view,selected:this.selected,speed:this.hooks.speed()}));
  }
  private restoreProject(saved:AnalysisProject){
    this.tuning=[...saved.tuning];this.capo=saved.capo;this.moments=saved.moments;this.resultRange=saved.resultRange;
    this.complete=saved.complete;this.selected=saved.selected;this.view=saved.view;
    this.field('tuning').value=saved.tuning[0]===38?'drop-d':'standard';this.field('capo').value=String(saved.capo);this.field('sensitivity').value=saved.sensitivity;
    this.scaleView.setTuning(this.tuning,this.capo);this.scaleView.restore(saved.scale);
    this.scaleView.setCoverage(saved.complete?'Saved whole-song analysis.':'Saved partial analysis; highlights cover only the analyzed audio.');
    this.hooks.setSpeed(saved.speed);this.syncSpeed(saved.speed);this.results(this.moments.length>0);this.render();
    this.status(`Project loaded · ${this.moments.length} tab moments · ${saved.complete?'whole song ready':'partial analysis restored'} · no reanalysis needed.`);
  }
  syncSpeed(speed:number){
    const field=this.field('practice-speed') as HTMLSelectElement;
    if(!Array.from(field.options).some(o=>Number(o.value)===speed))field.appendChild(new Option(`${speed}%`,String(speed)));
    field.value=String(speed);enhanceSelects(this.panel);
  }
  open(){this.syncSpeed(this.hooks.speed());this.panel.scrollTop=0;this.field('from').focus();}
  private range(){const [a,b]=this.hooks.selection();this.field('from').value=a.toFixed(2);this.field('to').value=Math.min(b,a+30).toFixed(2);}
  private busy(value:boolean){
    this.panel.querySelector<HTMLButtonElement>('[data-action="analyze"]')!.disabled=value;
    this.panel.querySelector<HTMLElement>('[data-action="cancel"]')!.hidden=!value;
  }
  private cancel(){if(this.job){this.job.abort();this.job=null;this.busy(false);this.scaleView.setCoverage('Analysis cancelled; highlights cover only the analyzed audio.');this.status('Analysis cancelled. Choose a passage to transcribe, or reopen the song to restart automatic analysis.');}}
  private async run(){
    if(!this.buffer){this.status('Open an audio file first.');return;}
    const start=Number(this.field('from').value),end=Number(this.field('to').value);
    if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>this.buffer.duration||end-start<.2||end-start>30){this.status('Choose 0.2–30 seconds within the loaded recording.');return;}
    this.cancel();this.complete=false;const job=new AbortController();this.job=job;this.busy(true);
    this.tuning=this.field('tuning').value==='drop-d'?[38,45,50,55,59,64]:[...STANDARD];this.capo=Number(this.field('capo').value);
    const tuning=[...this.tuning],capo=this.capo;
    this.status('Preparing audio…');
    try {
      const samples=await preparePassage(this.buffer,start,end);
      const notes=await analyze(samples,Number(this.field('sensitivity').value),job.signal,p=>this.status(`Finding notes… ${Math.round(p*100)}%. You can cancel at any time.`));
      if(job.signal.aborted)return;
      this.scaleView.setTuning(tuning,capo);
      this.scaleView.setCoverage('Passage analysis.');this.scaleView.setNotes(notes,start,end-start);this.scaleView.setTime(this.time);
      this.moments=groupNotes(notes,start,end-start,tuning,capo);this.resultRange=[start,end];this.selected=0;this.renderedCount=-1;
      this.status(this.moments.length?`${this.moments.length} moments · ${start.toFixed(2)}–${end.toFixed(2)}s · suggested notes and fingerings, ready to check by ear.`:'No clear guitar notes found. Try “More notes” or a cleaner passage.');
      this.results(this.moments.length>0);this.render();
    } catch(error){if(!job.signal.aborted)this.status(`Transcription failed: ${error instanceof Error?error.message:String(error)}`);}
    finally {if(this.job===job){this.job=null;this.busy(false);}}
  }
  private async analyzeSong(){
    const buffer=this.buffer;if(!buffer)return;
    this.cancel();this.complete=false;const job=new AbortController();this.job=job;this.busy(true);
    this.tuning=this.field('tuning').value==='drop-d'?[38,45,50,55,59,64]:[...STANDARD];this.capo=Number(this.field('capo').value);
    this.moments=[];this.selected=0;this.resultRange=[0,0];this.scaleView.setTuning(this.tuning,this.capo);
    const notes:Note[]=[];
    this.scaleView.setCoverage('Analyzing automatically; playback remains available.');
    try {
      // A short first result, then bounded chunks across the entire recording.
      for(let start=0;start<buffer.duration;){
        const end=Math.min(buffer.duration,start+(start===0?8:20));
        const samples=await preparePassage(buffer,start,end);
        if(job.signal.aborted)return;
        const found=await analyze(samples,Number(this.field('sensitivity').value),job.signal,p=>this.status(`Detecting song key and notes… ${Math.floor(100*(start+(end-start)*p)/buffer.duration)}% · analyzed through ${start.toFixed(0)}s. Playback is available.`));
        if(job.signal.aborted)return;
        notes.push(...found.map(n=>({...n,startTimeSeconds:n.startTimeSeconds+start,durationSeconds:Math.min(n.durationSeconds,end-start-n.startTimeSeconds)})).filter(n=>n.durationSeconds>0));
        // Append each chunk's tab so earlier user corrections stay intact.
        this.moments.push(...groupNotes(found,start,end-start,this.tuning,this.capo));
        this.resultRange=[0,end];this.results(this.moments.length>0);this.render();
        this.scaleView.setNotes(notes,0,end);
        this.scaleView.setCoverage(end<buffer.duration?`Analyzed first ${end.toFixed(0)} of ${buffer.duration.toFixed(0)} seconds; highlights appear as analysis advances.`:'Whole song analyzed.');
        this.scaleView.setTime(this.time);
        start=end;
      }
      this.complete=true;
      this.status(`Song ready · ${this.moments.length} tab moments, key and scale analyzed. Save a project to reopen everything without analyzing again.`);
    }catch(error){if(!job.signal.aborted){this.scaleView.setCoverage('Analysis stopped; highlights cover only the analyzed audio.');this.status(`Song analysis failed: ${error instanceof Error?error.message:String(error)}. You can transcribe a short passage instead.`);}}
    finally{if(this.job===job){this.job=null;this.busy(false);}}
  }
  setTime(t:number){
    this.time=t;
    this.scaleView.setTime(t);
    if(isSelectEditing())return;
    const index=this.moments.findIndex(m=>t>=m.start && t<m.end);
    if(index>=0 && index!==this.selected){this.selected=index;this.render();}
  }
  private render(){
    const timeline=this.panel.querySelector<HTMLElement>('.tab-timeline')!;const scroll=timeline.scrollLeft;
    const page=Math.floor(this.selected/100),first=page*100;
    const rebuild=this.renderedPage!==page||this.renderedCount!==this.moments.length;
    if(rebuild){timeline.replaceChildren();this.renderedPage=page;this.renderedCount=this.moments.length;}
    if(rebuild)this.moments.slice(first,first+100).forEach((m,localIndex)=>{
      const index=first+localIndex;
      const button=document.createElement('button');button.className='tab-moment';button.classList.toggle('selected',index===this.selected);
      button.setAttribute('aria-label',`${m.start.toFixed(2)} seconds, ${chordName(m.notes)}`);button.setAttribute('aria-pressed',String(index===this.selected));
      const shape=m.shapes[m.choice];
      button.innerHTML=`<span class="tab-time">${m.start.toFixed(2)}s</span><strong>${chordName(m.notes)}</strong>${[5,4,3,2,1,0].map(s=>`<span class="tab-string">${shape?(shape[s]<0?'—':shape[s]):'?'}</span>`).join('')}`;
      button.addEventListener('click',()=>{this.selected=index;this.hooks.seek(m.start);this.render();});timeline.appendChild(button);
    });
    for(const [i,child] of Array.from(timeline.children).entries()){
      const index=first+i,m=this.moments[index],shape=m.shapes[m.choice];
      child.classList.toggle('selected',index===this.selected);child.setAttribute('aria-pressed',String(index===this.selected));
      child.setAttribute('aria-label',`${m.start.toFixed(2)} seconds, ${chordName(m.notes)}`);
      child.querySelector('strong')!.textContent=chordName(m.notes);
      child.querySelectorAll('.tab-string').forEach((cell,j)=>{cell.textContent=shape?(shape[5-j]<0?'—':String(shape[5-j])):'?';});
    }
    this.panel.querySelector('.tab-page-label')!.textContent=this.moments.length?`${first+1}–${Math.min(first+100,this.moments.length)} of ${this.moments.length} moments`:'';
    this.panel.querySelector<HTMLButtonElement>('[data-action="tab-prev"]')!.disabled=page===0;
    this.panel.querySelector<HTMLButtonElement>('[data-action="tab-next"]')!.disabled=first+100>=this.moments.length;
    timeline.scrollLeft=rebuild?0:scroll;
    const active=timeline.children[this.selected-first] as HTMLElement|undefined;
    if(active && (active.offsetLeft<timeline.offsetLeft+scroll || active.offsetLeft+active.offsetWidth>timeline.offsetLeft+scroll+timeline.clientWidth)) {timeline.scrollLeft=active.offsetLeft-timeline.offsetLeft;}
    const m=this.moments[this.selected];if(!m)return;
    this.panel.querySelector('.shape-name')!.textContent=chordName(m.notes);
    this.panel.querySelector('.shape-notes')!.textContent=m.notes.map(noteName).join(' · ');
    this.panel.querySelector('.shape-quality')!.textContent=m.edited?'Your edited fingering':!m.shapes.length?'No comfortable shape found. Correct the frets below.':`${m.strength<.4?'Check these notes by ear · ':''}Suggested shape ${m.choice+1} of ${m.shapes.length}`;
    this.panel.querySelector<HTMLButtonElement>('[data-action="shape"]')!.disabled=m.shapes.length<2;
    const shape=m.shapes[m.choice]??Array(6).fill(-1);
    this.drawFretboard(shape);
    const inputs=this.panel.querySelector('.fret-inputs')!;inputs.replaceChildren();
    shape.forEach((fret,s)=>{
      const label=document.createElement('label');label.textContent=noteName(this.tuning[s]);
      const select=document.createElement('select');select.setAttribute('aria-label',`String ${6-s} fret`);
      for(let f=-1;f<=24-this.capo;f++){const option=document.createElement('option');option.value=String(f);option.textContent=f===-1?'x':String(f);select.appendChild(option);}select.value=String(fret);
      select.addEventListener('change',()=>{
        const edited=[...shape];edited[s]=Number(select.value);m.notes=edited.flatMap((f,i)=>f<0?[]:[this.tuning[i]+this.capo+f]).sort((a,b)=>a-b);
        m.shapes=[edited,...fingerings(m.notes,this.tuning,this.capo).filter(other=>other.join()!==edited.join())];m.choice=0;m.edited=true;this.render();
        focusSelect(this.panel.querySelector<HTMLSelectElement>(`select[aria-label="String ${6-s} fret"]`));
      });label.appendChild(select);inputs.appendChild(label);
    });
    enhanceSelects(this.panel);
  }
  private drawFretboard(shape:number[]){
    const pressed=shape.filter(f=>f>0),first=pressed.length?(Math.min(...pressed)<=5?1:Math.min(...pressed)):1;
    const count=Math.max(5,pressed.length?Math.max(...pressed)-first+1:5);
    const width=300,height=170;
    const x=(f:number)=>44+(f-first+.5)*240/count;
    let svg=`<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Fretboard, high string at top, frets ${first} through ${first+count-1}">`;
    for(let f=0;f<=count;f++){const at=44+f*240/count;svg+=`<line x1="${at}" x2="${at}" y1="30" y2="145" stroke="#64748b"/><text x="${at+120/count}" y="20" fill="#94a3b8" text-anchor="middle" font-size="10">${f<count?first+f:''}</text>`;}
    for(let s=0;s<6;s++){const y=35+(5-s)*21;svg+=`<line x1="44" x2="284" y1="${y}" y2="${y}" stroke="#64748b" stroke-width="${1+(5-s)*.15}"/><text x="12" y="${y+4}" fill="#94a3b8" font-size="11">${noteName(this.tuning[s]).replace(/\d/g,'')}</text>`;
      if(shape[s]>0)svg+=`<circle cx="${x(shape[s])}" cy="${y}" r="9" fill="#06b6d4"/><text x="${x(shape[s])}" y="${y+4}" text-anchor="middle" font-size="10" fill="#0b0b10">${shape[s]}</text>`;
      else svg+=`<text x="31" y="${y+4}" text-anchor="middle" fill="#e2e8f0" font-size="12">${shape[s]===0?'○':'×'}</text>`;
    }
    this.panel.querySelector('.fretboard')!.innerHTML=svg+'</svg>';
  }
  private export(){const url=URL.createObjectURL(new Blob([tabText(this.moments,this.tuning,this.capo)],{type:'text/plain'}));const a=document.createElement('a');a.href=url;a.download=this.filename.replace(/\.[^.]+$/,'')+'-tab.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
}
