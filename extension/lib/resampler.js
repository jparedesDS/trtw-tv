// Remuestreador en streaming (p. ej. 48 kHz → 16 kHz) para audio mono.
//
// Whisper y Silero trabajan a 16 kHz. Si reducimos la frecuencia sin filtrar,
// todo lo que hay por encima de 8 kHz (platillos, efectos del juego…) se
// "dobla" (aliasing) sobre la banda de la voz. Por eso primero se aplica un
// filtro paso bajo FIR (sinc enventanado con Blackman) y después se toma la
// muestra en la posición fraccionaria con interpolación lineal.
//
// El filtro solo se evalúa en los puntos que se necesitan, así que el coste es
// ~2 × taps multiplicaciones por muestra de salida.

export class StreamingResampler {
  constructor(inputRate, outputRate = 16000, taps = 0) {
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    this.ratio = inputRate / outputRate;
    this.passthrough = Math.abs(this.ratio - 1) < 1e-9;

    if (!this.passthrough) {
      // Frecuencia de corte un poco por debajo de Nyquist de salida.
      const cutoff = Math.min(0.5, 0.45 / this.ratio); // en ciclos/muestra de entrada
      const n = taps || Math.max(16, Math.ceil(this.ratio * 16)) | 1; // impar
      const half = (n - 1) / 2;
      const kernel = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const x = i - half;
        const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
        kernel[i] = sinc * w;
        sum += kernel[i];
      }
      for (let i = 0; i < n; i++) kernel[i] /= sum; // ganancia 1 en continua
      this.kernel = kernel;
      this.half = half;
    }

    // Buffer de entrada pendiente; empieza con `half` ceros para que el filtro
    // tenga historia desde la primera muestra.
    this.buf = new Float32Array(4096);
    this.len = this.passthrough ? 0 : this.half;
    this.pos = this.passthrough ? 0 : this.half; // posición (fraccionaria) de la siguiente salida
  }

  // Filtro FIR centrado en la muestra entera i del buffer.
  _filtered(i) {
    const k = this.kernel;
    const start = i - this.half;
    let acc = 0;
    for (let j = 0; j < k.length; j++) acc += k[j] * this.buf[start + j];
    return acc;
  }

  // Añade muestras de entrada y devuelve las muestras de salida disponibles.
  process(input) {
    if (this.passthrough) return Float32Array.from(input);

    // Asegurar capacidad
    if (this.len + input.length > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, this.len + input.length));
      bigger.set(this.buf.subarray(0, this.len));
      this.buf = bigger;
    }
    this.buf.set(input, this.len);
    this.len += input.length;

    const out = new Float32Array(Math.ceil((this.len - this.pos) / this.ratio) + 1);
    let count = 0;
    // Necesitamos las muestras i e i+1 filtradas; el filtro de i+1 llega hasta i+1+half.
    while (Math.floor(this.pos) + 1 + this.half < this.len) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = this._filtered(i);
      const b = frac > 0 ? this._filtered(i + 1) : a;
      out[count++] = a + (b - a) * frac;
      this.pos += this.ratio;
    }

    // Descarta lo ya consumido, conservando la historia que necesita el filtro.
    const drop = Math.max(0, Math.floor(this.pos) - this.half);
    if (drop > 0) {
      this.buf.copyWithin(0, drop, this.len);
      this.len -= drop;
      this.pos -= drop;
    }
    return out.subarray(0, count);
  }
}
