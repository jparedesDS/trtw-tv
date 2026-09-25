// trtw.tv — Worker de inferencia (Whisper + Opus-MT) con transformers.js.
//
// Corre en su propio hilo y con su propia instancia de onnxruntime-web, así la
// inferencia no bloquea la captura ni el VAD. Procesa las peticiones de una en
// una (el backend WASM/WebGPU de ORT no admite ejecuciones concurrentes).
//
// Protocolo:  → { id, type, ...args }     ← { id, ok, result | error }
//             ← { type: 'progress', ... } / { type: 'log', level, args }

import {
  env,
  AutoTokenizer,
  AutoProcessor,
  WhisperForConditionalGeneration,
  LogitsProcessor,
  pipeline
} from '@huggingface/transformers';
import { tokensToSegments, logSumExp } from '../lib/whisper-tokens.js';

// ── Configuración de transformers.js ────────────────────────────

env.allowLocalModels = false;  // los modelos vienen de Hugging Face…
env.allowRemoteModels = true;
env.useBrowserCache = true;    // …y se guardan en la Cache API (solo 1.ª vez)

let asr = null;   // { modelId, device, dtype, model, processor, tokenizer, ids }
let mt = null;    // { modelId, translator }

function log(level, ...args) {
  self.postMessage({ type: 'log', level, args: args.map(String) });
}

// ── Progreso de descarga ────────────────────────────────────────
// transformers.js informa por fichero; lo agregamos en un único porcentaje.

function progressTracker(stage) {
  const files = new Map();
  let last = 0;
  return (p) => {
    if (p.status === 'progress' || p.status === 'done') {
      const f = files.get(p.file) || { loaded: 0, total: 0 };
      if (p.status === 'progress') {
        f.loaded = p.loaded ?? f.loaded;
        f.total = p.total ?? f.total;
      } else {
        f.loaded = f.total;
      }
      files.set(p.file, f);
      const now = performance.now();
      if (now - last < 150 && p.status !== 'done') return;
      last = now;
      let loaded = 0, total = 0;
      for (const v of files.values()) { loaded += v.loaded; total += v.total; }
      self.postMessage({
        type: 'progress',
        stage,
        file: p.file,
        loaded,
        total,
        pct: total ? Math.round((loaded / total) * 100) : 0
      });
    }
  };
}

// ── Backend: WebGPU si hay adaptador, si no WASM ────────────────

async function detectWebGPU() {
  try {
    if (!self.navigator?.gpu) return { ok: false, reason: 'navigator.gpu no existe' };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { ok: false, reason: 'sin adaptador WebGPU' };
    let name = '';
    try {
      const info = adapter.info || (await adapter.requestAdapterInfo?.());
      name = [info?.vendor, info?.architecture, info?.description].filter(Boolean).join(' ');
    } catch { /* opcional */ }
    return { ok: true, name, fp16: adapter.features.has('shader-f16') };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ── Captura de puntuaciones durante la generación ───────────────
// transformers.js no devuelve logprobs, así que los calculamos con un
// LogitsProcessor que solo observa:
//  - no_speech_prob: probabilidad de <|nocaptions|>/<|nospeech|> en el primer paso.
//  - logprob del token elegido en cada paso (para avg_logprob).
// Los logits se modifican in situ por los procesadores posteriores, así que el
// logprob de un paso se calcula en la llamada siguiente, ya con los valores
// finales, conociendo el token elegido.

class ScoreCollector extends LogitsProcessor {
  constructor(noSpeechId) {
    super();
    this.noSpeechId = noSpeechId;
    this.initLen = null;
    this.noSpeechProb = null;
    this.logprobs = [];
    this.prev = null;
  }

  _settle(chosen) {
    if (!this.prev) return;
    const lse = logSumExp(this.prev);
    this.logprobs.push(this.prev[chosen] - lse);
    this.prev = null;
  }

  _call(input_ids, logits) {
    const ids = input_ids[0];
    const data = logits.data;
    if (!(data instanceof Float32Array)) return logits; // p. ej. fp16: no puntuamos

    if (this.initLen === null) {
      this.initLen = ids.length;
      if (this.noSpeechId != null) {
        const lse = logSumExp(data.subarray(0, logits.dims.at(-1)));
        this.noSpeechProb = Math.exp(data[this.noSpeechId] - lse);
      }
    } else {
      this._settle(Number(ids[ids.length - 1]));
    }
    this.prev = data.subarray(0, logits.dims.at(-1));
    return logits;
  }
}

// ── Whisper ─────────────────────────────────────────────────────

async function loadAsr({ modelId, device: preference = 'auto' }) {
  if (asr && asr.modelId === modelId && (preference === 'auto' || preference === asr.device)) {
    return describeAsr();
  }
  await disposeAsr();

  const gpu = preference === 'wasm' ? { ok: false, reason: 'WASM forzado en ajustes' } : await detectWebGPU();
  if (preference === 'webgpu' && !gpu.ok) log('warn', 'WebGPU no disponible:', gpu.reason, '→ uso WASM');

  const attempts = [];
  if (gpu.ok) {
    // Encoder en fp32 (estable en gráficas integradas) y decoder q4 (rápido).
    attempts.push({ device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } });
  }
  attempts.push({ device: 'wasm', dtype: { encoder_model: 'q8', decoder_model_merged: 'q8' } });
  attempts.push({ device: 'wasm', dtype: 'fp32' }); // último recurso

  const onProgress = progressTracker('asr');
  const tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback: onProgress });
  const processor = await AutoProcessor.from_pretrained(modelId, { progress_callback: onProgress });

  let lastError = null;
  for (const a of attempts) {
    let model = null;
    try {
      log('info', `Cargando ${modelId} en ${a.device}`, JSON.stringify(a.dtype));
      model = await WhisperForConditionalGeneration.from_pretrained(modelId, {
        device: a.device,
        dtype: a.dtype,
        progress_callback: onProgress
      });
      asr = { modelId, device: a.device, dtype: a.dtype, model, processor, tokenizer, gpuName: gpu.name || '' };
      asr.ids = tokenIds(tokenizer, model.generation_config);
      // Calentamiento: la primera inferencia compila shaders / reserva memoria.
      const t0 = performance.now();
      await runWhisper(new Float32Array(16000));
      log('info', `Whisper listo en ${a.device} (calentamiento ${Math.round(performance.now() - t0)} ms)`);
      return describeAsr(gpu.ok ? null : gpu.reason);
    } catch (e) {
      lastError = e;
      log('warn', `Falló la carga en ${a.device}:`, e?.message || e);
      try { await model?.dispose(); } catch { /* nada */ }
      asr = null;
    }
  }
  throw new Error(`No se pudo cargar ${modelId}: ${lastError?.message || lastError}`);
}

