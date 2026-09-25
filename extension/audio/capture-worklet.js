// AudioWorklet de captura (hilo de audio).
//
// Recibe el audio de la pestaña a la frecuencia nativa del AudioContext
// (normalmente 48 kHz, así el usuario sigue oyendo el stream con calidad
// completa), lo mezcla a mono, lo remuestrea a 16 kHz y envía tramas de 512
// muestras (32 ms), que es justo lo que espera Silero VAD.

import { StreamingResampler } from '../lib/resampler.js';

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.frameSize = opts.frameSize || 512;
    this.resampler = new StreamingResampler(sampleRate, opts.targetRate || 16000);
    this.frame = new Float32Array(this.frameSize);
    this.fill = 0;
    this.active = true;
    this.port.onmessage = (e) => {
      if (e.data?.type === 'stop') this.active = false;
    };
  }

  process(inputs) {
    if (!this.active) return false;
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    // Mezcla a mono
    const n = input[0].length;
    const mono = new Float32Array(n);
    for (let c = 0; c < input.length; c++) {
      const ch = input[c];
      for (let i = 0; i < n; i++) mono[i] += ch[i];
    }
    if (input.length > 1) {
      const inv = 1 / input.length;
      for (let i = 0; i < n; i++) mono[i] *= inv;
    }

    // Remuestreo y troceado en tramas fijas
    const out = this.resampler.process(mono);
    let off = 0;
    while (off < out.length) {
      const take = Math.min(this.frameSize - this.fill, out.length - off);
      this.frame.set(out.subarray(off, off + take), this.fill);
      this.fill += take;
      off += take;
      if (this.fill === this.frameSize) {
        const f = this.frame;
        this.port.postMessage({ type: 'frame', frame: f }, [f.buffer]);
        this.frame = new Float32Array(this.frameSize);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('trtw-capture', CaptureProcessor);
