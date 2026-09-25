// trtw.tv — Popup: estado, Start/Stop y ajustes.

import { DEFAULT_SETTINGS, MODELS, loadSettings, saveSettings } from '../lib/settings.js';
import { createChromeTranslator } from '../lib/chrome-translator.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };
let currentState = 'idle';

const STATES = {
  idle: { badge: 'status-idle', text: 'Parado', label: 'Start', active: false },
  starting: { badge: 'status-loading', text: 'Iniciando…', label: 'Stop', active: true },
  loading: { badge: 'status-loading', text: 'Cargando…', label: 'Stop', active: true },
  capturing: { badge: 'status-capturing', text: 'En directo', label: 'Stop', active: true },
  error: { badge: 'status-error', text: 'Error', label: 'Reintentar', active: false }
};

const ENGINE_NAMES = {
  chrome: 'Chrome integrado',
  'chrome-tab': 'Chrome integrado (pestaña)',
  opus: 'Opus-MT (local)',
  none: 'Sin traducción'
};

// ── Estado ──────────────────────────────────────────────────────

function render(status = {}) {
  currentState = status.state || 'idle';
  const s = STATES[currentState] || STATES.idle;
  $('status-badge').className = 'status-badge ' + s.badge;
  $('status-text').textContent = s.text;
  $('toggle-label').textContent = s.label;
  $('main-toggle').classList.toggle('active', s.active);

  const err = $('error-box');
  const errorText = currentState === 'error' ? status.error : status.warning;
  err.textContent = errorText || '';
  err.classList.toggle('hidden', !errorText);

  if (status.device) {
    const dev = status.device === 'webgpu' ? 'WebGPU' : 'WASM (CPU)';
    $('info-device').textContent = status.gpuName ? `${dev} · ${status.gpuName}` : dev;
    $('info-device').title = status.gpuReason ? `Sin WebGPU: ${status.gpuReason}` : '';
  }
  if (status.engine) $('info-engine').textContent = ENGINE_NAMES[status.engine] || status.engine;
  if (status.stats?.latencyMs) $('info-latency').textContent = (status.stats.latencyMs / 1000).toFixed(1) + ' s';

  renderProgress(status.progress);
}

function renderProgress(p) {
  const box = $('progress-section');
  if (!p) return box.classList.add('hidden');
  box.classList.remove('hidden');
  const what = p.stage === 'mt' ? 'traductor' : p.stage === 'chrome' ? 'traductor de Chrome' : 'modelo de voz';
  const mb = p.total ? ` (${Math.round(p.loaded / 1e6)}/${Math.round(p.total / 1e6)} MB)` : '';
  $('progress-label').textContent = `Descargando ${what}${mb}…`;
  $('progress-percent').textContent = p.pct == null ? '' : p.pct + '%';
  $('progress-fill').style.width = (p.pct ?? 0) + '%';
}

async function refresh() {
  try {
    render(await chrome.runtime.sendMessage({ type: 'get-state' }));
  } catch {
    render({ state: 'idle' });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'status') render(message.status);
  return false;
});

// ── Chrome Translator: la descarga del modelo necesita un gesto del usuario ──
// El documento offscreen no tiene "activación de usuario", así que aprovechamos
// el clic en Start para iniciar la descarga desde aquí si hace falta.

async function warmUpChromeTranslator() {
  if (settings.translationEngine === 'opus') return;
  const r = await createChromeTranslator({
    allowDownload: true,
    onProgress: (pct) => renderProgress({ stage: 'chrome', pct })
  });
  // Solo queríamos que Chrome tuviera el modelo: el offscreen crea su propio traductor.
  r.translator?.destroy?.();
  if (r.availability !== 'available') renderProgress(null);
  if (r.error) console.warn('[trtw.tv][popup] Translator:', r.error);
}

// ── Start / Stop ────────────────────────────────────────────────

