import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {webcrypto} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
const compile=path=>ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const scales={};vm.runInNewContext(compile('../src/transcription/scales.ts'),{exports:scales});
const lib={};vm.runInNewContext(compile('../src/project/file.ts'),{exports:lib,require:()=>scales,TextEncoder,TextDecoder,Blob,crypto:webcrypto});
const fixture=()=>({format:'looplab',version:1,filename:'riff.mp3',audioDuration:10,tuning:[40,45,50,55,59,64],capo:0,sensitivity:'0.4',moments:[{start:1,end:2,notes:[52],strength:.8,shapes:[[-1,-1,2,-1,-1,-1],[12,-1,-1,-1,-1,-1]],choice:1,edited:true}],resultRange:[0,10],scale:{root:4,scale:'minorPentatonic',follow:false,frets:12,notes:[{pitchMidi:52,startTimeSeconds:1,durationSeconds:1,amplitude:.8}],offset:0,duration:10,estimate:{candidates:[{root:4,mode:'minor',score:.8}],tentative:true}},complete:true,view:'tab',selected:0,speed:75});
test('portable project round trip preserves recording, edited shape, scale and key exactly',async()=>{
 const original=fixture(),audio=new Uint8Array([1,2,3,4,5]).buffer;
 const decoded=await lib.decodeProject(await(await lib.encodeProject(original,audio)).arrayBuffer());
 for(const key of Object.keys(original))assert.equal(JSON.stringify(decoded.project[key]),JSON.stringify(original[key]),key);
 assert.deepEqual(new Uint8Array(decoded.audio),new Uint8Array(audio));
});
test('partial projects remain partial and can include silence',async()=>{
 const p=fixture();p.complete=false;p.resultRange=[0,8];p.scale.duration=8;p.moments=[];p.scale.notes=[];p.scale.estimate=null;
 const decoded=await lib.decodeProject(await(await lib.encodeProject(p,new Uint8Array([1]).buffer)).arrayBuffer());
 assert.equal(decoded.project.complete,false);assert.equal(decoded.project.scale.duration,8);
});
test('reject unsupported, malformed or misleading saved analysis',()=>{
 const invalid=[p=>p.version=99,p=>p.scale.root=-1,p=>p.scale.scale='__proto__',p=>p.moments[0].choice=3,p=>p.moments[0].shapes[0][2]=25,p=>p.moments[0].shapes[0][2]=3,p=>p.scale.notes[0].startTimeSeconds=11,p=>p.scale.duration=8,p=>p.moments[0].start=-1,p=>p.scale.estimate.candidates[0].score=NaN];
 for(const change of invalid){const p=fixture();change(p);assert.throws(()=>lib.validateProject(p),/Invalid project/);}
});
test('truncation, bad headers and modified embedded audio are rejected',async()=>{
 const good=await(await lib.encodeProject(fixture(),new Uint8Array([1,2,3]).buffer)).arrayBuffer();
 await assert.rejects(lib.decodeProject(good.slice(0,8)),/truncated/);
 await assert.rejects(lib.decodeProject(good.slice(0,-1)),/truncated/);
 const damaged=good.slice(0);new Uint8Array(damaged)[damaged.byteLength-1]^=1;
 await assert.rejects(lib.decodeProject(damaged),/checksum/);
 const bad=good.slice(0);new DataView(bad).setUint32(8,0xffffffff,true);
 await assert.rejects(lib.decodeProject(bad),/header length/);
});
