import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const library = readFileSync(new URL('../src/audio/soundtouch-dist.js', import.meta.url), 'utf8')
  .replace(/^export\s*\{[^}]+\};\s*$/m, '');
const loader = readFileSync(new URL('../src/audio/worklet-loader.ts', import.meta.url), 'utf8');
const processor = loader.split('const processorCode = /* js */ `')[1].split('\n`;')[0];

function setup({ rate = 44100, seconds = 2, tempo = 1, pitch = 0 } = {}) {
  let Processor;
  const messages = [];
  vm.runInNewContext(library + '\n' + processor, {
    sampleRate: rate,
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: message => messages.push(message) }; }
    },
    registerProcessor: (_, ctor) => { Processor = ctor; },
  });
  const p = new Processor();
  const send = data => p.port.onmessage({ data });
  const signal = Float32Array.from({ length: Math.round(rate * seconds) },
    (_, i) => 0.5 * Math.sin(2 * Math.PI * 440 * i / rate));
  send({ type: 'audio', left: signal.buffer, right: signal.buffer });
  send({ type: 'tempo', value: tempo });
  send({ type: 'pitch', value: pitch });
  const block = () => {
    const left = new Float32Array(128), right = new Float32Array(128);
    p.process([], [[left, right]]);
    assert.deepEqual(left, right, 'identical stereo input stays identical');
    assert.ok(left.every(Number.isFinite));
    return left;
  };
  return { send, block, messages, rate };
}

for (const rate of [44100, 48000]) {
  for (const tempo of [0.1, 0.25, 0.5, 0.75, 1, 2]) {
    test(`duration and pitch at ${rate} Hz, ${tempo * 100}%`, () => {
      const { send, block, messages } = setup({ rate, tempo });
      send({ type: 'play' });
      const samples = [];
      const expected = 2 * rate / tempo;
      while (!messages.some(m => m.type === 'ended') && samples.length < expected + rate) {
        samples.push(...block());
      }
      assert.equal(messages.filter(m => m.type === 'ended').length, 1);
      assert.ok(Math.abs(samples.length - expected) < 128, 'ends within one render block');
      const segment = samples.slice(Math.floor(rate * .2), Math.floor(rate * .8));
      let crossings = 0;
      for (let i = 1; i < segment.length; i++) if (segment[i - 1] <= 0 && segment[i] > 0) crossings++;
      assert.ok(Math.abs(crossings * rate / segment.length - 440) < 4, 'pitch is preserved');
      const tail = samples.slice(Math.floor(expected - rate * .15 / tempo), Math.floor(expected - rate * .08 / tempo));
      assert.ok(Math.sqrt(tail.reduce((sum, x) => sum + x * x, 0) / tail.length) > .1,
        'real audio remains near the end, not just padded silence');
      assert.ok(block().every(x => x === 0));
      send({ type: 'play' });
      assert.ok(block().some(x => x !== 0), 'play restarts after EOF');
    });
  }
}

test('short loops keep producing audio without stopping or silent buffer resets', () => {
  const { send, block, messages, rate } = setup({ tempo: .5 });
  send({ type: 'loop', enabled: true, startFrame: 1000, endFrame: 1441 });
  send({ type: 'seek', frame: 1000 });
  send({ type: 'play' });
  for (let i = 0; i < 1000; i++) assert.ok(block().some(x => x !== 0));
  assert.equal(messages.filter(m => m.type === 'ended').length, 0);
  for (const m of messages.filter(m => m.type === 'position')) {
    assert.ok(m.frame >= 1000 && m.frame < 1441);
  }
  send({ type: 'loop', enabled: false, startFrame: 0, endFrame: rate * 2 });
  for (let i = 0; i < 1600; i++) block();
  assert.equal(messages.filter(m => m.type === 'ended').length, 1);
});

test('pause, seek, and tempo changes use the audible position', () => {
  const { send, block, messages, rate } = setup();
  send({ type: 'play' });
  for (let i = 0; i < 8; i++) block();
  assert.equal(messages.at(-1).frame, 1024);
  send({ type: 'pause' });
  assert.ok(block().every(x => x === 0));
  send({ type: 'seek', frame: rate });
  send({ type: 'tempo', value: .5 });
  send({ type: 'play' });
  let frames = 0;
  while (!messages.some(m => m.type === 'ended') && frames < rate * 3) {
    block(); frames += 128;
  }
  assert.ok(Math.abs(frames - rate * 2) < 128);
});

test('empty audio and invalid loops stay finite and terminate', () => {
  for (const seconds of [0, .01]) {
    const { send, block } = setup({ seconds });
    send({ type: 'loop', enabled: true, startFrame: 100, endFrame: 0 });
    send({ type: 'play' });
    for (let i = 0; i < 20; i++) block();
  }
});

for (const pitch of [-12, 12]) {
  test(`independent pitch control (${pitch} semitones) keeps the chosen duration`, () => {
    const { send, block, messages, rate } = setup({ tempo: .5, pitch });
    send({ type: 'play' });
    const samples = [];
    while (!messages.some(m => m.type === 'ended') && samples.length < rate * 5) samples.push(...block());
    assert.ok(Math.abs(samples.length - rate * 4) < 128);
    let crossings = 0;
    for (let i = rate; i < rate * 2; i++) if (samples[i - 1] <= 0 && samples[i] > 0) crossings++;
    assert.ok(Math.abs(crossings - 440 * 2 ** (pitch / 12)) < 4);
  });
}

test('changing tempo during playback does not skip the buffered source', () => {
  const { send, block, messages, rate } = setup();
  send({ type: 'play' });
  for (let i = 0; i < 100; i++) block();
  send({ type: 'tempo', value: .5 });
  let frames = 0;
  while (!messages.some(m => m.type === 'ended') && frames < rate * 4) {
    block(); frames += 128;
  }
  assert.ok(Math.abs(frames - (2 * rate - 12800) / .5) < 128);
});

test('loading new audio stops playback and resets an enabled loop', () => {
  const { send, block, messages, rate } = setup();
  send({ type: 'loop', enabled: true, startFrame: 100, endFrame: 1000 });
  send({ type: 'play' });
  block();
  const next = new Float32Array(rate / 10).fill(.25);
  send({ type: 'audio', left: next.buffer, right: next.buffer });
  assert.ok(block().every(x => x === 0));
  send({ type: 'play' });
  for (let i = 0; i < 100; i++) block();
  assert.equal(messages.filter(m => m.type === 'ended').length, 1);
});

test('final note is released from the stretch buffer', () => {
  const { send, block, messages, rate } = setup({ tempo: .5 });
  const input = new Float32Array(rate * 2);
  for (let i = input.length - rate * .08; i < input.length; i++) {
    input[i] = .5 * Math.sin(2 * Math.PI * 440 * i / rate);
  }
  send({ type: 'audio', left: input.buffer, right: input.buffer });
  send({ type: 'play' });
  const samples = [];
  while (!messages.some(m => m.type === 'ended') && samples.length < rate * 5) samples.push(...block());
  assert.ok(samples.slice(-rate * .3).some(x => Math.abs(x) > .2), 'last 80ms note is audible');
});
