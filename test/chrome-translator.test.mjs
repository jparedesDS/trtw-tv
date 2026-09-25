// La Translator API no existe en Node: se simula en globalThis.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeTranslator } from '../extension/lib/chrome-translator.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { delete globalThis.Translator; });

function fakeApi(availability, createDelayMs = 0) {
  const api = { created: 0, destroyed: 0 };
  api.availability = async () => availability;
  api.create = () => {
    api.created++;
    const t = { translate: async (x) => x, destroy: () => api.destroyed++ };
    return createDelayMs ? sleep(createDelayMs).then(() => t) : Promise.resolve(t);
  };
  globalThis.Translator = api;
  return api;
}

test('sin la API → no-api', async () => {
  const r = await createChromeTranslator();
  assert.equal(r.translator, null);
  assert.equal(r.availability, 'no-api');
});

test("'downloadable' sin gesto: no llama a create() (se colgaría)", async () => {
  const api = fakeApi('downloadable');
  const r = await createChromeTranslator();
  assert.equal(r.translator, null);
  assert.equal(api.created, 0);
  const r2 = await createChromeTranslator({ allowDownload: true });
  assert.ok(r2.translator);
  assert.equal(api.created, 1);
});

test('si create() llega tarde (timeout), el traductor huérfano se destruye', async () => {
  const api = fakeApi('available', 40);
  const r = await createChromeTranslator({ timeouts: { createMs: 5 } });
  assert.equal(r.translator, null);
  assert.match(r.error, /tiempo agotado/);
  await sleep(60);
  assert.equal(api.destroyed, 1);
});