function tokenIds(tokenizer, gc) {
  const get = (tok) => {
    const id = tokenizer.model?.tokens_to_ids?.get(tok);
    return id ?? null;
  };
  const eos = Array.isArray(gc.eos_token_id) ? gc.eos_token_id[0] : gc.eos_token_id;
  return {
    eos,
    timestampBegin: gc.no_timestamps_token_id + 1,
    noSpeech: get('<|nocaptions|>') ?? get('<|nospeech|>')
  };
}

function describeAsr(gpuReason = null) {
  return {
    modelId: asr.modelId,
    device: asr.device,
    dtype: asr.dtype,
    gpuName: asr.gpuName,
    gpuReason,
    threads: env.backends.onnx?.wasm?.numThreads ?? null,
    crossOriginIsolated: self.crossOriginIsolated === true
  };
}

async function runWhisper(audio) {
  const { model, processor, tokenizer, ids } = asr;
  const seconds = audio.length / 16000;
  const inputs = await processor(audio);
  const scorer = new ScoreCollector(ids.noSpeech);

  const output = await model.generate({
    ...inputs,
    return_timestamps: true,
    // Límite proporcional a la duración: corta los bucles de repetición.
    max_new_tokens: Math.min(220, Math.ceil(seconds * 7) + 12),
    logits_processor: [scorer]
  });

  const sequence = Array.from(output.data ?? output.tolist()[0], Number);
  const generated = sequence.slice(scorer.initLen ?? 1);
  scorer._settle(generated.at(-1));

  const segments = tokensToSegments(
    generated,
    scorer.logprobs,
    (tokIds) => tokenizer.decode(tokIds, { skip_special_tokens: true }),
    { timestampBegin: ids.timestampBegin, eosTokenId: ids.eos }
  );

  const lps = scorer.logprobs.filter((_, i) => generated[i] < ids.eos);
  return {
    segments,
    text: segments.map((s) => s.text).join(' ').trim(),
    noSpeechProb: scorer.noSpeechProb,
    avgLogprob: lps.length ? lps.reduce((a, b) => a + b, 0) / lps.length : null,
    duration: seconds
  };
}

async function transcribe({ audio }) {
  if (!asr) throw new Error('Whisper no está cargado');
  const t0 = performance.now();
  const result = await runWhisper(audio);
  result.timeMs = Math.round(performance.now() - t0);
  return result;
}

async function disposeAsr() {
  if (!asr) return;
  try { await asr.model.dispose(); } catch { /* nada */ }
  asr = null;
}

// ── Opus-MT (traducción de respaldo, local) ─────────────────────

async function loadMt({ modelId = 'Xenova/opus-mt-en-es' } = {}) {
  if (mt?.modelId === modelId) return { modelId };
  log('info', 'Cargando traductor', modelId);
  const translator = await pipeline('translation', modelId, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: progressTracker('mt')
  });
  mt = { modelId, translator };
  return { modelId };
}

async function translate({ texts }) {
  if (!mt) throw new Error('Opus-MT no está cargado');
  const out = await mt.translator(texts, { max_new_tokens: 256 });
  return out.map((o) => o.translation_text);
}

// ── Bucle de mensajes (secuencial) ──────────────────────────────

const handlers = {
  init: ({ baseUrl }) => {
    // WASM de ORT desde la extensión, nunca desde un CDN.
    env.backends.onnx.wasm.wasmPaths = baseUrl + 'vendor/ort/';
    return { crossOriginIsolated: self.crossOriginIsolated === true };
  },
  'load-asr': loadAsr,
  transcribe,
  'load-mt': loadMt,
  translate,
  dispose: async () => { await disposeAsr(); mt = null; return true; }
};

let queue = Promise.resolve();

self.onmessage = (event) => {
  const { id, type, ...args } = event.data || {};
  const handler = handlers[type];
  queue = queue.then(async () => {
    try {
      if (!handler) throw new Error(`Mensaje desconocido: ${type}`);
      const result = await handler(args);
      self.postMessage({ id, ok: true, result });
    } catch (e) {
      self.postMessage({ id, ok: false, error: e?.message || String(e) });
    }
  });
};
