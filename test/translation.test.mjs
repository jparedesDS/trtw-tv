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
  return new TranslationService({ getMtClient: null, relay, log: quiet });
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
  const svc = new TranslationService({ getMtClient: null, relay, log: quiet });
  await svc.init('auto');
  assert.equal(await svc.translate('b', 'a'), 'B');
  assert.deepEqual(calls, ['a\nb', 'b']);
});

test('sin traductor disponible → null (se mostrará el inglés)', async () => {
  const svc = new TranslationService({
    getMtClient: () => ({ loadMt: async () => { throw new Error('offline'); } }),
    relay: null,
    log: quiet
  });
  const r = await svc.init('auto');
  assert.equal(r.engine, 'none');
  assert.ok(r.warning);
  assert.equal(await svc.translate('hello'), null);
  svc.dispose();
});

// ── Ciclo de vida del motor (init no bloqueante, reintentos, dispose) ──

const FAST = { retryFastMs: 10, retrySlowMs: 20, maxDownloadWaitMs: 60, translateMs: 200 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Relé cuya respuesta a 'probe' la decide `probe(n)` (n = nº de sondeo).
function scriptedRelay(probe) {
  const state = { probes: 0 };
  state.relay = async (op, text) => {
    if (op === 'probe') return probe(++state.probes);
    return { ok: true, text: `es:${text}` };
  };
  return state;
}

function fakeMt(state = {}) {
  return () => ({
    loadMt: async () => { state.loads = (state.loads || 0) + 1; },
    translate: async (texts) => texts.map((t) => `opus:${t}`)
  });
}

test('Chrome descargando: init no espera (inglés) y cambia a Chrome cuando está listo', async () => {
  const r = scriptedRelay((n) => (n < 3 ? { ok: false, availability: 'downloading' } : { ok: true }));
  const changes = [];
  const svc = new TranslationService({ getMtClient: fakeMt(), relay: r.relay, log: quiet, timings: FAST });
  svc.onEngineChange = (c) => changes.push(c.engine);
  const t0 = Date.now();
  const res = await svc.init('auto');
  assert.ok(Date.now() - t0 < 50, 'init no debe bloquear');
  assert.equal(res.engine, 'none');
  assert.match(res.warning, /inglés/);
  assert.equal(await svc.translate('hi'), null); // se mostrará el inglés
  await sleep(80);
  assert.equal(svc.name, 'chrome-tab');
  assert.deepEqual(changes, ['chrome-tab']);
  svc.dispose();
});

test('Chrome descargando demasiado tiempo → Opus-MT', async () => {
  const r = scriptedRelay(() => ({ ok: false, availability: 'downloading' }));
  const changes = [];
  const svc = new TranslationService({ getMtClient: fakeMt(), relay: r.relay, log: quiet, timings: FAST });
  svc.onEngineChange = (c) => changes.push(c.engine);
  await svc.init('auto');
  await sleep(150);
  assert.equal(svc.name, 'opus');
  assert.ok(changes.includes('opus'));
  svc.dispose();
});

test('dispose() durante init: resultado obsoleto y ningún reintento posterior', async () => {
  const r = scriptedRelay(async () => { await sleep(20); return { ok: false, availability: 'downloadable' }; });
  const svc = new TranslationService({ getMtClient: fakeMt(), relay: r.relay, log: quiet, timings: FAST });
  const pending = svc.init('auto');
  svc.dispose();
  const res = await pending;
  assert.equal(res.stale, true);
  const probes = r.probes;
  await sleep(80);
  assert.equal(r.probes, probes, 'no debe seguir sondeando tras dispose()');
  assert.equal(svc.name, 'none');
});

test('dos init() a la vez: gana el último y no quedan reintentos del primero', async () => {
  const r = scriptedRelay(async () => { await sleep(20); return { ok: false, availability: 'downloadable' }; });
  const svc = new TranslationService({ getMtClient: fakeMt(), relay: r.relay, log: quiet, timings: FAST });
  const first = svc.init('auto');
  const second = svc.init('opus');
  assert.equal((await second).engine, 'opus');
  assert.equal((await first).stale, true);
  const probes = r.probes;
  await sleep(80);
  assert.equal(svc.name, 'opus');
  assert.equal(r.probes, probes, "con 'opus' no se reintenta Chrome");
  svc.dispose();
});

test("un 'downloading' antiguo de la pestaña no se arrastra si la pestaña deja de responder", async () => {
  const r = scriptedRelay((n) => {
    if (n === 1) return { ok: false, availability: 'downloading' };
    throw new Error('la pestaña no responde');
  });
  const svc = new TranslationService({ getMtClient: fakeMt(), relay: r.relay, log: quiet, timings: FAST });
  await svc._tryChromeTab();
  assert.equal(svc.downloading, true);
  await svc._tryChromeTab();
  assert.equal(svc.downloading, false);
});

test('al cambiar de motor se libera el anterior', async () => {
  let destroyed = 0;
  const svc = new TranslationService({ getMtClient: fakeMt(), relay: null, log: quiet, timings: FAST });
  svc._setEngine({ name: 'chrome', translate: async (t) => t, destroy: () => destroyed++ });
  svc._setEngine({ name: 'opus', translate: async (t) => t });
  assert.equal(destroyed, 1);
  svc.dispose();
});
