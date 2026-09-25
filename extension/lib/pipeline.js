// Pipeline de subtítulos: VAD → Streamer (Whisper en worker) → subtítulos.
// Lo usan el documento offscreen y la página de test (mismo código).

import * as ort from 'onnxruntime-web';
import { InferenceClient } from './inference-client.js';
import { SileroVad } from './vad.js';
import { Streamer } from './streamer.js';
import { judgeSegment } from './hallucination-filter.js';
import { TranslationService } from './translator.js';
import { createLogger } from './log.js';

const log = createLogger('pipeline');

export class Pipeline {
  constructor({ baseUrl, settings, tabRelay, onStatus, onSubtitle, onFatal, onDebug }) {
    this.baseUrl = baseUrl;
    this.settings = { ...settings };
    this.onStatus = onStatus || (() => {});
    this.onSubtitle = onSubtitle || (() => {});
    this.onFatal = onFatal || (() => {});
    this.onDebug = onDebug || (() => {});
    this.ready = false;
    this.loaded = null; // { modelId, device } realmente cargados
    this.seq = 0;
    this.prevEn = '';                    // última frase confirmada (contexto)
    this.finalChain = Promise.resolve(); // traducciones definitivas, en orden
    this.partialPending = null;
    this.partialBusy = false;
    this.latencyMs = null;

    this.asrLoading = false;

    const progress = (p) => ({ progress: { stage: p.stage, pct: p.pct, loaded: p.loaded, total: p.total } });
    this.asr = new InferenceClient({ baseUrl, onProgress: (p) => this.onStatus(progress(p)) });
    this.mt = null; // worker de Opus-MT: solo se crea si hace falta
    this._newMtClient = () => new InferenceClient({
      baseUrl,
      // Mientras se descarga Whisper, la barra de progreso es suya.
      onProgress: (p) => { if (!this.asrLoading) this.onStatus(progress(p)); }
    });

    this.translator = new TranslationService({
      getMtClient: () => (this.mt ??= this._newMtClient()),
      relay: tabRelay || null,
      log
    });
    this.translator.onEngineChange = ({ engine, warning }) => {
      if (!this.disposed) this.onStatus({ engine, warning, ...(this.asrLoading ? {} : { progress: null }) });
    };
    this._applyTranslationSettings();
  }

  isCompatible(s) {
    return s.modelId === this.settings.modelId && s.device === this.settings.device;
  }

  // Idempotente: si ya se está cargando, devuelve la misma promesa.
  load() {
    this.loading ??= this._load().catch((e) => {
      this.loading = null;
      throw e;
    });
    return this.loading;
  }

  async _load() {
    this.asrLoading = true;
    // El traductor se prepara en paralelo (en su propio worker si es Opus-MT)
    // y nunca bloquea: hasta que esté listo, los subtítulos salen en inglés.
    this._initTranslator();

    // ORT del hilo principal: solo para el VAD (diminuto) → 1 hilo, WASM local.
    ort.env.wasm.wasmPaths = this.baseUrl + 'vendor/ort/';
    ort.env.wasm.numThreads = 1;
    this.vad = await SileroVad.create(ort, this.baseUrl + 'models/silero/silero_vad_v5.onnx');
    this._checkDisposed();
    log.info('Silero VAD listo');

    let info;
    try {
      await this.asr.ready;
      this._checkDisposed();
      info = await this.asr.loadAsr(this.settings.modelId, this.settings.device);
      this._checkDisposed();
    } finally {
      this.asrLoading = false;
    }
    this.loaded = info;
    log.info(`Whisper: ${info.modelId} en ${info.device}`, info.gpuName || '', info.gpuReason || '');
    this.onStatus({
      device: info.device,
      gpuName: info.gpuName,
      gpuReason: info.gpuReason,
      modelId: info.modelId,
      progress: null
    });

    this.streamer = new Streamer({
      vad: this.vad,
      asr: this.asr,
      filter: (seg, ctx) => judgeSegment(seg, ctx),
      log,
      onPartial: (p) => this._partial(p),
      onCommit: (c) => this._commit(c),
      onReject: (r) => {
        log.debug(`Descartado (${r.reason}):`, r.text);
        this.onDebug({ type: 'reject', ...r });
      },
      onStats: (stats) => this.onStatus({
        stats: { latencyMs: this.latencyMs == null ? null : Math.round(this.latencyMs), asrMs: Math.round(stats.asrMs), rtf: stats.rtf }
      }),
      onError: (e, fatal) => {
        if (fatal) this.onFatal(new Error(`Whisper falla repetidamente: ${e.message}`));
      }
    });
    this.ready = true;
  }

