import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
const exports={};
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/transcription/scales.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{exports});
const {scaleNotes,estimateKey,fretboardPositions,activePitches}=exports;
const tuning=[40,45,50,55,59,64];
const note=(midi,start=0,duration=1,amplitude=.8)=>({pitchMidi:midi,startTimeSeconds:start,durationSeconds:duration,amplitude});

test('E minor pentatonic is E G A B D; natural minor adds F sharp and C',()=>{
 assert.equal(scaleNotes(4,'minorPentatonic').join(),'4,7,9,11,2');
 assert.equal(scaleNotes(4,'naturalMinor').join(),'4,6,7,9,11,0,2');
 assert.equal(scaleNotes(4,'minorBlues').join(),'4,7,9,10,11,2');
});
test('E minor pentatonic box at fret 12 has the familiar string pattern',()=>{
 const positions=fretboardPositions(tuning,0,4,'minorPentatonic',12,15,[]);
 const expected=['12,15','12,14','12,14','12,14','12,15','12,15'];
 // A and D strings include fret 12 from neighboring pattern notes too.
 for(let s=0;s<6;s++) assert.equal(positions.filter(p=>p.string===s&&p.inScale).map(p=>p.fret).join(),expected[s]);
});
test('roots, exact-pitch alternatives and outside notes are independent',()=>{
 const positions=fretboardPositions(tuning,0,4,'minorPentatonic',0,12,[52,58]);
 assert.ok(positions.filter(p=>p.active&&p.midi===52).length>1);
 assert.ok(positions.find(p=>p.midi===40).root);
 assert.equal(positions.find(p=>p.midi===40).active,false,'E2 should not light up for E3');
 assert.ok(positions.some(p=>p.active&&!p.inScale&&p.midi===58));
});
test('Drop D and capo change the actual pitches and respect the physical fret limit',()=>{
 const positions=fretboardPositions([38,45,50,55,59,64],2,4,'minorPentatonic',0,24,[]);
 assert.equal(positions.find(p=>p.string===0&&p.fret===0).midi,40);
 assert.ok(positions.every(p=>p.fret<=22));
 assert.ok(positions.find(p=>p.string===0&&p.fret===0).root);
});
test('a tonic-weighted E minor melody estimates E minor',()=>{
 const notes=[note(64,0,4),note(67,4,2),note(71,6,2),note(66,8,1),note(69,9,1),note(72,10,1),note(74,11,1),note(64,12,4)];
 const estimate=estimateKey(notes,16);
 assert.equal(estimate.candidates[0].root,4);
 assert.equal(estimate.candidates[0].mode,'minor');
 assert.equal(estimate.candidates.length,3);
});
test('tonic-weighted C major melody estimates C major',()=>{
 const notes=[note(60,0,4),note(64,4,2),note(67,6,2),note(62,8,1),note(65,9,1),note(69,10,1),note(71,11,1),note(60,12,4)];
 const estimate=estimateKey(notes,16);
 assert.equal(estimate.candidates[0].root,0);
 assert.equal(estimate.candidates[0].mode,'major');
});
test('silence, a lone note, uniform chromatic evidence and invalid data do not claim a key',()=>{
 for(const notes of [[],[note(64,0,10)],Array.from({length:12},(_,i)=>note(60+i)),[note(NaN)]]) assert.equal(estimateKey(notes,10),null);
});
test('a lone triad is a tentative estimate, not a confident song key',()=>{
 assert.equal(estimateKey([note(60),note(64),note(67)],2).tentative,true);
});
test('key evidence is clipped to the analyzed passage',()=>{
 assert.equal(estimateKey([note(60,10,5),note(64,10,5),note(67,10,5)],5),null);
});
test('highlights clear in rests, outside passage and at note releases',()=>{
 const notes=[note(64,1,.5),note(67,1.2,.5)];
 assert.equal(activePitches(notes,1.3,3).join(),'64,67');
 for(const t of [-1,0,1.7,3,10]) assert.equal(activePitches(notes,t,3).length,0);
 assert.equal(activePitches(notes,1.5,3).join(),'67');
});

test('scale choice follows characteristic notes, not a fixed minor default',()=>{
 const minor={root:4,mode:'minor',score:.9}, major={root:0,mode:'major',score:.9};
 const pent=[note(64,0,3),note(67),note(69),note(71),note(74)];
 assert.equal(exports.estimateScale(pent,10,minor),'minorPentatonic');
 assert.equal(exports.estimateScale([...pent,note(70)],10,minor),'minorBlues');
 assert.equal(exports.estimateScale([...pent,note(66),note(72)],10,minor),'naturalMinor');
 assert.equal(exports.estimateScale([...pent,note(70,0,.01)],10,minor),'minorPentatonic');
 const majorPent=[note(60,0,3),note(62),note(64),note(67),note(69)];
 assert.equal(exports.estimateScale(majorPent,10,major),'majorPentatonic');
 assert.equal(exports.estimateScale([...majorPent,note(65),note(71)],10,major),'major');
});
