// Carga el modelo Silero incluido en la extensión con onnxruntime-node
// (dependencia de transformers.js) y comprueba la interfaz.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { SileroVad } from '../extension/lib/vad.js';

const require = createRequire(import.meta.url);
let ort = null;
try {
  ort = require(require.resolve('onnxruntime-node', { paths: [require.resolve('@huggingface/transformers')] }));
} catch { /* sin binarios nativos: se omite */ }

test('Silero VAD: silencio y ruido suave dan probabilidad baja', { skip: !ort && 'onnxruntime-node no disponible' }, async () => {
  const model = await readFile(new URL('../extension/models/silero/silero_vad_v5.onnx', import.meta.url));
  const vad = await SileroVad.create(ort, model, ['cpu']);
  let p = 1;
  for (let i = 0; i < 20; i++) p = await vad.process(new Float32Array(512));
  assert.ok(p >= 0 && p < 0.1, `silencio: ${p}`);
  for (let i = 0; i < 20; i++) p = await vad.process(Float32Array.from({ length: 512 }, () => (Math.random() - 0.5) * 0.02));
  assert.ok(p < 0.2, `ruido: ${p}`);
  vad.reset();
  await assert.rejects(() => vad.process(new Float32Array(100)));
});

// jfk.wav: fragmento del discurso inaugural de J. F. Kennedy (1961, dominio
// público), 16 kHz mono, el mismo que usa whisper.cpp como ejemplo.
async function readWav16k(path) {
  const buf = await readFile(new URL(path, import.meta.url));
  const dataOff = buf.indexOf('data') + 8;
  const n = (buf.length - dataOff) >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * 2) / 32768;
  return out;
}

test('Silero VAD detecta la voz del ejemplo de JFK y los silencios entre frases', { skip: !ort && 'onnxruntime-node no disponible' }, async () => {
  const model = await readFile(new URL('../extension/models/silero/silero_vad_v5.onnx', import.meta.url));
  const vad = await SileroVad.create(ort, model, ['cpu']);
  const audio = await readWav16k('./fixtures/jfk.wav');
  const probs = [];
  for (let i = 0; i + 512 <= audio.length; i += 512) probs.push(await vad.process(audio.subarray(i, i + 512)));
  const speech = probs.filter((p) => p >= 0.5).length / probs.length;
  // ~11 s de audio con pausas: la mayoría es voz, pero no todo.
  assert.ok(speech > 0.4 && speech < 0.95, `fracción de voz ${speech.toFixed(2)}`);
  // Hay al menos una pausa (≥ 300 ms seguidos sin voz) en mitad del discurso.
  let run = 0, pauses = 0;
  for (const p of probs.slice(20, -20)) {
    run = p < 0.35 ? run + 1 : 0;
    if (run === 10) pauses++;
  }
  assert.ok(pauses >= 1, 'sin pausas detectadas');
});

test('Silero VAD: llamadas simultáneas se serializan y reset() descarta lo anterior', { skip: !ort && 'onnxruntime-node no disponible' }, async () => {
  const model = await readFile(new URL('../extension/models/silero/silero_vad_v5.onnx', import.meta.url));
  const audio = await readWav16k('./fixtures/jfk.wav');
  const frames = [];
  for (let i = 0; i < 40; i++) frames.push(audio.slice(16000 + i * 512, 16000 + (i + 1) * 512));

  const a = await SileroVad.create(ort, model, ['cpu']);
  const sequential = [];
  for (const f of frames) sequential.push(await a.process(f));

  const b = await SileroVad.create(ort, model, ['cpu']);
  const concurrent = await Promise.all(frames.map((f) => b.process(f)));
  assert.deepEqual(concurrent, sequential, 'mismo resultado que en secuencia');

  // Tramas encoladas antes de reset(): se ignoran (0) y no contaminan el estado nuevo.
  const stale = frames.map((f) => b.process(f));
  b.reset();
  const fresh = [];
  for (const f of frames) fresh.push(await b.process(f));
  assert.ok((await Promise.all(stale)).slice(1).every((p) => p === 0));
  assert.deepEqual(fresh, sequential);
});