  // Si se descarta el pipeline a mitad de carga, abortamos en lugar de
  // terminar de montar un pipeline muerto.
  _checkDisposed() {
    if (!this.disposed) return;
    this.vad?.release().catch(() => {}); // pudo crearse después de dispose()
    throw new Error('Pipeline descartado durante la carga');
  }

  // Nunca lanza. Si otra llamada posterior la adelanta, su resultado se ignora.
  async _initTranslator() {
    try {
      const r = await this.translator.init(this.settings.translationEngine);
      if (r.stale || this.disposed) return;
      this.onStatus({ engine: r.engine, warning: r.warning, ...(this.asrLoading ? {} : { progress: null }) });
    } catch (e) {
      log.warn('Traductor:', e.message);
    }
  }

  _applyTranslationSettings() {
    this.translator.setGlossary(this.settings.glossary);
    this.translator.useContext = this.settings.translateWithContext !== false;
  }

  updateSettings(s) {
    const engineChanged = s.translationEngine && s.translationEngine !== this.settings.translationEngine;
    this.settings = { ...this.settings, ...s };
    this._applyTranslationSettings();
    if (engineChanged && this.loading) this._initTranslator();
  }

  pushFrame(frame) {
    if (this.ready) this.streamer.pushFrame(frame);
  }

  // Al empezar en otra pestaña: el relé de traducción apunta a la pestaña nueva,
  // así que volvemos a elegir motor si dependíamos de ella. No bloquea.
  prepareForTab() {
    this.resetStream();
    if (this.translator.name === 'chrome-tab' || this.translator.name === 'none') this._initTranslator();
  }

  resetStream() {
    this.streamer?.reset();
    this.prevEn = '';
    this.partialPending = null;
  }

  // ── Parciales (texto provisional, gris) ────────────────────
  // Solo se traducen si el traductor es rápido (Chrome); con Opus-MT se
  // muestran en inglés para no competir con Whisper en el worker.
  // "El último gana": si llegan varios mientras se traduce, solo cuenta el último.

  _partial({ text }) {
    if (!this.settings.showPartial) return;
    if (!text || !this.translator.fast) {
      this.partialPending = null;
      this.onSubtitle({ kind: 'partial', en: text, es: null });
      return;
    }
    this.partialPending = text;
    if (!this.partialBusy) this._drainPartial();
  }

  async _drainPartial() {
    this.partialBusy = true;
    while (this.partialPending) {
      const text = this.partialPending;
      const seq = this.seq;
      this.partialPending = null;
      let es = null;
      try {
        es = await this.translator.translate(text, this.prevEn);
      } catch { /* el parcial se muestra en inglés */ }
      // Si mientras tanto se confirmó una frase, este parcial ya está viejo.
      if (seq === this.seq && !this.partialPending) this.onSubtitle({ kind: 'partial', en: text, es });
    }
    this.partialBusy = false;
  }

  // ── Definitivos ────────────────────────────────────────────

  _commit(c) {
    const id = ++this.seq;
    const t0 = performance.now();
    const prev = this.prevEn;
    this.prevEn = c.text;
    this.onDebug({ type: 'commit', id, ...c });

    this.finalChain = this.finalChain.then(async () => {
      let es = null;
      try {
        es = await this.translator.translate(c.text, prev);
      } catch (e) {
        log.warn('Fallo de traducción (se muestra en inglés):', e.message);
      }
      const latencyMs = Math.round(c.latencyMs + (performance.now() - t0));
      this.latencyMs = this.latencyMs == null ? latencyMs : this.latencyMs * 0.7 + latencyMs * 0.3;
      this.onDebug({ type: 'translation', id, en: c.text, es, latencyMs, commit: c });
      this.onSubtitle({ kind: 'final', id, en: c.text, es, latencyMs });
    });
  }

  // Para la página de test: espera a que termine todo (ASR y traducciones).
  async flush() {
    await this.streamer?.flush();
    await this.finalChain;
  }

  idle() { return this.streamer?.idle(); }

  dispose() {
    this.ready = false;
    this.disposed = true;
    this.streamer?.reset();
    this.translator.dispose();
    this.asr.terminate();
    this.mt?.terminate();
    this.vad?.release().catch(() => {});
  }
}
