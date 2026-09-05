/** Abstracts file access between Tauri (desktop/Android) and plain browser. */

const isTauri = () =>
  typeof window !== 'undefined' &&
  '__TAURI_INTERNALS__' in window;

export interface OpenedFile {
  name:        string;
  path:        string;   // full filesystem path (same as name in browser)
  arrayBuffer: ArrayBuffer;
}

export async function openAudioFile(): Promise<OpenedFile | null> {
  if (isTauri()) {
    return openFileTauri();
  }
  return openFileBrowser();
}

async function openFileTauri(): Promise<OpenedFile | null> {
  try {
    const { open }     = await import('@tauri-apps/plugin-dialog');
    const { readFile } = await import('@tauri-apps/plugin-fs');

    const selected = await open({
      multiple: false,
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'] }],
    });

    if (!selected || typeof selected !== 'string') return null;

    const bytes = await readFile(selected);
    const name  = selected.split(/[/\\]/).pop() ?? selected;
    return { name, path: selected, arrayBuffer: bytes.buffer as ArrayBuffer };
  } catch (e) {
    console.error('Tauri file open error:', e);
    return null;
  }
}

function openFileBrowser(): Promise<OpenedFile | null> {
  return new Promise(resolve => {
    const input   = document.createElement('input');
    input.type    = 'file';
    input.accept  = 'audio/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const ab = await file.arrayBuffer();
      resolve({ name: file.name, path: file.name, arrayBuffer: ab });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** Open an audio file by its filesystem path (Tauri only). */
export async function openAudioFileByPath(path: string): Promise<OpenedFile | null> {
  if (!isTauri()) return null;
  try {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    const bytes = await readFile(path);
    const name  = path.split(/[/\\]/).pop() ?? path;
    return { name, path, arrayBuffer: bytes.buffer as ArrayBuffer };
  } catch (e) {
    console.error('Failed to open recent file:', e);
    return null;
  }
}

// ── Persistence (localStorage fallback when Tauri store isn't available) ─────

export interface RecentFile {
  name:     string;
  path:     string;
  openedAt: number;
}

const RECENT_KEY = 'looplab_recent';
const MAX_RECENT = 15;

export function saveRecentFile(name: string, path: string): void {
  try {
    const list = getRecentFiles().filter(f => f.path !== path);
    list.unshift({ name, path, openedAt: Date.now() });
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch { /* ignore quota errors */ }
}

export function getRecentFiles(): RecentFile[] {
  try {
    const all: RecentFile[] = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    // Drop entries where path is just a bare filename (saved by old code with no directory)
    return all.filter(f => f.path.includes('/') || f.path.includes('\\'));
  } catch { return []; }
}

export function savePrefs(prefs: Record<string, unknown>): void {
  try { localStorage.setItem('looplab_prefs', JSON.stringify(prefs)); } catch { /* */ }
}

export function loadPrefs(): Record<string, unknown> {
  try { return JSON.parse(localStorage.getItem('looplab_prefs') ?? '{}'); } catch { return {}; }
}

/** Portable project files, with native dialogs on desktop. */
export async function openProjectFile():Promise<OpenedFile|null>{
  if(isTauri()){
    const {open}=await import('@tauri-apps/plugin-dialog');
    const {readFile}=await import('@tauri-apps/plugin-fs');
    const path=await open({multiple:false,filters:[{name:'LoopLab project',extensions:['looplab']}]});
    if(typeof path!=='string')return null;
    const bytes=await readFile(path);
    return {name:path.split(/[/\\]/).pop()??path,path,arrayBuffer:bytes.buffer as ArrayBuffer};
  }
  return new Promise((resolve,reject)=>{
    const input=document.createElement('input');input.type='file';input.accept='.looplab';
    input.oncancel=()=>resolve(null);
    input.onchange=async()=>{try{const file=input.files?.[0];resolve(file?{name:file.name,path:file.name,arrayBuffer:await file.arrayBuffer()}:null);}catch(error){reject(error);}};
    input.click();
  });
}
export async function saveProjectFile(name:string,blob:Blob):Promise<boolean>{
  if(isTauri()){
    const {save}=await import('@tauri-apps/plugin-dialog');
    const {writeFile}=await import('@tauri-apps/plugin-fs');
    const path=await save({defaultPath:name,filters:[{name:'LoopLab project',extensions:['looplab']}]});
    if(!path)return false;
    await writeFile(path,new Uint8Array(await blob.arrayBuffer()));return true;
  }
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),30000);return true;
}
