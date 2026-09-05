import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
const source=ts.transpileModule(readFileSync(new URL('../src/ui/transcriber.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const guitar={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/transcription/guitar.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports:guitar});
function harness(client){
 const exports={};vm.runInNewContext(source,{exports,AbortController,require:name=>name.includes('/client')?client:name.includes('/guitar')?guitar:{}});
 const app=Object.create(exports.Transcriber.prototype),seen=[],messages=[];
 Object.assign(app,{buffer:{duration:10},job:null,time:9,field:name=>({value:name==='tuning'?'standard':name==='capo'?'0':'.4'}),results:()=>{},render:()=>{},busy:v=>{app.isBusy=v;},status:s=>messages.push(s),scaleView:{setTuning:()=>{},setCoverage:s=>{},setNotes:(notes,start,end)=>seen.push({notes:notes.map(n=>({...n})),start,end}),setTime:()=>{}}});
 return {app,seen,messages};
}
test('automatic analysis reaches the end and offsets later chunk notes',async()=>{
 const ranges=[];
 const h=harness({preparePassage:async(b,a,z)=>{ranges.push([a,z]);return [];},analyze:async()=>[{pitchMidi:64,startTimeSeconds:1,durationSeconds:3,amplitude:.8}]});
 await h.app.analyzeSong();
 assert.deepEqual(ranges,[[0,8],[8,10]]);
 assert.equal(h.seen.at(-1).end,10);
 assert.equal(h.seen.at(-1).notes[1].startTimeSeconds,9);
 assert.equal(h.seen.at(-1).notes[1].durationSeconds,1);
 assert.ok(h.app.moments.length>0);assert.equal(h.app.moments.at(-1).start,9);assert.equal(h.app.complete,true);
 assert.equal(h.app.isBusy,false);assert.match(h.messages.at(-1),/Song ready/);
});
test('cancelling during audio preparation prevents starting a worker or applying stale results',async()=>{
 let release,called=false;
 const h=harness({preparePassage:()=>new Promise(r=>release=r),analyze:async()=>{called=true;return [];}});
 const pending=h.app.analyzeSong();h.app.cancel();release([]);await pending;
 assert.equal(called,false);assert.equal(h.seen.length,0);assert.equal(h.app.isBusy,false);
});
test('replacing an analysis cannot overwrite the new song or clear its busy state',async()=>{
 let release,calls=0;
 const h=harness({preparePassage:async()=>[],analyze:()=>++calls===1?new Promise(r=>release=r):Promise.resolve([])});
 const old=h.app.analyzeSong();
 for(let i=0;i<10&&!release;i++)await new Promise(r=>setImmediate(r));
 assert.ok(release);
 h.app.buffer={duration:2};const next=h.app.analyzeSong();await next;
 release([{pitchMidi:40,startTimeSeconds:0,durationSeconds:1,amplitude:1}]);await old;
 assert.equal(h.seen.length,1);assert.equal(h.seen[0].end,2);assert.equal(h.seen[0].notes.length,0);assert.equal(h.app.isBusy,false);
});
test('loading a saved project bypasses automatic transcription',()=>{
 const h=harness({analyze:()=>{throw new Error('must not analyze');}}),saved={version:1};let restored;
 Object.assign(h.app,{scaleView:{clear:()=>{}},range:()=>{},restoreProject:p=>{restored=p;},analyzeSong:()=>{throw new Error('must not start');}});
 h.app.setBuffer({duration:10},'saved.mp3',saved);
 assert.equal(restored,saved);
});
test('appending later tab chunks preserves an earlier edited fingering',async()=>{
 let call=0,finish;
 const h=harness({preparePassage:async()=>[],analyze:()=>++call===1?Promise.resolve([{pitchMidi:52,startTimeSeconds:1,durationSeconds:1,amplitude:.8}]):new Promise(r=>finish=r)});
 const pending=h.app.analyzeSong();
 for(let i=0;i<10&&!finish;i++)await new Promise(r=>setImmediate(r));
 assert.ok(finish);h.app.moments[0].edited=true;h.app.moments[0].choice=1;
 const edited=h.app.moments[0];finish([{pitchMidi:64,startTimeSeconds:1,durationSeconds:1,amplitude:.8}]);await pending;
 assert.equal(h.app.moments[0],edited);assert.equal(h.app.moments[0].choice,1);assert.equal(h.app.moments[0].edited,true);assert.equal(h.app.moments.length,2);
});
