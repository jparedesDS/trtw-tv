// trtw.tv — Content script (Twitch y YouTube)
//
// - Pinta los subtítulos sobre el reproductor (también en pantalla completa y
//   en el modo teatro de Twitch).
// - Hace de relé para la Translator API de Chrome cuando el documento
//   offscreen no la tiene disponible.
//
// Se compila con esbuild (formato IIFE) porque los content scripts no admiten
// módulos ES. Se carga por el manifest y, si falta (pestaña abierta antes de
// instalar o actualizar la extensión), el service worker lo inyecta al pulsar
// Start con chrome.scripting.

import { SubtitleRenderer } from '../lib/subtitle-renderer.js';
import { createChromeTranslator } from '../lib/chrome-translator.js';
import { loadSettings } from '../lib/settings.js';

const PREFIX = '[trtw.tv][overlay]';
const renderer = new SubtitleRenderer(document);

// ── Una sola instancia viva ─────────────────────────────────────
// Al actualizar o recargar la extensión, el content script antiguo se queda
// "huérfano" en las pestañas abiertas (sin chrome.runtime) con su overlay en el
// DOM. La instancia nueva oculta cualquier overlay que no sea el suyo y las
// antiguas se retiran solas en cuanto lo detectan.
const INSTANCE = Math.random().toString(36).slice(2);
globalThis.__trtwOverlayInstance = INSTANCE;
renderer.root.dataset.trtwInstance = INSTANCE;

function alive() {
  return globalThis.__trtwOverlayInstance === INSTANCE && !!chrome.runtime?.id;
}

