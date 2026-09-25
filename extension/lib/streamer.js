// Transcripción en streaming: VAD + ventana deslizante + "local agreement".
//
// Flujo:
//  1. Cada trama de 32 ms pasa por el VAD. Al detectar voz empieza una
//     "locución" (con ~300 ms de pre-roll para no comerse la primera sílaba).
//  2. Mientras dura la locución, cada ~1 s se transcribe TODO su audio
//     (hipótesis provisional). Whisper devuelve segmentos con timestamps.
//  3. Local agreement: un segmento completo (no el último, que puede estar a
//     medias) que sale igual en dos hipótesis seguidas se da por bueno: se
//     "confirma", se emite y se recorta su audio del buffer. El resto se
//     muestra como texto provisional (gris).
//  4. La locución se cierra con ~550 ms de silencio, o se corta en el punto de
//     menor probabilidad de voz si llega a ~9 s. Ese trozo se transcribe una
//     última vez y se confirma entero.
//
// Todo lo externo se inyecta (vad, asr, filtro), así se prueba en Node.

export const STREAMER_DEFAULTS = {
  sampleRate: 16000,
  frameSize: 512,
  speechThreshold: 0.5,   // prob. de voz para empezar una locución
  silenceThreshold: 0.35, // por debajo cuenta como silencio
  minSilenceMs: 550,      // silencio que cierra una locución
  prerollMs: 320,         // audio previo que se añade al empezar
  minSpeechMs: 250,       // locuciones más cortas se descartan (clics, golpes)
  stepMs: 900,            // cada cuánto se relanza la hipótesis provisional
  firstRunMs: 900,        // audio mínimo para la primera hipótesis
  maxUtteranceMs: 9000,   // corte forzado de locuciones largas
  trailingKeepMs: 250,    // silencio final que se conserva al cerrar
  staleCommitMs: 4000,    // confirma un segmento completo aunque no haya acuerdo si ya es "viejo"
  maxConsecutiveErrors: 5
};

// Normaliza para comparar hipótesis (sin mayúsculas ni puntuación).
export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Quita del principio de `next` las palabras que repiten el final de `prev`
// (ocurre cuando el corte del buffer cae en mitad de una palabra).
export function dedupeOverlap(prev, next, gapSec = 0) {
  if (!prev || !next) return next;
  const p = normalizeText(prev).split(' ');
  const nWords = next.trim().split(/\s+/);
  const n = nWords.map(normalizeText);
  for (let k = Math.min(4, p.length, n.length); k >= 1; k--) {
    const tail = p.slice(p.length - k).join(' ');
    const head = n.slice(0, k).join(' ');
    if (tail !== head) continue;
    if (k === 1 && (head.length < 3 || gapSec > 0.5)) continue; // una palabra corta puede repetirse de verdad
    return nWords.slice(k).join(' ');
  }
  return next;
}

// Exportada solo para los tests.
export class Utterance {
  constructor(id, startSample, cfg) {
    this.id = id;
    this.cfg = cfg;
    this.startSample = startSample; // posición absoluta en el stream
    this.audio = new Float32Array(cfg.sampleRate * 12);
    this.length = 0;
    this.probs = [];        // prob. de voz por trama
    // Muestras de la primera trama de `probs` que ya no están en `audio` (tras
    // recortar en mitad de una trama). Se cumple siempre:
    //   length + probPhase === probs.length * frameSize
    this.probPhase = 0;
    this.speechFrames = 0;
    this.silenceRun = 0;    // tramas seguidas de silencio al final
    this.prev = null;       // segmentos de la hipótesis anterior (para el acuerdo)
    this.lastRunLength = 0; // muestras que tenía en la última hipótesis
    this.epoch = 0;         // cambia al cortar: invalida hipótesis en vuelo
  }

  append(frame, prob) {
    if (this.length + frame.length > this.audio.length) {
      const bigger = new Float32Array(this.audio.length * 2);
      bigger.set(this.audio.subarray(0, this.length));
      this.audio = bigger;
    }
    this.audio.set(frame, this.length);
    this.length += frame.length;
    this.probs.push(prob);
    if (prob >= this.cfg.speechThreshold) this.speechFrames++;
    this.silenceRun = prob < this.cfg.silenceThreshold ? this.silenceRun + 1 : 0;
  }

  get durationMs() {
    return (this.length / this.cfg.sampleRate) * 1000;
  }

  snapshot(length = this.length) {
    return this.audio.slice(0, length);
  }

