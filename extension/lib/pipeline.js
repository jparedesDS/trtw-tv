// Pipeline de subtítulos (fase 1: base mínima).
// Trozos de 3 s → Whisper (transformers.js) → texto. Se sustituye en la fase 2.

import { pipeline as hfPipeline, env } from '@huggingface/transformers';
import { createLogger } from './log.js';

const log = createLogger('pipeline');
const CHUNK = 16000 * 3;

export class Pipeline {
  constructor({ baseUrl, settings, onStatus, onSubtitle, onFatal }) {
    this.baseUrl = baseUrl;
    this.settings = settings;
    this.onStatus = onStatus;
    this.onSubtitle = onSubtitle;
    this.onFatal = onFatal;
    this.ready = false;
    this.buffer = new Float32Array(CHUNK);
    this.fill = 0;
    this.busy = false;

    // WASM desde la propia extensión (la CSP bloquea jsDelivr).
    env.backends.onnx.wasm.wasmPaths = baseUrl + 'vendor/ort/';
    env.allowLocalModels = false;
    env.useBrowserCache = true;
  }

  isCompatible(s) {
    return s.modelId === this.settings.modelId && s.device === this.settings.device;
  }

  async load() {
    const device = navigator.gpu && (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm';
    this.onStatus({ device, modelId: this.settings.modelId });
    this.asr = await hfPipeline('automatic-speech-recognition', this.settings.modelId, {
      device,
      progress_callback: (p) => {
        if (p.status === 'progress') this.onStatus({ progress: { file: p.file, pct: p.progress } });
      }
    });
    this.ready = true;
    log.info('Whisper listo en', device);
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
      const { text } = await this.asr(chunk);
      if (text?.trim()) this.onSubtitle({ kind: 'final', en: text.trim(), es: text.trim() });
    } catch (e) {
      // Un fallo puntual no mata la sesión.
      log.warn('Fallo de transcripción:', e.message);
    } finally {
      this.busy = false;
    }
  }

  dispose() { this.asr?.dispose?.(); }
}
