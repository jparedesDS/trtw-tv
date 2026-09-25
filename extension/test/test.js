// trtw.tv — Página de test: el mismo pipeline que el offscreen, alimentado con
// un audio local en lugar del audio de la pestaña.

import * as ort from 'onnxruntime-web';
import { Pipeline } from '../lib/pipeline.js';
import { SileroVad } from '../lib/vad.js';
import { SubtitleRenderer } from '../lib/subtitle-renderer.js';
import { createChromeTranslator } from '../lib/chrome-translator.js';
import { MODELS, loadSettings } from '../lib/settings.js';

const $ = (id) => document.getElementById(id);
const BASE = chrome.runtime.getURL('');
const SR = 16000;
const FRAME = 512;

let settings = await loadSettings();
let pipeline = null;
let audio16k = null;     // Float32Array a 16 kHz (modo rápido y VAD)
let audioBuffer = null;  // AudioBuffer original (modo tiempo real)
let running = null;      // { stop() }
let loadingModels = false;
let rows = 0;

const renderer = new SubtitleRenderer(document);
renderer.mount($('player'));

// ── Registro ────────────────────────────────────────────────────

function log(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}\n`;
  $('log').textContent += line;
  $('log').scrollTop = $('log').scrollHeight;
}

// Copiamos a la página los logs [trtw.tv] de la consola (pipeline, worker…).
for (const level of ['info', 'warn', 'error']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    if (typeof args[0] === 'string' && args[0].startsWith('[trtw.tv]')) log(level.toUpperCase(), ...args.map(String));
  };
}
window.addEventListener('unhandledrejection', (e) => log('ERROR', e.reason?.message || e.reason));

// ── Controles ───────────────────────────────────────────────────

for (const m of MODELS) $('model').add(new Option(m.label, m.id));
$('model').value = settings.modelId;
$('device').value = settings.device;
$('engine').value = settings.translationEngine;
$('bilingual').checked = settings.bilingual;
$('partial').checked = settings.showPartial;
$('context').checked = settings.translateWithContext;
$('st-coi').textContent = self.crossOriginIsolated ? 'WASM multihilo' : 'WASM de 1 hilo';

function currentSettings() {
  return {
    ...settings,
    modelId: $('model').value,
    device: $('device').value,
    translationEngine: $('engine').value,
    bilingual: $('bilingual').checked,
    showPartial: $('partial').checked,
    translateWithContext: $('context').checked
  };
}

function applyView() {
  const s = currentSettings();
  renderer.applySettings(s);
  pipeline?.updateSettings(s);
}
for (const id of ['bilingual', 'partial', 'context', 'engine']) $(id).addEventListener('change', applyView);
applyView();

function setButtons() {
  const ready = !!pipeline?.ready;
  $('realtime').disabled = !ready || !audioBuffer || !!running;
  $('fast').disabled = !ready || !audio16k || !!running;
  $('stop').disabled = !running;
  $('vad').disabled = !audio16k || !!running;
  $('load').disabled = !!running || loadingModels;
}

// ── Audio ───────────────────────────────────────────────────────

async function loadAudio(arrayBuffer, name) {
  const ctx = new AudioContext();
  audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  await ctx.close();
  // Remuestreo de alta calidad a 16 kHz mono con OfflineAudioContext.
  const off = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start();
  audio16k = (await off.startRendering()).getChannelData(0);
  $('file-name').textContent = `${name} · ${audioBuffer.duration.toFixed(1)} s`;
  log(`Audio cargado: ${name} (${audioBuffer.duration.toFixed(1)} s, ${audioBuffer.sampleRate} Hz, ${audioBuffer.numberOfChannels} canales)`);
  setButtons();
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) await loadAudio(await f.arrayBuffer(), f.name);
});

$('sample').addEventListener('click', async () => {
  const r = await fetch(chrome.runtime.getURL('test/samples/jfk.mp3'));
  await loadAudio(await r.arrayBuffer(), 'jfk.mp3');
});

// ── Modelos ─────────────────────────────────────────────────────

function showProgress(p) {
  const box = $('progress');
  if (!p) return box.classList.add('hidden');
  box.classList.remove('hidden');
  $('progress-fill').style.width = (p.pct ?? 0) + '%';
  const what = p.stage === 'mt' ? 'Opus-MT' : p.stage === 'chrome' ? 'traductor de Chrome' : 'Whisper';
  const mb = p.total ? ` · ${Math.round(p.loaded / 1e6)}/${Math.round(p.total / 1e6)} MB` : '';
  $('progress-text').textContent = `Descargando ${what} ${p.pct == null ? '…' : p.pct + '%'}${mb}`;
}

function onStatus(patch) {
  if ('progress' in patch) showProgress(patch.progress);
  if (patch.device) $('st-device').textContent = (patch.device === 'webgpu' ? 'WebGPU' : 'WASM') + (patch.gpuName ? ` · ${patch.gpuName}` : '') + (patch.gpuReason ? ` (${patch.gpuReason})` : '');
  if (patch.engine) $('st-engine').textContent = patch.engine;
  if (patch.warning) log('AVISO', patch.warning);
  if (patch.stats) {
    const s = patch.stats;
    if (s.asrMs) $('st-asr').textContent = `${s.asrMs} ms/hipótesis · RTF ${s.rtf?.toFixed(2)}`;
    if (s.latencyMs && running?.mode === 'realtime') $('st-latency').textContent = (s.latencyMs / 1000).toFixed(2) + ' s';
  }
}

function onDebug(ev) {
  if (ev.type === 'translation') {
    const tr = document.createElement('tr');
    const c = ev.commit || {};
    const cells = [
      ++rows,
      `${(c.startSample / SR).toFixed(1)}–${(c.endSample / SR).toFixed(1)} s`,
      ev.en,
      ev.es ?? '(sin traducción)',
      running?.mode === 'realtime' ? (ev.latencyMs / 1000).toFixed(2) + ' s' : '—',
      c.avgLogprob != null ? c.avgLogprob.toFixed(2) : '—',
      c.noSpeechProb != null ? c.noSpeechProb.toFixed(2) : '—'
    ];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.textContent = v;
      if ([0, 1, 4, 5, 6].includes(i)) td.className = 'num';
      tr.append(td);
    });
    $('results').append(tr);
  } else if (ev.type === 'reject') {
    const li = document.createElement('li');
    li.textContent = `${(ev.startSample / SR).toFixed(1)} s · "${ev.text}" `;
    const em = document.createElement('em');
    em.textContent = `→ ${ev.reason}`;
    li.append(em);
    $('rejects').append(li);
  }
}

$('load').addEventListener('click', async () => {
  const s = currentSettings();
  // La descarga del modelo de Chrome exige un gesto del usuario: lo aprovechamos
  // ya. El traductor creado aquí no se usa (el pipeline crea el suyo): se libera.
  if (s.translationEngine !== 'opus') {
    createChromeTranslator({ allowDownload: true, onProgress: (pct) => showProgress({ stage: 'chrome', pct }) })
      .then((r) => {
        r.translator?.destroy?.();
        log(`Translator API: ${r.availability}${r.error ? ' — ' + r.error : ''}`);
      });
  }
  if (pipeline && pipeline.isCompatible(s) && pipeline.ready) {
    pipeline.updateSettings(s);
    log('Modelos ya cargados');
    return;
  }
  pipeline?.dispose();
  log(`Cargando ${s.modelId} (backend ${s.device}, traducción ${s.translationEngine})…`);
  const t0 = performance.now();
  // Referencia local: si mientras tanto se crea otro pipeline, este clic ya no
  // debe tocar la variable global.
  const p = new Pipeline({
    baseUrl: BASE,
    settings: s,
    onStatus,
    onSubtitle: (msg) => renderer.update(msg),
    onDebug,
    onFatal: (e) => log('ERROR FATAL', e.message)
  });
  pipeline = p;
  loadingModels = true;
  setButtons();
  try {
    await p.load();
    if (pipeline === p) log(`Modelos listos en ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } catch (e) {
    if (pipeline === p) {
      log('ERROR', e.message);
      p.dispose();
      pipeline = null;
    }
  }
  if (pipeline === p || !pipeline) {
    loadingModels = false;
    showProgress(null);
    setButtons();
  }
});