  // Elimina las primeras `samples` muestras (audio ya confirmado).
  trimStart(samples) {
    samples = Math.max(0, Math.min(samples, this.length));
    this.audio.copyWithin(0, samples, this.length);
    this.length -= samples;
    this.startSample += samples;
    const total = this.probPhase + samples;
    this.probs.splice(0, Math.floor(total / this.cfg.frameSize));
    this.probPhase = total % this.cfg.frameSize;
    this.speechFrames = this.probs.filter((p) => p >= this.cfg.speechThreshold).length;
    this.lastRunLength = Math.max(0, this.lastRunLength - samples);
  }

  // Elimina las últimas `frames` tramas (silencio final).
  trimEndFrames(frames) {
    frames = Math.max(0, Math.min(frames, this.probs.length));
    this.probs.splice(this.probs.length - frames, frames);
    this.length = Math.max(0, this.length - frames * this.cfg.frameSize);
  }

  // Índice de trama (en `probs`) de una muestra del audio.
  frameAt(sample) {
    return (sample + this.probPhase) / this.cfg.frameSize;
  }

  // Muestra del audio donde termina la trama `i` de `probs`.
  frameEnd(i) {
    return Math.min(this.length, (i + 1) * this.cfg.frameSize - this.probPhase);
  }

  // Fracción de tramas con voz entre dos instantes (segundos relativos).
  speechRatio(startSec, endSec) {
    const sr = this.cfg.sampleRate;
    const a = Math.max(0, Math.floor(this.frameAt((startSec ?? 0) * sr)));
    const b = Math.min(this.probs.length, Math.ceil(this.frameAt((endSec ?? this.length / sr) * sr)));
    if (b <= a) return 0;
    let speech = 0;
    for (let i = a; i < b; i++) if (this.probs[i] >= this.cfg.silenceThreshold) speech++;
    return speech / (b - a);
  }
}

export class Streamer {
  constructor({ vad, asr, filter, config, onPartial, onCommit, onReject, onStats, onError, log, now }) {
    this.vad = vad;
    this.asr = asr;
    this.filter = filter || ((seg) => ({ text: seg.text, reject: false }));
    this.cfg = { ...STREAMER_DEFAULTS, ...config };
    this.onPartial = onPartial || (() => {});
    this.onCommit = onCommit || (() => {});
    this.onReject = onReject || (() => {});
    this.onStats = onStats || (() => {});
    this.onError = onError || (() => {});
    this.log = log || { debug() {}, info() {}, warn() {}, error() {} };
    this.now = now || (() => performance.now());
    this.frameMs = (this.cfg.frameSize / this.cfg.sampleRate) * 1000;
    this.reset();
  }

  reset() {
    this.generation = (this.generation || 0) + 1; // invalida resultados en vuelo
    this.queue = [];
    this.pumping = false;
    this.utt = null;
    this.preroll = [];
    this.jobs = [];
    this.asrBusy = false;
    this.pushedSamples = 0;
    this.processedSamples = 0;
    this.arrivals = [];       // [muestra final de la trama, instante de llegada]
    this.lastCommitted = null;
    this.nextId = 1;
    this.errors = 0;
    this.stats = { asrMs: null, latencyMs: null, rtf: null };
    this.vad?.reset?.();
    this._waiters = [];
  }

  // ── Entrada ─────────────────────────────────────────────────

  pushFrame(frame) {
    this.pushedSamples += frame.length;
    this.arrivals.push([this.pushedSamples, this.now()]);
    if (this.arrivals.length > 2000) this.arrivals.splice(0, 500); // ~64 s de historia
    // Si el VAD se queda atrás (no debería), tiramos audio viejo.
    if (this.queue.length > 150) this.queue.splice(0, 50);
    this.queue.push(frame);
    if (!this.pumping) this._pump();
  }

  async _pump() {
    this.pumping = true;
    const gen = this.generation;
    while (this.queue.length && gen === this.generation) {
      const frame = this.queue.shift();
      let prob = 0;
      try {
        prob = await this.vad.process(frame);
      } catch (e) {
        this.log.warn('Fallo del VAD en una trama:', e.message);
      }
      if (gen !== this.generation) return; // reset(): ya hay (o habrá) otro bucle; no tocar su estado
      this._onFrame(frame, prob);
    }
    if (gen !== this.generation) return;
    this.pumping = false;
    this._notifyIdle();
  }

  // Momento en que llegó una muestra dada (para medir la latencia real).
  arrivalTime(sample) {
    for (const [end, t] of this.arrivals) if (end >= sample) return t;
    return this.now();
  }

  // ── Segmentación por voz ────────────────────────────────────

