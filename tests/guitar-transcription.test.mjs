import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/transcription/guitar.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});
const {fingerings,STANDARD,groupNotes,chordName,tabText}=exports;

test('open E minor retains detected pitches and prefers a compact open voicing',()=>{
 const notes=[40,47,52,55,59,64];
 const shapes=fingerings(notes);
 assert.ok(shapes.length>0);
 assert.equal(shapes[0].join(','),'0,2,2,0,0,0');
 for(const shape of shapes) assert.equal(shape.map((f,s)=>f<0?null:STANDARD[s]+f).filter(n=>n!==null).sort((a,b)=>a-b).join(),notes.join());
 assert.equal(chordName(notes),'Em');
});
test('a single pitch has multiple legal string positions',()=>{
 const shapes=fingerings([64]);
 assert.ok(shapes.length>1);
 for(const s of shapes) assert.equal(s.filter(f=>f>=0).length,1);
});
test('capo and Drop D pitches are reflected in fret assignments',()=>{
 const tuning=[38,45,50,55,59,64];
 const shapes=fingerings([40],tuning,2);
 assert.equal(shapes[0][0],0);
 assert.equal(fingerings([38],tuning,2).length,0);
});
test('recognition does not force an unfamiliar voicing into a major chord',()=>{
 assert.equal(chordName([60,64,67]),'C');
 assert.equal(chordName([64,67,72]),'C/E');
 assert.equal(chordName([60,61,66]),'C · C♯ · F♯');
});
test('strummed attacks form one moment and preserve selection offset',()=>{
 const raw=[40,47,52].map((pitchMidi,i)=>({pitchMidi,startTimeSeconds:.1+i*.02,durationSeconds:.7,amplitude:.8}));
 const moments=groupNotes(raw,12,2);
 assert.equal(moments.length,1);
 assert.equal(moments[0].start,12.1);
 assert.equal(moments[0].notes.join(),'40,47,52');
 assert.ok(moments[0].end<=14);
 const exported=tabText(moments,STANDARD,0);
 assert.ok(exported.includes('12.10'));
 assert.ok(exported.indexOf('\nE4  |')<exported.indexOf('\nE2  |')); // high string first
});
test('silence, out-of-range notes and sub-80ms detections do not produce shapes',()=>{
 assert.equal(groupNotes([],0,2).length,0);
 assert.equal(groupNotes([{pitchMidi:20,startTimeSeconds:0,durationSeconds:1,amplitude:1},{pitchMidi:64,startTimeSeconds:0,durationSeconds:.02,amplitude:1}],0,2).length,0);
});
test('octaves are not mislabeled as a major chord',()=>{
 assert.equal(chordName([40,52]),'E octaves');
});