// ── Ejecución ───────────────────────────────────────────────────

function resetResults() {
  rows = 0;
  $('results').textContent = '';
  $('rejects').textContent = '';
  $('st-latency').textContent = '—';
  renderer.clear();
  pipeline.resetStream();
}

// Tiempo real: se reproduce el audio y pasa por el MISMO AudioWorklet que la
// captura de la pestaña (remuestreo incluido).
$('realtime').addEventListener('click', async () => {
  resetResults();
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(chrome.runtime.getURL('audio/capture-worklet.js'));
  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  const node = new AudioWorkletNode(ctx, 'trtw-capture', { processorOptions: { targetRate: SR, frameSize: FRAME } });
  node.port.onmessage = (e) => { if (e.data?.type === 'frame') pipeline.pushFrame(e.data.frame); };
  src.connect(node);
  src.connect(ctx.destination);

  let stopped = false;
  const finish = async () => {
    if (stopped) return;
    stopped = true;
    node.port.postMessage({ type: 'stop' });
    // Un poco de silencio para cerrar la última locución.
    for (let i = 0; i < 25; i++) pipeline.pushFrame(new Float32Array(FRAME));
    await pipeline.flush();
    await ctx.close();
    log('Fin (tiempo real)');
    running = null;
    setButtons();
  };
  src.onended = finish;
  running = { mode: 'realtime', stop: () => { src.stop(); } };
  setButtons();
  log(`Reproduciendo en tiempo real (AudioContext a ${ctx.sampleRate} Hz → worklet → 16 kHz)`);
  src.start();
});

