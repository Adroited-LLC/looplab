import { decodeProject, encodeProject, type AnalysisProject } from '../project/file';
import { enhanceSelects } from './dark-select';
import { AudioEngine }      from '../audio/engine';
import { Metronome }         from '../audio/metronome';
import { detectBpm }         from '../audio/bpm';
import { TapTempo }          from '../audio/tap-tempo';
import { WaveformController } from './waveform';
import { Transcriber } from './transcriber';
import {
  openAudioFile,
  openProjectFile,
  saveProjectFile,
  openAudioFileByPath,
  saveRecentFile,
  getRecentFiles,
  savePrefs,
  loadPrefs,
} from '../platform';

// ── Helpers ───────────────────────────────────────────────────────────────────

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector<T>(sel)!;

function fmt(s: number): string {
  if (isNaN(s) || !isFinite(s)) return '0:00.000';
  const m  = Math.floor(s / 60);
  const ss = (s % 60).toFixed(3).padStart(6, '0');
  return `${m}:${ss}`;
}

function fmtShort(s: number): string {
  if (isNaN(s) || !isFinite(s)) return '--:--';
  const m  = Math.floor(s / 60);
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${ss}`;
}

// ── App ───────────────────────────────────────────────────────────────────────

export class App {
  private engine   = new AudioEngine();
  private waveform = new WaveformController();
  private tap      = new TapTempo();
  private metro!:  Metronome;
  private transcriber!: Transcriber;

  // UI state
  private bpm           = 120;
  private beatsPerBar   = 4;
  private markers:        { id: string; label: string; time: number }[] = [];
  private loopA: number | null = null;
  private loopB: number | null = null;
  private currentBlobUrl: string | null = null;
  private fileName      = '';
  private audioBytes:ArrayBuffer|null=null;
  private loading=false;
  private loadGeneration=0;
  private savingProject=false;

  async init(): Promise<void> {
    await this.engine.init();
    this.metro = new Metronome(this.engine.getAudioContext());

    this.waveform.init($('#waveform'));
    this.transcriber = new Transcriber({
      saveProject:()=>void this._saveProject(),
      openProject:()=>void this._openProject(),
      selection: () => [this.loopA ?? this.engine.state.currentTime, this.loopB ?? this.engine.state.duration],
      seek: t => this.engine.seek(t),
      togglePlay: () => this.engine.togglePlay(),
      speed: () => this.engine.state.tempo * 100,
      setSpeed: percent => this._setSlider('#speed-slider', percent),
      practice: (a, b) => {
        this.loopA = a; this.loopB = b;
        this.engine.setLoop(true, a, b);
        this.waveform.setLoop(a, b);
        $<HTMLInputElement>('#loop-checkbox').checked = true;
        $('#loop-toggle').classList.add('on');
        this._updateLoopDisplay();
        this.engine.seek(a); this.engine.play();
      },
    });
    $('#transcribe-btn').addEventListener('click', () => this.transcriber.open());

    this._bindEngine();
    this._bindWaveform();
    this._bindControls();
    this._bindKeyboard();
    this._bindDragDrop();
    this._restorePrefs();
    this._renderRecentFiles();
    enhanceSelects(document);
  }

  // ── Engine callbacks ────────────────────────────────────────────────────────

  private _bindEngine(): void {
    this.engine.onTimeUpdate(t => {
      $('#current-time').textContent = fmt(t);
      this.waveform.setTime(t);
      this._updateSeekBar(t);
      this.transcriber.setTime(t);
    });

    this.engine.onStatusChange(status => {
      const btn = $('#play-btn');
      btn.textContent = status === 'playing' ? '⏸' : '▶';
      btn.classList.toggle('active', status === 'playing');
      $('#status-msg').textContent =
        status === 'playing' ? `Playing — ${this.fileName}` :
        status === 'paused'  ? `Paused  — ${this.fileName}` :
        'Stopped';
    });

    this.engine.onEnded(() => {
      this._syncUI();
    });
  }

  // ── Waveform callbacks ──────────────────────────────────────────────────────

  private _bindWaveform(): void {
    this.waveform.onSeek(t => {
      this.engine.seek(t);
    });

    this.waveform.onRegionChange((start, end) => {
      this.loopA = start;
      this.loopB = end;
      this.engine.setLoop(this.engine.state.loopEnabled, start, end);
      this._updateLoopDisplay();
    });
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  private _bindControls(): void {
    // Open file
    $('#open-btn').addEventListener('click', () => this._openFile());

    // Transport
    $('#play-btn').addEventListener('click', () => this.engine.togglePlay());
    $('#stop-btn').addEventListener('click', () => this.engine.stop());

    // Seek bar
    const seekBar = $<HTMLInputElement>('#seek-bar');
    seekBar.addEventListener('input', () => {
      const t = (Number(seekBar.value) / 1000) * this.engine.state.duration;
      this.engine.seek(t);
    });

    // Skip buttons
    $('#skip-back-btn').addEventListener('click',    () => this.engine.skipBy(-5));
    $('#skip-forward-btn').addEventListener('click', () => this.engine.skipBy(5));

    // Zoom
    $('#zoom-out-btn').addEventListener('click', () => this.waveform.zoomOut());
    $('#zoom-in-btn').addEventListener('click',  () => this.waveform.zoomIn());

    // Speed
    this._bindSlider('#speed-slider', '#speed-value', v => {
      this.engine.setSpeedPercent(v);
      this.transcriber.syncSpeed(v);
      return `${v}%`;
    });
    $('#speed-down').addEventListener('click', () => this._stepSlider('#speed-slider', -5));
    $('#speed-up').addEventListener('click',   () => this._stepSlider('#speed-slider', +5));
    document.querySelectorAll<HTMLElement>('.preset-btn[data-speed]').forEach(btn => {
      btn.addEventListener('click', () => {
        const v = Number(btn.dataset.speed);
        this._setSlider('#speed-slider', v);
        this.engine.setSpeedPercent(v);
      });
    });

    // Pitch (semitones)
    this._bindSlider('#semitone-slider', '#semitone-value', v => {
      this.engine.setPitch(v, this.engine.state.pitchCents);
      return v > 0 ? `+${v} st` : v < 0 ? `${v} st` : '0 st';
    });
    $('#semitone-down').addEventListener('click', () => this._stepSlider('#semitone-slider', -1));
    $('#semitone-up').addEventListener('click',   () => this._stepSlider('#semitone-slider', +1));

    // Fine tune (cents)
    this._bindSlider('#cents-slider', '#cents-value', v => {
      this.engine.setPitch(this.engine.state.pitchSemitones, v);
      return v > 0 ? `+${v} ¢` : v < 0 ? `${v} ¢` : '0 ¢';
    });
    $('#cents-down').addEventListener('click', () => this._stepSlider('#cents-slider', -1));
    $('#cents-up').addEventListener('click',   () => this._stepSlider('#cents-slider', +1));

    // A/B Loop
    $('#set-a-btn').addEventListener('click', () => {
      this.loopA = this.engine.state.currentTime;
      if (this.loopB !== null && this.loopA >= this.loopB) this.loopB = null;
      this._applyLoop();
    });
    $('#set-b-btn').addEventListener('click', () => {
      this.loopB = this.engine.state.currentTime;
      if (this.loopA !== null && this.loopB <= this.loopA) this.loopA = null;
      this._applyLoop();
    });
    $('#loop-toggle').addEventListener('click', () => {
      const cb = $<HTMLInputElement>('#loop-checkbox');
      cb.checked = !cb.checked;
      this.engine.setLoop(cb.checked);
      $('#loop-toggle').classList.toggle('on', cb.checked);
    });
    $('#clear-loop-btn').addEventListener('click', () => {
      this.loopA = null; this.loopB = null;
      this.engine.setLoop(false);
      this.waveform.clearLoop();
      $<HTMLInputElement>('#loop-checkbox').checked = false;
      $('#loop-toggle').classList.remove('on');
      this._updateLoopDisplay();
    });

    // Volume
    const volSlider = $<HTMLInputElement>('#volume-slider');
    volSlider.addEventListener('input', () => {
      const v = Number(volSlider.value) / 100;
      this.engine.setVolume(v);
      $('#volume-value').textContent = `${volSlider.value}%`;
    });

    // Pan
    const panSlider = $<HTMLInputElement>('#pan-slider');
    panSlider.addEventListener('input', () => {
      const v = Number(panSlider.value) / 100;
      this.engine.setPan(v);
      const label = v === 0 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`;
      $('#pan-value').textContent = label;
    });

    // BPM
    $<HTMLInputElement>('#bpm-input').addEventListener('change', () => {
      this.bpm = Math.max(20, Math.min(300, Number($<HTMLInputElement>('#bpm-input').value)));
      $<HTMLInputElement>('#bpm-input').value = String(this.bpm);
      this.metro.setBpm(this.bpm);
    });
    $('#bpm-down').addEventListener('click', () => {
      this.bpm = Math.max(20, this.bpm - 1);
      $<HTMLInputElement>('#bpm-input').value = String(this.bpm);
      this.metro.setBpm(this.bpm);
    });
    $('#bpm-up').addEventListener('click', () => {
      this.bpm = Math.min(300, this.bpm + 1);
      $<HTMLInputElement>('#bpm-input').value = String(this.bpm);
      this.metro.setBpm(this.bpm);
    });
    $('#tap-btn').addEventListener('click', () => {
      const result = this.tap.tap();
      if (result) {
        this.bpm = result;
        $<HTMLInputElement>('#bpm-input').value = String(this.bpm);
        this.metro.setBpm(this.bpm);
        const btn = $('#tap-btn');
        btn.classList.add('flash');
        setTimeout(() => btn.classList.remove('flash'), 200);
      }
    });
    $<HTMLSelectElement>('#beats-per-bar').addEventListener('change', e => {
      this.beatsPerBar = Number((e.target as HTMLSelectElement).value);
      this.metro.setBeatsPerBar(this.beatsPerBar);
    });

    // Metronome toggle
    $('#metro-toggle').addEventListener('click', () => {
      const cb = $<HTMLInputElement>('#metro-checkbox');
      cb.checked = !cb.checked;
      if (cb.checked) this.metro.start(); else this.metro.stop();
      $('#metro-toggle').classList.toggle('on', cb.checked);
    });
    $<HTMLInputElement>('#metro-vol').addEventListener('input', () => {
      this.metro.setVolume(Number($<HTMLInputElement>('#metro-vol').value) / 100);
    });

    // Markers
    $('#add-marker-btn').addEventListener('click', () => this._addMarker());
    $('#clear-markers-btn').addEventListener('click', () => this._clearMarkers());

    // Recent panel toggle
    $('#recent-btn').addEventListener('click', () => {
      const panel = $('#recent-panel');
      panel.classList.toggle('visible');
    });
    document.addEventListener('click', e => {
      if (!(e.target as Element).closest('#recent-panel') &&
          !(e.target as Element).closest('#recent-btn')) {
        $('#recent-panel')?.classList.remove('visible');
      }
    });
  }

  // ── Keyboard ────────────────────────────────────────────────────────────────

  private _bindKeyboard(): void {
    document.addEventListener('keydown', e => {
      // Don't intercept when typing in inputs
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (tag === 'TEXTAREA' || tag === 'SELECT' || (e.target as Element).closest('.dark-select, .dark-select-menu') || (e.target as Element).closest('#transcriber')) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.engine.togglePlay();
          break;
        case 'Escape':
        case 's': case 'S':
          this.engine.stop();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          this.engine.skipBy(e.shiftKey ? -1 : -5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          this.engine.skipBy(e.shiftKey ? 1 : 5);
          break;
        case 'a': case 'A':
          if (!e.ctrlKey && !e.metaKey) {
            this.loopA = this.engine.state.currentTime;
            this._applyLoop();
          }
          break;
        case 'b': case 'B':
          this.loopB = this.engine.state.currentTime;
          this._applyLoop();
          break;
        case 'l': case 'L':
          this.engine.toggleLoop();
          {
            const cb = $<HTMLInputElement>('#loop-checkbox');
            cb.checked = this.engine.state.loopEnabled;
            $('#loop-toggle').classList.toggle('on', cb.checked);
          }
          break;
        case 'm': case 'M':
          this._addMarker();
          break;
        case 't': case 'T':
          $('#tap-btn').click();
          break;
        case '[':
          this.waveform.zoomOut();
          break;
        case ']':
          this.waveform.zoomIn();
          break;
        case '+': case '=':
          if (e.shiftKey) {
            this._stepSlider('#semitone-slider', 1);
          } else {
            this._stepSlider('#speed-slider', 5);
          }
          break;
        case '-': case '_':
          if (e.shiftKey) {
            this._stepSlider('#semitone-slider', -1);
          } else {
            this._stepSlider('#speed-slider', -5);
          }
          break;
        case 'o': case 'O':
          if (e.ctrlKey || e.metaKey) { e.preventDefault(); this._openFile(); }
          break;
        default:
          // Number keys 1-9: jump to marker
          if (e.key >= '1' && e.key <= '9') {
            const idx = Number(e.key) - 1;
            if (this.markers[idx]) this.engine.seek(this.markers[idx].time);
          }
      }
    });
  }

  // ── Drag & drop ─────────────────────────────────────────────────────────────

  private _bindDragDrop(): void {
    const zone = $('#drop-overlay');

    document.addEventListener('dragover', e => {
      e.preventDefault();
      zone.classList.add('active');
    });
    document.addEventListener('dragleave', e => {
      if (!e.relatedTarget) zone.classList.remove('active');
    });
    document.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('active');
      const file = e.dataTransfer?.files[0];
      if (file) {const data=await file.arrayBuffer();if(file.name.toLowerCase().endsWith('.looplab'))await this._loadProject(data);else await this._loadFile(file.name,data);}
    });
  }

  // ── File loading ─────────────────────────────────────────────────────────────

  private async _openFile(): Promise<void> {
    const result = await openAudioFile();
    if (!result) return;
    await this._loadFile(result.name, result.arrayBuffer);
    saveRecentFile(result.name, result.path);
    this._renderRecentFiles();
  }

  private async _openFileByPath(path: string, name: string): Promise<void> {
    $('#status-msg').textContent = `Opening ${name}…`;
    const result = await openAudioFileByPath(path);
    if (!result) {
      $('#status-msg').textContent = `Could not open: ${name}  (file moved or deleted?)`;
      return;
    }
    await this._loadFile(name, result.arrayBuffer);
    saveRecentFile(name, path);
    this._renderRecentFiles();
  }

  private async _saveProject():Promise<void>{
    if(this.savingProject)return;
    try{
      if(this.loading||!this.audioBytes)throw new Error('Wait for a recording to finish loading before saving.');
      this.savingProject=true;
      const snapshot=this.transcriber.project(),audio=this.audioBytes;
      const blob=await encodeProject(snapshot,audio);
      const name=snapshot.filename.replace(/\.[^.]+$/,'').replace(/[/\\]/g,'_')+'.looplab';
      if(await saveProjectFile(name,blob))$('#status-msg').textContent=`Project saved · ${snapshot.complete?'whole song':'partial analysis'} · includes recording and tab edits`;
    }catch(error){$('#status-msg').textContent=`Could not save project: ${error instanceof Error?error.message:String(error)}`;}
    finally{this.savingProject=false;}
  }
  private async _openProject():Promise<void>{
    try{const file=await openProjectFile();if(file)await this._loadProject(file.arrayBuffer);}
    catch(error){$('#status-msg').textContent=`Could not open project: ${error instanceof Error?error.message:String(error)}`;}
  }
  private async _loadProject(data:ArrayBuffer):Promise<void>{
    try{
      const {project,audio}=await decodeProject(data);
      await this._loadFile(project.filename,audio,project);
    }catch(error){$('#status-msg').textContent=`Could not open project: ${error instanceof Error?error.message:String(error)}`;}
  }
  private async _loadFile(name: string, ab: ArrayBuffer,saved?:AnalysisProject): Promise<void> {
    const generation=++this.loadGeneration;this.loading=true;
    this.transcriber.setBuffer(null, name);
    this.fileName = name;
    $('#filename').textContent = name;
    $('#status-msg').textContent = 'Decoding…';

    try {
      // Decode audio
      const buffer = await this.engine.decodeFile(ab.slice(0));
      if(generation!==this.loadGeneration)return;
      if(saved&&Math.abs(buffer.duration-saved.audioDuration)>.05)throw new Error('Project recording duration does not match its analysis.');
      await this.engine.loadBuffer(buffer);
      if(generation!==this.loadGeneration)return;
      this.audioBytes=ab;

      // Update waveform display
      if (this.currentBlobUrl) URL.revokeObjectURL(this.currentBlobUrl);
      const blob           = new Blob([ab], { type: 'audio/*' });
      this.currentBlobUrl  = URL.createObjectURL(blob);
      await this.waveform.load(this.currentBlobUrl);
      if(generation!==this.loadGeneration)return;

      // Update duration display
      $('#total-time').textContent   = fmt(buffer.duration);
      $<HTMLInputElement>('#seek-bar').value = '0';

      // Reset loop state
      this.loopA = null; this.loopB = null;
      this.waveform.clearLoop();
      $<HTMLInputElement>('#loop-checkbox').checked = false;
      $('#loop-toggle').classList.remove('on');
      this._updateLoopDisplay();

      this.transcriber.setBuffer(buffer, name,saved);
      this.loading=false;

      // Clear markers
      this._clearMarkers();

      // BPM detection
      $('#status-msg').textContent = 'Detecting BPM…';
      try {
        const { bpm } = await detectBpm(buffer);
        if(generation!==this.loadGeneration)return;
        this.bpm = bpm;
        $<HTMLInputElement>('#bpm-input').value = String(bpm);
        this.metro.setBpm(bpm);
        $('#status-msg').textContent = `Loaded — ${name}  ·  ${bpm} BPM detected`;
      } catch {
        $('#status-msg').textContent = `Loaded — ${name}`;
      }

      this._savePrefs();
    } catch (err) {
      if(generation!==this.loadGeneration)return;
      this.audioBytes=null;
      console.error(err);
      $('#status-msg').textContent = `Error loading file: ${(err as Error).message}`;
    } finally {if(generation===this.loadGeneration)this.loading=false;}
  }

  // ── Loop helpers ────────────────────────────────────────────────────────────

  private _applyLoop(): void {
    if (this.loopA !== null && this.loopB !== null) {
      const start = Math.min(this.loopA, this.loopB);
      const end   = Math.max(this.loopA, this.loopB);
      this.engine.setLoop(this.engine.state.loopEnabled, start, end);
      this.waveform.setLoop(start, end);
    } else if (this.loopA !== null) {
      this.engine.setLoopStart(this.loopA);
      const dur = this.engine.state.duration;
      if (dur) this.waveform.setLoop(this.loopA, dur);
    } else if (this.loopB !== null) {
      this.engine.setLoopEnd(this.loopB);
      this.waveform.setLoop(0, this.loopB);
    }
    this._updateLoopDisplay();
  }

  private _updateLoopDisplay(): void {
    $('#loop-a-time').textContent = this.loopA !== null ? fmtShort(this.loopA) : '--:--';
    $('#loop-b-time').textContent = this.loopB !== null ? fmtShort(this.loopB) : '--:--';
  }

  // ── Markers ─────────────────────────────────────────────────────────────────

  private _addMarker(): void {
    const t     = this.engine.state.currentTime;
    const id    = `m${Date.now()}`;
    const label = `Mark ${this.markers.length + 1}  (${fmtShort(t)})`;
    this.markers.push({ id, label, time: t });
    this._renderMarkers();
  }

  private _clearMarkers(): void {
    this.markers = [];
    this._renderMarkers();
  }

  private _renderMarkers(): void {
    const list = $('#markers-list');
    list.innerHTML = '';
    this.markers.forEach((m, i) => {
      const el = document.createElement('div');
      el.className = 'marker-item';
      el.innerHTML = `
        <span class="marker-num">${i + 1}</span>
        <span class="marker-label">${m.label}</span>
        <button class="marker-del" data-id="${m.id}">✕</button>
      `;
      el.querySelector('.marker-label')!
        .addEventListener('click', () => this.engine.seek(m.time));
      el.querySelector<HTMLElement>('.marker-del')!
        .addEventListener('click', e => {
          e.stopPropagation();
          this.markers = this.markers.filter(x => x.id !== m.id);
          this._renderMarkers();
        });
      list.appendChild(el);
    });
  }

  // ── Recent files ─────────────────────────────────────────────────────────────

  private _renderRecentFiles(): void {
    const list = $('#recent-list');
    if (!list) return;
    const files = getRecentFiles();
    list.innerHTML = '';
    if (!files.length) {
      list.innerHTML = '<p class="no-recent">No recent files</p>';
      return;
    }
    files.forEach(f => {
      const el       = document.createElement('div');
      el.className   = 'recent-item';
      el.textContent = f.name;
      el.title       = f.path;
      el.addEventListener('click', () => {
        $('#recent-panel').classList.remove('visible');
        this._openFileByPath(f.path, f.name);
      });
      list.appendChild(el);
    });
  }

  // ── Slider helpers ──────────────────────────────────────────────────────────

  private _bindSlider(
    sliderSel: string,
    valueSel: string,
    onChange: (v: number) => string
  ): void {
    const slider = $<HTMLInputElement>(sliderSel);
    const label  = $(valueSel);
    slider.addEventListener('input', () => {
      label.textContent = onChange(Number(slider.value));
    });
  }

  private _stepSlider(sliderSel: string, delta: number): void {
    const slider  = $<HTMLInputElement>(sliderSel);
    const newVal  = Math.max(Number(slider.min), Math.min(Number(slider.max), Number(slider.value) + delta));
    slider.value  = String(newVal);
    slider.dispatchEvent(new Event('input'));
  }

  private _setSlider(sliderSel: string, val: number): void {
    const slider  = $<HTMLInputElement>(sliderSel);
    slider.value  = String(val);
    slider.dispatchEvent(new Event('input'));
  }

  private _updateSeekBar(t: number): void {
    const dur = this.engine.state.duration;
    if (!dur) return;
    $<HTMLInputElement>('#seek-bar').value = String((t / dur) * 1000);
  }

  private _syncUI(): void {
    $('#current-time').textContent = fmt(this.engine.state.currentTime);
  }

  // ── Prefs ────────────────────────────────────────────────────────────────────

  private _restorePrefs(): void {
    const p = loadPrefs();
    if (typeof p.bpm === 'number')    { this.bpm = p.bpm; $<HTMLInputElement>('#bpm-input').value = String(this.bpm); }
    if (typeof p.speed === 'number')  { this._setSlider('#speed-slider', p.speed); }
    if (typeof p.volume === 'number') {
      const v = $<HTMLInputElement>('#volume-slider');
      v.value = String(p.volume);
      v.dispatchEvent(new Event('input'));
    }
  }

  private _savePrefs(): void {
    savePrefs({
      bpm:    this.bpm,
      speed:  Number($<HTMLInputElement>('#speed-slider').value),
      volume: Number($<HTMLInputElement>('#volume-slider').value),
    });
  }
}
