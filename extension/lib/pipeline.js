// Pipeline de subtítulos: VAD → Streamer (Whisper en worker) → subtítulos.
// Lo usan el documento offscreen y la página de test (mismo código).

import * as ort from 'onnxruntime-web';
import { AsrClient } from './asr-client.js';
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

    this.asr = new AsrClient({
      baseUrl,
      onProgress: (p) => this.onStatus({
        progress: { stage: p.stage, pct: p.pct, loaded: p.loaded, total: p.total }
      })
    });

    this.translator = new TranslationService({
      asrClient: this.asr,
      relay: tabRelay || null,
      log,
      onProgress: (p) => this.onStatus({ progress: p })
    });
    this.translator.onEngineChange = (engine) => this.onStatus({ engine, warning: null });
    this._applyTranslationSettings();
  }

  isCompatible(s) {
    return s.modelId === this.settings.modelId && s.device === this.settings.device;
  }

  async load() {
    // ORT del hilo principal: solo para el VAD (diminuto) → 1 hilo, WASM local.
    ort.env.wasm.wasmPaths = this.baseUrl + 'vendor/ort/';
    ort.env.wasm.numThreads = 1;
    this.vad = await SileroVad.create(ort, this.baseUrl + 'models/silero/silero_vad_v5.onnx');
    log.info('Silero VAD listo');

    await this.asr.ready;
    const info = await this.asr.loadAsr(this.settings.modelId, this.settings.device);
    this.loaded = info;
    log.info(`Whisper: ${info.modelId} en ${info.device}`, info.gpuName || '', info.gpuReason || '');
    this.onStatus({
      device: info.device,
      gpuName: info.gpuName,
      gpuReason: info.gpuReason,
      modelId: info.modelId,
      progress: null
    });

    await this._initTranslator();

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

  async _initTranslator() {
    const { engine, warning } = await this.translator.init(this.settings.translationEngine);
    this.onStatus({ engine, warning, progress: null });
  }

  _applyTranslationSettings() {
    this.translator.setGlossary(this.settings.glossary);
    this.translator.useContext = this.settings.translateWithContext !== false;
  }

  updateSettings(s) {
    const engineChanged = s.translationEngine && s.translationEngine !== this.settings.translationEngine;
    this.settings = { ...this.settings, ...s };
    this._applyTranslationSettings();
    if (engineChanged && this.ready) this._initTranslator().catch((e) => log.warn(e.message));
  }

  pushFrame(frame) {
    if (this.ready) this.streamer.pushFrame(frame);
  }

  // Al empezar en otra pestaña: el relé de traducción apunta a la pestaña nueva,
  // así que volvemos a elegir motor si dependíamos de ella.
  async prepareForTab() {
    this.resetStream();
    if (this.translator.name === 'chrome-tab' || this.translator.name === 'none') await this._initTranslator();
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
      this.onDebug({ type: 'translation', id, en: c.text, es, latencyMs });
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
    this.streamer?.reset();
    this.translator.dispose();
    this.asr.terminate();
    this.vad?.release();
  }
}