// Rápido: sin reproducir; se espera a que el ASR termine antes de cada trama,
// como si el equipo fuera infinitamente rápido (resultado determinista).
$('fast').addEventListener('click', async () => {
  resetResults();
  let stop = false;
  running = { mode: 'fast', stop: () => { stop = true; } };
  setButtons();
  const t0 = performance.now();
  log('Procesando en modo rápido…');
  for (let i = 0; i + FRAME <= audio16k.length && !stop; i += FRAME) {
    pipeline.pushFrame(audio16k.slice(i, i + FRAME));
    await pipeline.idle();
  }
  for (let i = 0; i < 25; i++) pipeline.pushFrame(new Float32Array(FRAME));
  await pipeline.flush();
  const secs = (performance.now() - t0) / 1000;
  log(`Fin (rápido): ${(audio16k.length / SR).toFixed(1)} s de audio en ${secs.toFixed(1)} s`);
  running = null;
  setButtons();
});

$('stop').addEventListener('click', () => running?.stop());

// ── Solo VAD (no necesita descargar modelos) ────────────────────

$('vad').addEventListener('click', async () => {
  ort.env.wasm.wasmPaths = BASE + 'vendor/ort/';
  ort.env.wasm.numThreads = 1;
  const vad = await SileroVad.create(ort, BASE + 'models/silero/silero_vad_v5.onnx');
  const probs = [];
  const t0 = performance.now();
  for (let i = 0; i + FRAME <= audio16k.length; i += FRAME) probs.push(await vad.process(audio16k.subarray(i, i + FRAME)));
  const ms = performance.now() - t0;
  drawVad(probs);
  const speech = probs.filter((p) => p >= 0.5).length / probs.length;
  log(`VAD: ${probs.length} tramas en ${ms.toFixed(0)} ms (${(ms / probs.length).toFixed(2)} ms/trama), ${(speech * 100).toFixed(0)} % con voz`);
  window.__trtwVad = { frames: probs.length, speech, ms }; // para tests automáticos
  await vad.release();
});

function drawVad(probs) {
  const c = $('vad-canvas');
  const g = c.getContext('2d');
  const w = c.width, h = c.height;
  g.clearRect(0, 0, w, h);
  const bw = w / probs.length;
  probs.forEach((p, i) => {
    g.fillStyle = p >= 0.5 ? '#7c3aed' : '#3f3f46';
    g.fillRect(i * bw, h - p * (h - 4), Math.max(1, bw), p * (h - 4));
  });
  g.strokeStyle = '#a1a1aa';
  g.setLineDash([4, 4]);
  g.beginPath();
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
}

setButtons();
log('Página de test lista. 1) Carga un audio  2) Carga los modelos  3) Tiempo real o Rápido.');
