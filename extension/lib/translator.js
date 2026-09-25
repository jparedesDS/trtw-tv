// Servicio de traducción inglés → español, 100 % local.
//
// Motores, por orden de preferencia en modo automático:
//   1. 'chrome'     Translator API de Chrome en este mismo documento.
//   2. 'chrome-tab' La misma API, pero ejecutada en el content script de la
//                   pestaña (por si el documento offscreen no la expone).
//   3. 'opus'       Xenova/opus-mt-en-es con transformers.js (en su propio worker).
//
// init() nunca se queda esperando a Chrome: si Chrome está descargando su
// modelo, se empieza sin traductor (subtítulos en inglés) y se cambia a Chrome
// en cuanto esté listo; si tarda demasiado, se pasa a Opus-MT.
//
// Extras: glosario con marcadores, contexto (frase anterior) y caché.

import { createChromeTranslator } from './chrome-translator.js';
import { parseGlossary, buildMatcher, protect, restore } from './glossary.js';
import { withTimeout } from './async.js';

const OPUS_MODEL = 'Xenova/opus-mt-en-es';

export const TRANSLATOR_TIMINGS = {
  translateMs: 8000,        // máximo por traducción (y por consulta a la pestaña)
  retryFastMs: 3000,        // reintento mientras Chrome descarga su modelo
  retrySlowMs: 30000,       // reintento con Opus-MT activo, por si Chrome aparece
  maxDownloadWaitMs: 120000 // esperando a Chrome más de esto → Opus-MT
};

const dead = (availability) => availability === 'no-api' || availability === 'unavailable';

export class TranslationService {
  constructor({ getMtClient, relay, log, timings }) {
    this.getMtClient = getMtClient; // () => cliente del worker de Opus-MT (se crea al pedirlo)
    this.relay = relay;             // (op, text) => Promise<{ok, text, availability}> o null
    this.log = log;
    this.t = { ...TRANSLATOR_TIMINGS, ...timings };
    this.engine = null;
    this.cache = new Map();
    this.useContext = true;
    this.initGen = 0;               // solo la última llamada a init() aplica su resultado
    this.disposed = false;
    this.onEngineChange = null;     // ({ engine, warning }) cuando cambia el motor fuera de init()
    this.setGlossary('');
  }

  get name() {
    return this.engine?.name || 'none';
  }

  // Traductor rápido (Chrome) → se pueden traducir también los parciales.
  get fast() {
    return this.engine?.name === 'chrome' || this.engine?.name === 'chrome-tab';
  }

  // ¿Algún contexto informa de que Chrome está descargando su modelo?
  get downloading() {
    return this.availabilityHere === 'downloading' || this.availabilityTab === 'downloading';
  }

  setGlossary(text) {
    this.glossary = parseGlossary(text);
    this.matcher = buildMatcher(this.glossary);
    this.cache.clear();
  }

  _stale(gen) {
    return this.disposed || gen !== this.initGen;
  }

  // preference: 'auto' | 'chrome' | 'opus'.
  // Devuelve { engine, warning, stale }. stale = otra llamada posterior (o
  // dispose) la ha dejado sin efecto: el llamante debe ignorar el resultado.
  async init(preference = 'auto') {
    const gen = ++this.initGen;
    clearTimeout(this.retryTimer);
    this.preference = preference;
    this.waitingSince = null;

    if (preference !== 'opus') {
      const engine = await this._tryChrome();
      if (this._stale(gen)) return this._staleResult(engine);
      if (engine) {
        this._setEngine(engine);
        return { engine: engine.name, warning: null };
      }
      if (this.downloading) {
        // Chrome está descargando su modelo (lo inicia el clic en Start):
        // mientras tanto, subtítulos en inglés; no bloqueamos el arranque.
        this._setEngine(null);
        this.waitingSince = Date.now();
        this._scheduleChromeRetry(gen, this.t.retryFastMs);
        const warning = 'Chrome está descargando su traductor; mientras tanto, subtítulos en inglés.';
        this.log.info(warning);
        return { engine: 'none', warning };
      }
    }
    return this._useOpus(gen);
  }

