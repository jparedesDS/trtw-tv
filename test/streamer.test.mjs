import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Streamer, dedupeOverlap, normalizeText } from '../extension/lib/streamer.js';

const SR = 16000;
const FRAME = 512;

// Guion: frases con tiempos absolutos (s). Las palabras se reparten uniformemente.
function makeScript(sentences) {
  return sentences.map(([start, end, text]) => {
    const words = text.split(' ');
    const d = (end - start) / words.length;
    return { start, end, text, words: words.map((w, i) => ({ w, mid: start + d * (i + 0.5) })) };
  });
}

// ASR simulado: cada muestra vale su índice absoluto, así sabemos qué trozo nos pasan.
function mockAsr(script, calls) {
  return {
    async transcribe(audio) {
      const absStart = audio[0] / SR;
      const absEnd = (audio[audio.length - 1] + 1) / SR;
      calls.push([absStart, absEnd]);
      const segments = [];
      for (const s of script) {
        const heard = s.words.filter((x) => x.mid >= absStart && x.mid < absEnd);
        if (!heard.length) continue;
        const complete = heard.length === s.words.length && s.end <= absEnd;
        segments.push({
          start: Math.max(0, s.start - absStart),
          end: complete ? s.end - absStart : null,
          text: heard.map((x) => x.w).join(' '),
          avgLogprob: -0.2
        });
        if (!complete) break;
      }
      return { segments, noSpeechProb: 0.01, avgLogprob: -0.2, timeMs: 5 };
    }
  };
}

// VAD simulado: voz dentro de los intervalos dados.
function mockVad(intervals) {
  return {
    reset() {},
    async process(frame) {
      const t = frame[0] / SR;
      return intervals.some(([a, b]) => t >= a && t < b) ? 0.9 : 0.05;
    }
  };
}

async function run({ script, speech, totalSec, config }) {
  const commits = [];
  const rejects = [];
  const partials = [];
  const calls = [];
  const s = new Streamer({
    vad: mockVad(speech),
    asr: mockAsr(makeScript(script), calls),
    config,
    onCommit: (c) => commits.push(c),
    onReject: (r) => rejects.push(r),
    onPartial: (p) => partials.push(p.text)
  });
  const total = Math.floor((totalSec * SR) / FRAME);
  for (let f = 0; f < total; f++) {
    const frame = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) frame[i] = f * FRAME + i;
    s.pushFrame(frame);
    await s.idle(); // "ASR infinitamente rápido": comportamiento determinista
  }
  await s.flush();
  return { commits, rejects, partials, calls };
}

test('dos frases separadas por una pausa → dos confirmaciones, en orden', async () => {
  const { commits } = await run({
    script: [[0.5, 2.5, 'hello there my friends'], [4.0, 6.0, 'welcome to the stream']],
    speech: [[0.5, 2.5], [4.0, 6.0]],
    totalSec: 8
  });
  assert.deepEqual(commits.map((c) => c.text), ['hello there my friends', 'welcome to the stream']);
});

test('habla continua larga: confirma por acuerdo antes del final y sin locuciones > máximo', async () => {
  const sentences = [];
  for (let i = 0; i < 8; i++) {
    const a = 0.5 + i * 2.5;
    sentences.push([a, a + 2.5, `sentence number ${i} is here now`]);
  }
  const { commits, calls } = await run({ script: sentences, speech: [[0.5, 20.5]], totalSec: 22 });
  assert.deepEqual(commits.map((c) => c.text), sentences.map((s) => s[2]));
  // Ninguna petición al ASR supera el máximo (9 s + margen de una trama).
  for (const [a, b] of calls) assert.ok(b - a <= 9.1, `ventana de ${(b - a).toFixed(2)} s`);
  // La primera frase se confirma mucho antes de que acabe el habla.
  const first = commits[0].endSample / SR;
  assert.ok(first < 3.5);
});

test('un golpe corto (< 250 ms) no genera transcripción', async () => {
  const { commits, calls } = await run({ script: [], speech: [[1.0, 1.1]], totalSec: 3 });
  assert.equal(commits.length, 0);
  assert.equal(calls.length, 0);
});

test('el filtro puede rechazar segmentos', async () => {
  const commits = [];
  const rejects = [];
  const s = new Streamer({
    vad: mockVad([[0.5, 2.0]]),
    asr: mockAsr(makeScript([[0.5, 2.0, 'thank you for watching']]), []),
    filter: (seg) => ({ text: seg.text, reject: /watching/.test(seg.text), reason: 'frase típica' }),
    onCommit: (c) => commits.push(c),
    onReject: (r) => rejects.push(r)
  });
  for (let f = 0; f < 120; f++) {
    const frame = new Float32Array(FRAME).map((_, i) => f * FRAME + i);
    s.pushFrame(frame);
    await s.idle();
  }
  await s.flush();
  assert.equal(commits.length, 0);
  assert.equal(rejects.length, 1);
  assert.equal(rejects[0].reason, 'frase típica');
});

test('un error del ASR no detiene el streamer', async () => {
  let fail = true;
  const commits = [];
  const errors = [];
  const inner = mockAsr(makeScript([[0.5, 2.0, 'still alive'], [3.0, 4.5, 'after error']]), []);
  const s = new Streamer({
    vad: mockVad([[0.5, 2.0], [3.0, 4.5]]),
    asr: { transcribe: (a) => (fail ? ((fail = false), Promise.reject(new Error('boom'))) : inner.transcribe(a)) },
    config: { firstRunMs: 99999 }, // solo transcripciones finales
    onCommit: (c) => commits.push(c.text),
    onError: (e) => errors.push(e.message)
  });
  for (let f = 0; f < 200; f++) {
    s.pushFrame(new Float32Array(FRAME).map((_, i) => f * FRAME + i));
    await s.idle();
  }
  await s.flush();
  assert.deepEqual(errors, ['boom']);
  assert.deepEqual(commits, ['after error']);
});

test('dedupeOverlap quita palabras repetidas en el corte', () => {
  assert.equal(dedupeOverlap('we are going to the store', 'the store and then home'), 'and then home');
  assert.equal(dedupeOverlap('I said no', 'no way'), 'no way'); // palabra corta: se respeta
  assert.equal(dedupeOverlap('', 'hola'), 'hola');
  assert.equal(normalizeText("Don't STOP, now!"), "don't stop now");
});
