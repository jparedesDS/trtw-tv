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