  async _useOpus(gen) {
    let warning = this.preference === 'opus'
      ? null
      : 'La traducción integrada de Chrome no está disponible todavía; se usa Opus-MT (local).';
    try {
      const client = this.getMtClient();
      await client.loadMt(OPUS_MODEL);
      if (this._stale(gen)) return this._staleResult();
      this._setEngine({
        name: 'opus',
        context: false, // Marian no respeta saltos de línea: sin contexto
        translate: async (text) => (await client.translate([text]))[0]
      });
    } catch (e) {
      if (this._stale(gen)) return this._staleResult();
      this.log.error('No se pudo cargar Opus-MT:', e.message);
      this._setEngine(null);
      warning = 'No hay traductor disponible: se muestra el texto en inglés.';
    }
    if (warning) this.log.warn(warning);
    // Si Chrome puede aparecer más adelante (p. ej. tras descargar su modelo), reintentamos.
    if (this.preference !== 'opus' && this._chromeMayAppear()) this._scheduleChromeRetry(gen, this.t.retrySlowMs);
    return { engine: this.name, warning };
  }

  _staleResult(engine) {
    engine?.destroy?.();
    return { engine: this.name, warning: null, stale: true };
  }

  _chromeMayAppear() {
    return !(dead(this.availabilityHere) && (!this.relay || dead(this.availabilityTab)));
  }

  _setEngine(engine) {
    if (this.engine && this.engine !== engine) this.engine.destroy?.();
    this.engine = engine;
    this.cache.clear();
    this.log.info('Motor de traducción:', engine?.name || 'ninguno');
  }

  async _tryChrome() {
    return (await this._tryChromeHere()) || (await this._tryChromeTab());
  }

  async _tryChromeHere() {
    const r = await createChromeTranslator();
    this.availabilityHere = r.availability;
    if (!r.translator) {
      this.log.info(`Translator API aquí: ${r.availability}${r.error ? ' — ' + r.error : ''}`);
      return null;
    }
    return {
      name: 'chrome',
      context: true,
      translate: (text) => r.translator.translate(text),
      destroy: () => r.translator.destroy?.()
    };
  }

  async _tryChromeTab() {
    // Se reinicia en cada intento: si la pestaña deja de responder, no queremos
    // arrastrar un 'downloading' antiguo.
    this.availabilityTab = null;
    if (!this.relay) return null;
    try {
      const r = await withTimeout(this.relay('probe'), this.t.translateMs, 'relé');
      this.availabilityTab = r?.availability ?? null;
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
        const r = await withTimeout(this.relay('translate', text), this.t.translateMs, 'relé');
        if (!r?.ok) throw new Error(r?.error || 'fallo en la pestaña');
        return r.text;
      }
    };
  }

  // Reintenta Chrome en segundo plano. Solo el init() vigente puede programarlo.
  _scheduleChromeRetry(gen, ms) {
    if (this._stale(gen)) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      if (this._stale(gen) || this.fast) return;
      const engine = await this._tryChrome();
      if (this._stale(gen)) return void engine?.destroy?.();

      if (engine) {
        this._setEngine(engine);
        this.onEngineChange?.({ engine: engine.name, warning: null });
        return;
      }
      if (!this.engine) {
        // Sin motor porque esperábamos a Chrome: seguimos esperando un rato
        // y, si no llega, pasamos a Opus-MT.
        if (this.downloading) this.waitingSince ??= Date.now();
        if (this.downloading && Date.now() - this.waitingSince < this.t.maxDownloadWaitMs) {
          return this._scheduleChromeRetry(gen, this.t.retryFastMs);
        }
        const r = await this._useOpus(gen);
        if (!r.stale) this.onEngineChange?.(r);
        return;
      }
      this._scheduleChromeRetry(gen, this.downloading ? this.t.retryFastMs : this.t.retrySlowMs);
    }, ms);
  }

  // Traduce `text` usando `prev` (frase anterior en inglés) como contexto.
  // Devuelve null si no hay motor (se mostrará el inglés).
  async translate(text, prev = '') {
    if (!this.engine || !text) return null;
    const key = `${prev}\u0001${text}`;
    if (this.cache.has(key)) return this.cache.get(key);

    const engine = this.engine;
    const run = (t) => withTimeout(Promise.resolve(engine.translate(t)), this.t.translateMs, engine.name);
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
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.engine?.destroy?.();
    this.engine = null;
  }
}
