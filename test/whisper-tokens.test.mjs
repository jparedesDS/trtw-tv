import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokensToSegments, logSumExp } from '../extension/lib/whisper-tokens.js';

// Vocabulario de juguete: ids < 100 son palabras, 100 = EOT, >= 200 timestamps.
const words = { 1: 'Hello', 2: ' world', 3: ' how', 4: ' are', 5: ' you' };
const decode = (ids) => ids.map((i) => words[i]).join('');
const opts = { timestampBegin: 200, eosTokenId: 100 };
const ts = (sec) => 200 + Math.round(sec / 0.02);

test('segmentos completos con timestamps en pares', () => {
  const toks = [ts(0), 1, 2, ts(1.2), ts(1.2), 3, 4, 5, ts(2.5), 100];
  const lps = toks.map(() => -0.1);
  const segs = tokensToSegments(toks, lps, decode, opts);
  assert.deepEqual(segs.map((s) => [s.start, s.end, s.text]), [
    [0, 1.2, 'Hello world'],
    [1.2, 2.5, 'how are you']
  ]);
  assert.ok(Math.abs(segs[0].avgLogprob + 0.1) < 1e-9);
});

test('último segmento sin cierre → incompleto (end = null)', () => {
  const toks = [ts(0), 1, 2, ts(1.2), ts(1.3), 3, 4, 100];
  const segs = tokensToSegments(toks, null, decode, opts);
  assert.equal(segs.length, 2);
  assert.equal(segs[1].start, 1.3);
  assert.equal(segs[1].end, null);
  assert.equal(segs[1].text, 'how are');
});

test('texto tras un único timestamp de cierre hereda el inicio', () => {
  const toks = [ts(0), 1, ts(0.8), 3, 5, ts(2), 100];
  const segs = tokensToSegments(toks, null, decode, opts);
  assert.deepEqual(segs.map((s) => [s.start, s.end]), [[0, 0.8], [0.8, 2]]);
});

test('sin timestamps: un único segmento incompleto', () => {
  const segs = tokensToSegments([1, 2, 100], null, decode, opts);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'Hello world');
  assert.equal(segs[0].end, null);
});

test('logSumExp es estable numéricamente', () => {
  const v = Float32Array.from([1000, 1000]);
  assert.ok(Math.abs(logSumExp(v) - (1000 + Math.log(2))) < 1e-3);
});
