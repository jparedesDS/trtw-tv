// Pipeline de subtítulos: VAD → Streamer (Whisper en worker) → subtítulos.
// Lo usan el documento offscreen y la página de test (mismo código).

import * as ort from 'onnxruntime-web';
import { AsrClient } from './asr-client.js';
import { SileroVad } from './vad.js';
import { Streamer } from './streamer.js';
import { judgeSegment } from './hallucination-filter.js';
import { createLogger } from './log.js';

const log = createLogger('pipeline');

export class Pipeline {
  constructor({ baseUrl, settings, onStatus, onSubtitle, onFatal, onDebug }) {
    this.baseUrl = baseUrl;
    this.settings = { ...settings };
    this.onStatus = onStatus || (() => {});
    this.onSubtitle = onSubtitle || (() => {});
    this.onFatal = onFatal || (() => {});
    this.onDebug = onDebug || (() => {});
    this.ready = false;
    this.loaded = null; // { modelId, device } realmente cargados
    this.seq = 0;

    this.asr = new AsrClient({
      baseUrl,
      onProgress: (p) => this.onStatus({
        progress: { stage: p.stage, pct: p.pct, loaded: p.loaded, total: p.total }
      })
    });
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
      onStats: (stats) => this.onStatus({ stats: { latencyMs: Math.round(stats.latencyMs), asrMs: Math.round(stats.asrMs), rtf: stats.rtf } }),
      onError: (e, fatal) => {
        if (fatal) this.onFatal(new Error(`Whisper falla repetidamente: ${e.message}`));
      }
    });
    this.ready = true;
  }

  updateSettings(s) {
    this.settings = { ...this.settings, ...s };
  }

  pushFrame(frame) {
    if (this.ready) this.streamer.pushFrame(frame);
  }

  resetStream() {
    this.streamer?.reset();
  }

  _partial({ text }) {
    if (!this.settings.showPartial) return;
    this.onSubtitle({ kind: 'partial', en: text, es: null });
  }

  _commit(c) {
    const id = ++this.seq;
    this.onDebug({ type: 'commit', id, ...c });
    this.onSubtitle({ kind: 'final', id, en: c.text, es: c.text, latencyMs: c.latencyMs });
  }

  // Para la página de test.
  flush() { return this.streamer?.flush(); }
  idle() { return this.streamer?.idle(); }

  dispose() {
    this.ready = false;
    this.streamer?.reset();
    this.asr.terminate();
    this.vad?.release();
  }
}
