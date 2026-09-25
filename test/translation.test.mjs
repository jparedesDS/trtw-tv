import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlossary, protect, restore } from '../extension/lib/glossary.js';
import { TranslationService } from '../extension/lib/translator.js';

const quiet = { info() {}, warn() {}, debug() {}, error() {} };

test('glosario: parseo, protección y restauración', () => {
  const g = parseGlossary('gg\n# comentario\n\nclutch\nheadshot = tiro a la cabeza\nPog Champ');
  assert.deepEqual(g.map((e) => e.term), ['Pog Champ', 'headshot', 'clutch', 'gg']);
  const p = protect('GG, that clutch headshot was pog champ! eggs', g);
  assert.equal(p.text, 'ZQX0, that ZQX1 ZQX2 was ZQX3! eggs'); // "eggs" no contiene "gg" como palabra
  assert.deepEqual(p.slots, ['GG', 'clutch', 'tiro a la cabeza', 'pog champ']);
  const r = restore('ZQX0, ese zqx 1 ZQX2 fue ZQX3!', p.slots);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'GG, ese clutch tiro a la cabeza fue pog champ!');
  assert.equal(restore('se perdió uno ZQX0', p.slots).ok, false);
});

// Motor falso a través del relé (en Node no existe la Translator API).
function fakeService(dict, calls = []) {
  const relay = async (op, text) => {
    if (op === 'probe') return { ok: true };
    calls.push(text);
    const out = text.split('\n').map((line) => line.split(' ').map((w) => dict[w.toLowerCase()] ?? w).join(' ')).join('\n');
    return { ok: true, text: out };
  };
  return new TranslationService({ asrClient: null, relay, log: quiet });
}

test('traducción con contexto: se usa la segunda línea', async () => {
  const calls = [];
  const svc = fakeService({ hello: 'hola', friends: 'amigos', good: 'buen', game: 'juego' }, calls);
  const { engine } = await svc.init('auto');
  assert.equal(engine, 'chrome-tab');
  assert.equal(svc.fast, true);
  assert.equal(await svc.translate('good game', 'hello friends'), 'buen juego');
  assert.deepEqual(calls, ['hello friends\ngood game']);
  // Caché: la segunda vez no llama al motor
  await svc.translate('good game', 'hello friends');
  assert.equal(calls.length, 1);
});

test('glosario dentro del servicio y sin contexto', async () => {
  const svc = fakeService({ that: 'eso', was: 'fue', a: 'un' });
  await svc.init('auto');
  svc.useContext = false;
  svc.setGlossary('clutch');
  assert.equal(await svc.translate('that was a clutch', 'ignored'), 'eso fue un clutch');
});

test('si el motor rompe el contexto (≠ 2 líneas) se traduce la frase sola', async () => {
  const calls = [];
  const relay = async (op, text) => {
    if (op === 'probe') return { ok: true };
    calls.push(text);
    return { ok: true, text: text.replace('\n', ' ').toUpperCase() };
  };
  const svc = new TranslationService({ asrClient: null, relay, log: quiet });
  await svc.init('auto');
  assert.equal(await svc.translate('b', 'a'), 'B');
  assert.deepEqual(calls, ['a\nb', 'b']);
});

test('sin traductor disponible → null (se mostrará el inglés)', async () => {
  const svc = new TranslationService({
    asrClient: { loadMt: async () => { throw new Error('offline'); } },
    relay: null,
    log: quiet
  });
  const r = await svc.init('auto');
  assert.equal(r.engine, 'none');
  assert.ok(r.warning);
  assert.equal(await svc.translate('hello'), null);
  svc.dispose();
});
