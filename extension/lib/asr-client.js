// Cliente del worker de inferencia: convierte los mensajes en promesas.

import { createLogger } from './log.js';

const log = createLogger('worker');

export class AsrClient {
  constructor({ baseUrl, onProgress }) {
    this.worker = new Worker(baseUrl + 'dist/asr-worker.js', { type: 'module' });
    this.pending = new Map();
    this.nextId = 1;
    this.onProgress = onProgress || (() => {});

    this.worker.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'progress') return this.onProgress(msg);
      if (msg.type === 'log') return (log[msg.level] || log.info)(...msg.args);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error));
    };
    this.worker.onerror = (e) => {
      const err = new Error(`Error en el worker: ${e.message || 'desconocido'}`);
      log.error(err.message);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };

    this.ready = this.request('init', { baseUrl });
  }

  request(type, args = {}, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, type, ...args }, transfer);
    });
  }

  loadAsr(modelId, device) {
    return this.request('load-asr', { modelId, device });
  }

  // El audio se copia (no se transfiere) porque el llamante puede seguir usándolo.
  transcribe(audio) {
    const copy = audio.slice();
    return this.request('transcribe', { audio: copy }, [copy.buffer]);
  }

  loadMt(modelId) {
    return this.request('load-mt', { modelId });
  }

  translate(texts) {
    return this.request('translate', { texts });
  }

  terminate() {
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error('Worker terminado'));
    this.pending.clear();
  }
}