async function onToggle() {
  const active = STATES[currentState]?.active;
  if (!active) warmUpChromeTranslator(); // antes de cualquier await: conserva el gesto

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active) {
    render({ state: 'idle' });
    await chrome.runtime.sendMessage({ type: 'stop-capture' });
    return refresh();
  }
  if (!tab) return;
  render({ state: 'starting' });
  const result = await chrome.runtime.sendMessage({ type: 'start-capture', tabId: tab.id });
  if (!result?.success) return render({ state: 'error', error: result?.error || 'No se pudo iniciar' });
  render(result.status || { state: 'loading' });
}

// ── Ajustes ─────────────────────────────────────────────────────

// El popup se destruye en cuanto pierde el foco, así que no podemos confiar en
// un temporizador: los controles "de un clic" guardan al momento, el texto y
// los deslizadores con un pequeño retraso, y todo lo pendiente se guarda al
// cerrarse el popup.
let saveTimer = null;
let pendingPatch = {};

function flush() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!Object.keys(pendingPatch).length) return;
  const p = pendingPatch;
  pendingPatch = {};
  saveSettings(p).catch(console.error);
}

function save(patch, { debounce = false } = {}) {
  Object.assign(settings, patch);
  Object.assign(pendingPatch, patch);
  if (!debounce) return flush();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 250);
}

window.addEventListener('pagehide', flush);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flush();
});

function bindSettings() {
  const model = $('model-select');
  for (const m of MODELS) model.add(new Option(m.label, m.id));
  model.value = settings.modelId;
  model.onchange = () => save({ modelId: model.value });

  $('device-select').value = settings.device;
  $('device-select').onchange = (e) => save({ device: e.target.value });

  $('engine-select').value = settings.translationEngine;
  $('engine-select').onchange = (e) => save({ translationEngine: e.target.value });

  $('context-toggle').checked = settings.translateWithContext;
  $('context-toggle').onchange = (e) => save({ translateWithContext: e.target.checked });

  $('glossary').value = settings.glossary;
  $('glossary').oninput = (e) => save({ glossary: e.target.value }, { debounce: true });
  $('glossary').onblur = flush;

  $('mode-select').value = settings.subtitleMode;
  $('mode-select').onchange = (e) => save({ subtitleMode: e.target.value });

  $('bilingual-toggle').checked = settings.bilingual;
  $('bilingual-toggle').onchange = (e) => save({ bilingual: e.target.checked });

  $('partial-toggle').checked = settings.showPartial;
  $('partial-toggle').onchange = (e) => save({ showPartial: e.target.checked });

  const fs = $('font-size');
  fs.value = settings.fontSize;
  $('font-size-value').textContent = settings.fontSize + 'px';
  fs.oninput = () => {
    $('font-size-value').textContent = fs.value + 'px';
    save({ fontSize: +fs.value }, { debounce: true });
  };
  fs.onchange = flush; // al soltar el deslizador

  const op = $('bg-opacity');
  op.value = Math.round(settings.bgOpacity * 100);
  $('bg-opacity-value').textContent = op.value + '%';
  op.oninput = () => {
    $('bg-opacity-value').textContent = op.value + '%';
    save({ bgOpacity: op.value / 100 }, { debounce: true });
  };
  op.onchange = flush;

  const colors = $('color-options');
  const markColor = () => colors.querySelectorAll('.color-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.color === settings.textColor);
  });
  markColor();
  colors.onclick = (e) => {
    const btn = e.target.closest('.color-btn');
    if (!btn) return;
    save({ textColor: btn.dataset.color });
    markColor();
  };

  $('position-select').value = settings.subtitlePosition;
  $('position-select').onchange = (e) => save({ subtitlePosition: e.target.value });

  $('test-link').onclick = (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('test/test.html') });
  };
  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
}

// ── Init ────────────────────────────────────────────────────────

settings = await loadSettings();
bindSettings();
$('main-toggle').addEventListener('click', onToggle);
await refresh();