  _onFrame(frame, prob) {
    const cfg = this.cfg;
    this.processedSamples += frame.length;

    if (!this.utt) {
      this.preroll.push({ frame, prob });
      const maxPre = Math.max(1, Math.round(cfg.prerollMs / this.frameMs));
      if (this.preroll.length > maxPre) this.preroll.shift();
      if (prob < cfg.speechThreshold) return;

      const start = this.processedSamples - this.preroll.length * cfg.frameSize;
      this.utt = new Utterance(this.nextId++, start, cfg);
      for (const p of this.preroll) this.utt.append(p.frame, p.prob);
      this.preroll = [];
      this.log.debug(`Voz detectada (locución ${this.utt.id})`);
    } else {
      this.utt.append(frame, prob);
    }

    const utt = this.utt;
    if (utt.silenceRun * this.frameMs >= cfg.minSilenceMs) {
      this._endUtterance('silencio');
    } else if (utt.durationMs >= cfg.maxUtteranceMs) {
      this._splitUtterance();
    }
    this._schedule();
  }

  _endUtterance(reason) {
    const utt = this.utt;
    this.utt = null;
    this.preroll = [];
    if (!utt) return;

    if (utt.speechFrames * this.frameMs < this.cfg.minSpeechMs) {
      this.log.debug(`Locución ${utt.id} descartada (demasiado corta)`);
      this.onPartial({ text: '', uttId: utt.id });
      return;
    }
    const keep = Math.ceil(this.cfg.trailingKeepMs / this.frameMs);
    utt.trimEndFrames(utt.silenceRun - keep);
    this.jobs.push({ utt, reason });
    this._schedule();
  }

  // Locución demasiado larga: se corta en el punto de menor probabilidad de voz
  // de la segunda mitad (una respiración, una pausa corta…).
  _splitUtterance() {
    const utt = this.utt;
    const probs = utt.probs;
    const from = Math.floor(probs.length * 0.5);
    let best = probs.length - 1;
    let bestP = Infinity;
    for (let i = probs.length - 1; i >= from; i--) {
      if (probs[i] < bestP - 1e-6) { bestP = probs[i]; best = i; }
    }
    const cut = utt.frameEnd(best);

    const head = new Utterance(utt.id, utt.startSample, this.cfg);
    head.append(utt.audio.subarray(0, cut), 1);
    head.probs = probs.slice(0, best + 1);
    head.probPhase = utt.probPhase;
    head.speechFrames = head.probs.filter((p) => p >= this.cfg.speechThreshold).length;

    utt.trimStart(cut);
    utt.id = this.nextId++;
    utt.prev = null;
    utt.lastRunLength = 0;
    utt.epoch++;
    this.log.debug(`Locución larga: corte en ${(cut / this.cfg.sampleRate).toFixed(2)} s (p=${bestP.toFixed(2)})`);
    this.jobs.push({ utt: head, reason: 'máximo' });
  }

  // ── Planificación del ASR (una petición a la vez) ───────────

  _schedule() {
    if (this.asrBusy) return;
    if (this.jobs.length) {
      this._runFinal(this.jobs.shift());
      return;
    }
    const utt = this.utt;
    if (!utt) return;
    const sr = this.cfg.sampleRate;
    // Si el equipo es lento, espaciamos las hipótesis para no ir acumulando retraso.
    const step = Math.max(this.cfg.stepMs, (this.stats.asrMs || 0) * 1.1);
    if (
      utt.speechFrames * this.frameMs >= this.cfg.minSpeechMs &&
      utt.length >= (this.cfg.firstRunMs / 1000) * sr &&
      utt.length - utt.lastRunLength >= (step / 1000) * sr
    ) {
      this._runInterim(utt);
    }
  }

  async _runFinal(job) {
    this.asrBusy = true;
    const gen = this.generation;
    try {
      const res = await this._transcribe(job.utt.snapshot());
      if (gen !== this.generation) return;
      const segs = this._judge(job.utt, res);
      for (const s of segs) this._emit(job.utt, s, res);
      this.onPartial({ text: this.utt ? this._partialText(this.utt.prev) : '', uttId: job.utt.id });
    } catch (e) {
      this._asrFailed(e);
    } finally {
      if (gen === this.generation) {
        this.asrBusy = false;
        this._schedule();
        this._notifyIdle();
      }
    }
  }

  async _runInterim(utt) {
    this.asrBusy = true;
    const gen = this.generation;
    const epoch = utt.epoch;
    const len = utt.length;
    utt.lastRunLength = len;
    try {
      const res = await this._transcribe(utt.snapshot(len));
      if (gen !== this.generation || this.utt !== utt || utt.epoch !== epoch) return; // ya no vale
      this._handleInterim(utt, res, len);
    } catch (e) {
      this._asrFailed(e);
    } finally {
      if (gen === this.generation) {
        this.asrBusy = false;
        this._schedule();
        this._notifyIdle();
      }
    }
  }

  async _transcribe(audio) {
    const t0 = this.now();
    const res = await this.asr.transcribe(audio);
    const ms = res.timeMs ?? this.now() - t0;
    const ema = (old, v) => (old == null ? v : old * 0.8 + v * 0.2);
    this.stats.asrMs = ema(this.stats.asrMs, ms);
    this.stats.rtf = ema(this.stats.rtf, ms / ((audio.length / this.cfg.sampleRate) * 1000));
    this.errors = 0;
    return res;
  }

