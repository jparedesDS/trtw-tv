// Pipeline de subtítulos (fase 2: Whisper en worker, trozos de 3 s).
// La segmentación por voz llega en la fase 3.

import { AsrClient } from './asr-client.js';
import { createLogger } from './log.js';

const log = createLogger('pipeline');
const CHUNK = 16000 * 3;

export class Pipeline {
  constructor({ baseUrl, settings, onStatus, onSubtitle, onFatal }) {
    this.settings = settings;
    this.onStatus = onStatus;
    this.onSubtitle = onSubtitle;
    this.onFatal = onFatal;
    this.ready = false;
    this.buffer = new Float32Array(CHUNK);
    this.fill = 0;
    this.busy = false;
    this.asr = new AsrClient({
      baseUrl,
      onProgress: (p) => this.onStatus({ progress: { stage: p.stage, pct: p.pct, loaded: p.loaded, total: p.total } })
    });
  }

  isCompatible(s) {
    return s.modelId === this.settings.modelId && s.device === this.settings.device;
  }

  async load() {
    await this.asr.ready;
    const info = await this.asr.loadAsr(this.settings.modelId, this.settings.device);
    this.onStatus({ device: info.device, gpuName: info.gpuName, gpuReason: info.gpuReason, modelId: info.modelId, progress: null });
    this.ready = true;
  }

  updateSettings(s) { this.settings = { ...this.settings, ...s }; }

  resetStream() { this.fill = 0; }

  pushFrame(frame) {
    if (!this.ready) return;
    this.buffer.set(frame.subarray(0, Math.min(frame.length, CHUNK - this.fill)), this.fill);
    this.fill += frame.length;
    if (this.fill < CHUNK) return;
    const chunk = this.buffer.slice(0);
    this.fill = 0;
    if (!this.busy) this.transcribe(chunk);
  }

  async transcribe(chunk) {
    this.busy = true;
    try {
      const { text } = await this.asr.transcribe(chunk);
      if (text) this.onSubtitle({ kind: 'final', en: text, es: text });
    } catch (e) {
      log.warn('Fallo de transcripción:', e.message); // no mata la sesión
    } finally {
      this.busy = false;
    }
  }

  dispose() { this.asr.terminate(); }
}
