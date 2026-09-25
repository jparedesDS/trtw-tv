import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StreamingResampler } from '../extension/lib/resampler.js';

function sine(freq, rate, n, amp = 0.5) {
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / rate));
}

// Amplitud de una frecuencia concreta (DFT de un solo bin).
function toneAmplitude(x, freq, rate) {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) {
    re += x[i] * Math.cos((2 * Math.PI * freq * i) / rate);
    im -= x[i] * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

function runInBlocks(rs, input, block = 128) {
  const parts = [];
  for (let i = 0; i < input.length; i += block) parts.push(rs.process(input.subarray(i, i + block)));
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

for (const rate of [48000, 44100]) {
  test(`${rate} Hz → 16 kHz conserva la voz y elimina el aliasing`, () => {
    const n = rate * 2;
    const rs = new StreamingResampler(rate, 16000);
    const out = runInBlocks(rs, sine(1000, rate, n));
    // Longitud esperada (± retardo del filtro)
    assert.ok(Math.abs(out.length - 32000) < 40, `longitud ${out.length}`);
    const body = out.subarray(200, out.length - 200);
    const amp = toneAmplitude(body, 1000, 16000);
    assert.ok(Math.abs(amp - 0.5) < 0.02, `amplitud 1 kHz = ${amp}`);

    // Un tono de 12 kHz (por encima de Nyquist de salida) debe desaparecer.
    const rs2 = new StreamingResampler(rate, 16000);
    const out2 = runInBlocks(rs2, sine(12000, rate, n));
    const alias = toneAmplitude(out2.subarray(200, out2.length - 200), 4000, 16000);
    assert.ok(alias < 0.01, `aliasing a 4 kHz = ${alias}`);
  });
}

test('16 kHz → 16 kHz es transparente', () => {
  const rs = new StreamingResampler(16000, 16000);
  const x = sine(440, 16000, 1000);
  assert.deepEqual(Array.from(rs.process(x)), Array.from(x));
});
