import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeSegment, cleanText, collapseRepetitions } from '../extension/lib/hallucination-filter.js';

const good = { noSpeechProb: 0.02, avgLogprob: -0.2, speechRatio: 0.9 };

test('texto normal pasa', () => {
  const r = judgeSegment({ text: ' I just clutched that round, no way!' }, good);
  assert.equal(r.reject, false);
  assert.equal(r.text, 'I just clutched that round, no way!');
});

test('anotaciones de sonido se limpian o se descartan', () => {
  assert.equal(cleanText('[Music] hello (laughs) there ♪'), 'hello there');
  assert.equal(judgeSegment({ text: '[MUSIC PLAYING]' }, good).reject, true);
  assert.equal(judgeSegment({ text: '♪ ♪ ♪' }, good).reject, true);
});

test('créditos de subtítulos siempre fuera', () => {
  assert.equal(judgeSegment({ text: 'Subtitles by the Amara.org community' }, good).reject, true);
  assert.equal(judgeSegment({ text: 'Transcribed by ESO, translated by —' }, good).reject, true);
});

test('"Thank you for watching" fuera si hay poca voz o poca confianza, dentro si es claro', () => {
  assert.equal(judgeSegment({ text: 'Thank you for watching!' }, { ...good, speechRatio: 0.3 }).reject, true);
  assert.equal(judgeSegment({ text: 'Thank you.' }, { ...good, noSpeechProb: 0.5 }).reject, true);
  assert.equal(judgeSegment({ text: 'Thank you.' }, good).reject, false);
});

test('regla de OpenAI: no_speech alto y logprob bajo', () => {
  const r = judgeSegment({ text: 'I am going to the shop' }, { noSpeechProb: 0.8, avgLogprob: -1.2, speechRatio: 0.9 });
  assert.equal(r.reject, true);
  assert.match(r.reason, /sin voz/);
});

test('confianza muy baja o sin voz según el VAD', () => {
  assert.equal(judgeSegment({ text: 'random words here' }, { ...good, avgLogprob: -2 }).reject, true);
  assert.equal(judgeSegment({ text: 'random words here' }, { ...good, speechRatio: 0.1 }).reject, true);
});

test('repeticiones: se colapsan y los bucles largos se descartan', () => {
  assert.equal(collapseRepetitions('no no no no no no way'), 'no no no way');
  assert.equal(collapseRepetitions('I think I think I think I think so'), 'I think I think I think so');
  const loop = Array(10).fill('we are the champions').join(' ');
  assert.equal(judgeSegment({ text: loop }, good).reject, true);
});

test('duplicado de la frase anterior', () => {
  const r = judgeSegment({ text: 'Let us go to the next round.' }, { ...good, previousText: 'let us go to the next round' });
  assert.equal(r.reject, true);
});

test('caracteres no latinos (modelo solo inglés) fuera', () => {
  assert.equal(judgeSegment({ text: 'ご視聴ありがとうございました' }, good).reject, true);
});
