// Silero VAD v5 (ONNX, local: extension/models/silero/silero_vad_v5.onnx).
//
// Recibe tramas de 512 muestras a 16 kHz (32 ms) y devuelve la probabilidad
// de voz. A diferencia de un umbral de volumen (RMS), distingue voz de música,
// explosiones o efectos del juego, que es de donde salían las alucinaciones.
//
// `ort` se inyecta (onnxruntime-web en el navegador, onnxruntime-node en los
// tests) para poder probarlo fuera del navegador.

const FRAME = 512;
const CONTEXT = 64; // v5 espera las 64 últimas muestras de la trama anterior

export class SileroVad {
  static async create(ort, model, executionProviders = ['wasm']) {
    const session = await ort.InferenceSession.create(model, {
      executionProviders,
      graphOptimizationLevel: 'all'
    });
    return new SileroVad(ort, session);
  }

  constructor(ort, session) {
    this.ort = ort;
    this.session = session;
    this.sr = new ort.Tensor('int64', BigInt64Array.from([16000n]), []);
    this.chain = Promise.resolve(); // las inferencias van de una en una
    this.epoch = 0;
    this.reset();
  }

  // Empieza de cero (otro stream). Las tramas de antes del reset que aún estén
  // en cola se ignoran y una inferencia en vuelo no pisa el estado nuevo.
  reset() {
    this.epoch++;
    this.state = new this.ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
    this.context = new Float32Array(CONTEXT);
  }

  // Probabilidad de voz de una trama. Las llamadas se serializan: una sesión
  // de ORT no admite ejecuciones concurrentes y el estado es secuencial.
  process(frame) {
    const epoch = this.epoch;
    const run = async () => {
      if (frame.length !== FRAME) throw new Error(`El VAD espera tramas de ${FRAME} muestras`);
      if (epoch !== this.epoch) return 0; // trama de un stream anterior
      const input = new Float32Array(CONTEXT + FRAME);
      input.set(this.context, 0);
      input.set(frame, CONTEXT);
      this.context = frame.slice(FRAME - CONTEXT);

      const out = await this.session.run({
        input: new this.ort.Tensor('float32', input, [1, CONTEXT + FRAME]),
        state: this.state,
        sr: this.sr
      });
      if (epoch === this.epoch) this.state = out.stateN;
      return out.output.data[0];
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  async release() {
    await this.session.release?.();
  }
}