function hideOtherInstances() {
  let style = document.getElementById('trtw-instance-style');
  if (!style) {
    style = document.createElement('style');
    style.id = 'trtw-instance-style';
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = `#trtw-subtitle-container:not([data-trtw-instance="${INSTANCE}"]) { display: none !important; }`;
}

// ── Localizar el reproductor ────────────────────────────────────

const PLAYER_SELECTORS = [
  '.video-player__container',          // Twitch (normal, teatro y pantalla completa)
  '[data-a-target="video-player"]',    // Twitch
  '#movie_player',                     // YouTube
  '.html5-video-player'                // YouTube
];

// El vídeo más grande visible (Twitch puede tener vídeos de anuncios/previews).
function mainVideo() {
  let best = null;
  let bestArea = 0;
  for (const v of document.querySelectorAll('video')) {
    const r = v.getBoundingClientRect();
    const area = r.width * r.height;
    if (area > bestArea) { best = v; bestArea = area; }
  }
  return best;
}

function findPlayer() {
  const video = mainVideo();
  if (video) {
    for (const sel of PLAYER_SELECTORS) {
      const c = video.closest(sel);
      if (c) return c;
    }
    return video.parentElement;
  }
  for (const sel of PLAYER_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function attach() {
  // En pantalla completa solo se ve el elemento a pantalla completa.
  const fs = document.fullscreenElement;
  let target = findPlayer();
  if (fs && fs.tagName !== 'VIDEO' && (!target || !fs.contains(target))) target = fs;
  if (!target) return;
  if (target.tagName === 'VIDEO') target = target.parentElement;
  if (getComputedStyle(target).position === 'static') target.style.position = 'relative';
  if (renderer.root.parentElement !== target) {
    renderer.mount(target);
    console.debug(PREFIX, 'overlay colocado en', target);
  }
}

// SPA (cambio de canal, modo teatro…): recolocar si el reproductor cambia.
// Throttle (no debounce): el chat de Twitch muta el DOM sin parar.
let checkPending = false;
const observer = new MutationObserver(() => {
  if (checkPending) return;
  checkPending = true;
  setTimeout(() => {
    checkPending = false;
    if (!alive()) return retire();
    const player = findPlayer();
    if (!renderer.mounted || (player && !player.contains(renderer.root) && !document.fullscreenElement)) attach();
  }, 500);
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// Instancia huérfana o sustituida: deja de observar y quita su overlay.
function retire() {
  observer.disconnect();
  renderer.unmount();
}

document.addEventListener('fullscreenchange', () => { if (alive()) setTimeout(attach, 50); });

// ── Ajustes ─────────────────────────────────────────────────────

loadSettings().then((s) => renderer.applySettings(s));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') loadSettings().then((s) => renderer.applySettings(s));
});

// ── Estado (avisos pequeños sobre el vídeo) ─────────────────────

const DEVICE = { webgpu: 'WebGPU', wasm: 'WASM' };
let lastState = null;

function showStatus(status) {
  const state = status?.state;
  if (state === 'loading') {
    const p = status.progress;
    renderer.setStatus(p?.pct != null ? `trtw.tv · descargando modelo ${p.pct}%` : 'trtw.tv · cargando modelos…');
  } else if (state === 'capturing' && lastState !== 'capturing') {
    renderer.setStatus(`trtw.tv · subtítulos activados${status.device ? ' · ' + DEVICE[status.device] : ''}`, { timeout: 2500 });
  } else if (state === 'error') {
    renderer.setStatus(`trtw.tv · ${status.error || 'error'}`, { error: true, timeout: 8000 });
  } else if (state === 'idle') {
    renderer.setStatus(null);
  }
  lastState = state;
}

// ── Relé de traducción ──────────────────────────────────────────

let translatorPromise = null;
function getTranslator() {
  translatorPromise ??= createChromeTranslator().then((r) => {
    if (!r.translator) translatorPromise = null; // se reintentará
    return r;
  });
  return translatorPromise;
}

// La descarga del modelo de Chrome necesita un gesto del usuario. Si se
// arrancó con Alt+S (sin pasar por el popup), aprovechamos el siguiente clic o
// tecla en la página para iniciarla. Una sola vez; el offscreen cambiará a
// Chrome solo cuando termine.
let downloadArmed = false;
function armDownloadOnGesture() {
  if (downloadArmed) return;
  downloadArmed = true;
  const onGesture = () => {
    window.removeEventListener('pointerdown', onGesture, true);
    window.removeEventListener('keydown', onGesture, true);
    renderer.setStatus('trtw.tv · descargando el traductor de Chrome…');
    createChromeTranslator({
      allowDownload: true,
      onProgress: (pct) => renderer.setStatus(`trtw.tv · descargando el traductor de Chrome ${pct}%`)
    }).then((r) => {
      downloadArmed = false;
      if (r.translator) {
        translatorPromise = Promise.resolve(r); // lo reutiliza el relé
        renderer.setStatus('trtw.tv · traductor de Chrome listo', { timeout: 2500 });
      } else {
        console.warn(PREFIX, 'No se pudo descargar el traductor de Chrome:', r.error || r.availability);
        renderer.setStatus(null);
      }
    });
  };
  window.addEventListener('pointerdown', onGesture, true);
  window.addEventListener('keydown', onGesture, true);
}

async function handleTranslate(message) {
  const r = await getTranslator();
  if (!r.translator) {
    if (r.availability === 'downloadable') armDownloadOnGesture();
    return { ok: false, availability: r.availability, error: r.error };
  }
  if (message.op === 'probe') return { ok: true };
  try {
    return { ok: true, text: await r.translator.translate(message.text) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Mensajes ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!alive()) return false;
  switch (message?.type) {
    case 'trtw-ping':
      sendResponse({ ok: true });
      return false;
    case 'subtitle-update':
      if (!renderer.mounted) attach();
      renderer.update(message);
      return false;
    case 'status-update':
      if (!renderer.mounted) attach();
      showStatus(message.status);
      return false;
    case 'clear-subtitles':
      renderer.clear();
      renderer.setStatus(null);
      lastState = 'idle';
      return false;
    case 'trtw-translate':
      handleTranslate(message).then(sendResponse);
      return true;
  }
  return false;
});

hideOtherInstances();
attach();
