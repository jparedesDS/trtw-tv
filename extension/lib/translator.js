// Servicio de traducción inglés → español, 100 % local.
//
// Motores, por orden de preferencia en modo automático:
//   1. 'chrome'     Translator API de Chrome en este mismo documento.
//   2. 'chrome-tab' La misma API, pero ejecutada en el content script de la
//                   pestaña (por si el documento offscreen no la expone).
//   3. 'opus'       Xenova/opus-mt-en-es con transformers.js (en el worker).
//
// Extras: glosario con marcadores, contexto (frase anterior) y caché.

import { createChromeTranslator } from './chrome-translator.js';
import { parseGlossary, buildMatcher, protect, restore } from './glossary.js';

const OPUS_MODEL = 'Xenova/opus-mt-en-es';
const RETRY_CHROME_MS = 30000;
const TIMEOUT_MS = 8000;

// Evita que una traducción colgada (p. ej. la pestaña no responde) bloquee la cola.
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: tiempo agotado`)), ms); })
  ]).finally(() => clearTimeout(timer));
}

export class TranslationService {
  constructor({ asrClient, relay, log, onProgress }) {
    this.asrClient = asrClient; // para Opus-MT (worker)
    this.relay = relay;         // (op, text) => Promise<{ok, text}> o null
    this.log = log;
    this.onProgress = onProgress || (() => {});
    this.engine = null;
    this.cache = new Map();
    this.useContext = true;
    this.setGlossary('');
  }

  get name() {
    return this.engine?.name || 'none';
  }

  // Traductor rápido (Chrome) → se pueden traducir también los parciales.
  get fast() {
    return this.engine?.name === 'chrome' || this.engine?.name === 'chrome-tab';
  }

  setGlossary(text) {
    this.glossary = parseGlossary(text);
    this.matcher = buildMatcher(this.glossary);
    this.cache.clear();
  }

  // preference: 'auto' | 'chrome' | 'opus'. Devuelve { engine, warning }.
  async init(preference = 'auto') {
    this.preference = preference;
    clearTimeout(this.retryTimer);
    let warning = null;

    if (preference !== 'opus') {
      let engine = (await this._tryChromeHere()) || (await this._tryChromeTab());
      // Si Chrome está descargando su modelo (lo inicia el clic en Start del
      // popup), esperamos un poco antes de recurrir a Opus-MT.
      for (let i = 0; !engine && this.downloading && i < 30; i++) {
        if (i === 0) this.log.info('Chrome está descargando su modelo de traducción; esperando…');
        this.onProgress({ stage: 'chrome', pct: null });
        await new Promise((r) => setTimeout(r, 2000));
        engine = (await this._tryChromeHere()) || (await this._tryChromeTab());
      }
      if (engine) {
        this._setEngine(engine);
        return { engine: engine.name, warning };
      }
      warning = 'La traducción integrada de Chrome no está disponible todavía; se usa Opus-MT (local).';
      this.log.warn(warning);
    }

    try {
      await this.asrClient.loadMt(OPUS_MODEL);
      this._setEngine({
        name: 'opus',
        context: false, // Marian no respeta saltos de línea: sin contexto
        translate: async (text) => (await this.asrClient.translate([text]))[0]
      });
    } catch (e) {
      this.log.error('No se pudo cargar Opus-MT:', e.message);
      this.engine = null;
      warning = 'No hay traductor disponible: se muestra el texto en inglés.';
    }

    // Si Chrome estaba descargando su modelo, reintentamos más tarde.
    if (preference !== 'opus') this._scheduleChromeRetry();
    return { engine: this.name, warning };
  }

  _setEngine(engine) {
    this.engine = engine;
    this.cache.clear();
    this.log.info('Motor de traducción:', engine.name);
  }

  // ¿Alguno de los dos contextos informa de una descarga en curso?
  get downloading() {
    return this.availabilityHere === 'downloading' || this.availabilityTab === 'downloading';
  }

  async _tryChromeHere() {
    const r = await createChromeTranslator();
    this.availabilityHere = r.availability;
    if (!r.translator) {
      this.log.info(`Translator API aquí: ${r.availability}${r.error ? ' — ' + r.error : ''}`);
      return null;
    }
    return { name: 'chrome', context: true, translate: (text) => r.translator.translate(text) };
  }

  async _tryChromeTab() {
    if (!this.relay) return null;
    try {
      const r = await withTimeout(this.relay('probe'), TIMEOUT_MS, 'relé');
      this.availabilityTab = r?.availability;
      if (!r?.ok) {
        this.log.info(`Translator API en la pestaña: ${r?.availability || r?.error || 'no'}`);
        return null;
      }
    } catch (e) {
      this.log.info('Sin relé a la pestaña:', e.message);
      return null;
    }
    return {
      name: 'chrome-tab',
      context: true,
      translate: async (text) => {
        const r = await withTimeout(this.relay('translate', text), TIMEOUT_MS, 'relé');
        if (!r?.ok) throw new Error(r?.error || 'fallo en la pestaña');
        return r.text;
      }
    };
  }

  _scheduleChromeRetry() {
    this.retryTimer = setTimeout(async () => {
      if (this.fast || this.preference === 'opus') return;
      const engine = (await this._tryChromeHere()) || (await this._tryChromeTab());
      if (engine) {
        this._setEngine(engine);
        this.onEngineChange?.(engine.name);
      } else {
        this._scheduleChromeRetry();
      }
    }, RETRY_CHROME_MS);
  }

  // Traduce `text` usando `prev` (frase anterior en inglés) como contexto.
  async translate(text, prev = '') {
    if (!this.engine || !text) return null;
    const key = `${prev}\u0001${text}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const engine = this.engine;
    const run = (t) => withTimeout(Promise.resolve(engine.translate(t)), TIMEOUT_MS, engine.name);
    const { text: prot, slots } = protect(text, this.glossary, this.matcher);
    let out = null;

    if (this.useContext && prev && engine.context) {
      // "frase anterior \n frase actual" → nos quedamos con la segunda línea.
      const joined = await run(`${prev}\n${prot}`);
      const lines = String(joined).split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length === 2) out = lines[1];
    }
    if (out == null) out = await run(prot);

    let r = restore(out, slots);
    if (!r.ok) {
      // El traductor se comió algún marcador: traducimos sin proteger.
      this.log.debug('Marcadores perdidos, traduciendo sin glosario:', out);
      r = { text: await run(text) };
    }
    const result = r.text.replace(/\s+/g, ' ').trim();

    this.cache.set(key, result);
    if (this.cache.size > 300) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  dispose() {
    clearTimeout(this.retryTimer);
  }
}