  _asrFailed(e) {
    this.errors++;
    this.log.warn(`Fallo de transcripción (${this.errors} seguidos):`, e.message);
    this.onError(e, this.errors >= this.cfg.maxConsecutiveErrors);
  }

  // ── Hipótesis y confirmación ────────────────────────────────

  // Aplica el filtro a cada segmento y le añade el veredicto.
  _judge(utt, res) {
    const sr = this.cfg.sampleRate;
    const dur = utt.length / sr;
    return (res.segments || []).map((seg) => {
      const start = Math.min(Math.max(seg.start ?? 0, 0), dur);
      const end = seg.end == null ? null : Math.min(Math.max(seg.end, start), dur);
      const verdict = this.filter(seg, {
        noSpeechProb: res.noSpeechProb,
        avgLogprob: seg.avgLogprob ?? res.avgLogprob,
        speechRatio: utt.speechRatio(start, end ?? dur),
        durationSec: (end ?? dur) - start,
        previousText: this.lastCommitted?.text || ''
      });
      return { ...seg, start, end, text: verdict.text ?? seg.text, rawText: seg.text, reject: !!verdict.reject, reason: verdict.reason };
    });
  }

  _handleInterim(utt, res, len) {
    const segs = this._judge(utt, res);
    const sr = this.cfg.sampleRate;
    const dur = len / sr;

    // Segmentos completos (no el último) que coinciden con la hipótesis anterior.
    let upTo = -1;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i];
      if (s.end == null) break;
      const agreed = utt.prev?.[i] && normalizeText(utt.prev[i].rawText ?? utt.prev[i].text) === normalizeText(s.rawText);
      const stale = (dur - s.end) * 1000 >= this.cfg.staleCommitMs;
      if (!agreed && !stale) break;
      upTo = i;
    }

    if (upTo >= 0) {
      const done = segs.slice(0, upTo + 1);
      for (const s of done) this._emit(utt, s, res);
      const cutSec = done.at(-1).end;
      utt.trimStart(Math.round(cutSec * sr));
      utt.prev = segs.slice(upTo + 1).map((s) => ({
        ...s,
        start: Math.max(0, s.start - cutSec),
        end: s.end == null ? null : Math.max(0, s.end - cutSec)
      }));
    } else {
      utt.prev = segs;
    }
    this.onPartial({ text: this._partialText(utt.prev), uttId: utt.id });
  }

  _partialText(segs) {
    return (segs || []).filter((s) => !s.reject).map((s) => s.text).join(' ').trim();
  }

  _emit(utt, seg, res) {
    const sr = this.cfg.sampleRate;
    const startSample = utt.startSample + Math.round(seg.start * sr);
    const endSample = utt.startSample + Math.round((seg.end ?? utt.length / sr) * sr);
    if (seg.reject) {
      this.onReject({ text: seg.rawText, reason: seg.reason, startSample, endSample });
      return;
    }
    const gapSec = this.lastCommitted ? (startSample - this.lastCommitted.endSample) / sr : 99;
    const text = dedupeOverlap(this.lastCommitted?.text, seg.text, gapSec).trim();
    if (!text) return;

    const latencyMs = Math.max(0, this.now() - this.arrivalTime(endSample));
    this.stats.latencyMs = this.stats.latencyMs == null ? latencyMs : this.stats.latencyMs * 0.7 + latencyMs * 0.3;
    this.lastCommitted = { text, endSample };
    this.onCommit({
      text,
      startSample,
      endSample,
      latencyMs,
      avgLogprob: seg.avgLogprob ?? null,
      noSpeechProb: res.noSpeechProb ?? null
    });
    this.onStats({ ...this.stats });
  }

  // ── Utilidades para la página de test ───────────────────────

  // Cierra la locución en curso (fin del audio) y espera a que todo termine.
  async flush() {
    await this.idle();
    if (this.utt) this._endUtterance('fin');
    await this.idle();
  }

  // Resuelve cuando no queda nada pendiente (VAD, trabajos y ASR).
  idle() {
    if (this._isIdle()) return Promise.resolve();
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  // Resuelve cuando el ASR está libre (para no ir más rápido que el tiempo real
  // "infinitamente rápido" en el modo rápido de la página de test).
  _isIdle() {
    return !this.pumping && this.queue.length === 0 && !this.asrBusy && this.jobs.length === 0;
  }

  _notifyIdle() {
    if (!this._isIdle()) return;
    const w = this._waiters;
    this._waiters = [];
    w.forEach((fn) => fn());
  }
}
