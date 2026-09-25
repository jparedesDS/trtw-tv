// trtw.tv — Service worker (orquestador)
//
// MV3 puede dormir este service worker en cualquier momento, así que aquí NO se
// guarda estado en memoria que haga falta después: el estado real lo tiene el
// documento offscreen (captura + modelos) y se consulta cada vez con
// chrome.runtime.getContexts() + un mensaje 'get-status'.
//
// Estados del offscreen: idle · starting · loading · capturing · error

import { loadSettings, PIPELINE_KEYS } from './lib/settings.js';
import { createLogger } from './lib/log.js';

const log = createLogger('sw');
const OFFSCREEN_PATH = 'offscreen/offscreen.html';
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

// ── Cola de operaciones ─────────────────────────────────────────
// start/stop se serializan para que dos clics rápidos (o Alt+S + popup) no
// se pisen.

let opChain = Promise.resolve();
function enqueue(fn) {
  const run = opChain.then(fn, fn);
  opChain = run.catch(() => {});
  return run;
}

// ── Offscreen ───────────────────────────────────────────────────

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL]
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA', 'WORKERS'],
    justification: 'Capturar el audio de la pestaña y ejecutar Whisper/traducción en local'
  });
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (e) {
    log.warn('No se pudo cerrar el offscreen:', e.message);
  }
}

// Envía un mensaje al offscreen con tiempo máximo de espera.
function sendToOffscreen(message, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('El documento offscreen no responde')), timeoutMs);
    chrome.runtime.sendMessage({ ...message, target: 'offscreen' }).then(
      (resp) => { clearTimeout(timer); resolve(resp); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// Estado real: si no hay offscreen → idle; si no responde → error.
async function getStatus() {
  if (!(await hasOffscreen())) return { state: 'idle' };
  try {
    const status = await sendToOffscreen({ type: 'get-status' }, 2000);
    return status || { state: 'error', error: 'Respuesta vacía del offscreen' };
  } catch (e) {
    return { state: 'error', error: e.message, unresponsive: true };
  }
}

// ¿Está compilado el bundle? Sin `npm run build` el offscreen no carga nada y
// solo veríamos un timeout, así que lo comprobamos para dar un error claro.
async function checkBuild() {
  try {
    const r = await fetch(chrome.runtime.getURL('dist/offscreen.js'), { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
}

// ── Start / Stop ────────────────────────────────────────────────

async function startCapture(tabId) {
  if (!tabId) return { success: false, error: 'No hay pestaña activa' };

  if (!(await checkBuild())) {
    const error = 'Falta compilar la extensión: ejecuta "npm install" y "npm run build" y recárgala.';
    log.error(error);
    setBadge('error');
    return { success: false, error };
  }

  // Solo tiene sentido en Twitch/YouTube (es donde se inyecta el overlay).
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url || !/^https?:\/\/([^/]+\.)?(twitch\.tv|youtube\.com)\//.test(tab.url)) {
    return { success: false, error: 'Abre un directo de Twitch o un vídeo de YouTube y vuelve a pulsar Start.' };
  }

  const status = await getStatus();

  // Ya capturando esta pestaña → nada que hacer.
  if (['starting', 'loading', 'capturing'].includes(status.state) && status.tabId === tabId) {
    return { success: true, status };
  }

  // Otra pestaña → paramos la anterior.
  if (['starting', 'loading', 'capturing'].includes(status.state)) {
    await stopCapture({ keepOffscreen: true });
  }

  // Desde ERROR (o si no responde) se hace reset completo: cerrar el
  // offscreen libera el stream de la pestaña y los modelos.
  if (status.state === 'error') {
    log.info('Reset desde estado de error:', status.error);
    await closeOffscreen();
  }

  try {
    setBadge('starting');
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreen();
    const settings = await loadSettings();
    const resp = await sendToOffscreen({ type: 'start', streamId, tabId, settings }, 15000);
    if (!resp?.success) throw new Error(resp?.error || 'No se pudo iniciar la captura');

    await chrome.storage.session.set({ activeTabId: tabId });
    log.info('Captura iniciada en la pestaña', tabId);
    return { success: true, status: resp.status };
  } catch (e) {
    log.error('Fallo al iniciar:', e.message);
    // Estado limpio para que el siguiente intento empiece de cero.
    await closeOffscreen();
    await chrome.storage.session.remove('activeTabId');
    setBadge('error');
    return { success: false, error: friendlyError(e.message) };
  }
}

async function stopCapture({ keepOffscreen = true } = {}) {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  try {
    if (await hasOffscreen()) {
      await sendToOffscreen({ type: 'stop' }, 3000);
      if (!keepOffscreen) await closeOffscreen();
    }
  } catch (e) {
    // Si no responde, lo cerramos: parar SIEMPRE debe funcionar.
    log.warn('Stop sin respuesta, cerrando offscreen:', e.message);
    await closeOffscreen();
  }
  await chrome.storage.session.remove('activeTabId');
  if (activeTabId) sendToTab(activeTabId, { type: 'clear-subtitles' });
  setBadge('idle');
  log.info('Captura detenida');
  return { success: true };
}

function friendlyError(msg = '') {
  if (/active stream/i.test(msg)) return 'La pestaña ya se está capturando. Pulsa Stop y vuelve a intentarlo.';
  if (/invoked|activeTab|permission/i.test(msg)) return 'Chrome no permite capturar esta pestaña. Abre el popup desde la pestaña de Twitch/YouTube y pulsa Start.';
  if (/chrome:\/\//i.test(msg)) return 'No se pueden capturar páginas internas de Chrome.';
  return msg;
}

// ── Mensajes ────────────────────────────────────────────────────

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === 'offscreen') return false; // no es para nosotros

  switch (message?.type) {
    case 'start-capture':
      enqueue(() => startCapture(message.tabId)).then(sendResponse);
      return true;

    case 'stop-capture':
      enqueue(() => stopCapture()).then(sendResponse);
      return true;

    case 'reset':
      enqueue(async () => {
        await stopCapture({ keepOffscreen: false });
        return { success: true };
      }).then(sendResponse);
      return true;

    case 'get-state':
      getStatus().then(sendResponse);
      return true;

    // Del offscreen: subtítulos → content script de la pestaña capturada.
    case 'subtitle':
      if (message.tabId) sendToTab(message.tabId, { type: 'subtitle-update', ...message.payload });
      return false;

    // Del offscreen: cambios de estado → badge + overlay (el popup lo recibe
    // directamente porque runtime.sendMessage llega a todas las páginas).
    case 'status':
      setBadge(message.status?.state);
      if (message.status?.tabId) sendToTab(message.status.tabId, { type: 'status-update', status: message.status });
      return false;

    // Del offscreen: traducir en la pestaña (Chrome Translator API en el
    // content script, por si no está disponible en el documento offscreen).
    case 'tab-translate':
      chrome.tabs.sendMessage(message.tabId, { type: 'trtw-translate', op: message.op, text: message.text })
        .then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;

    // Del offscreen: lleva un rato parado → liberamos memoria/GPU.
    case 'offscreen-idle':
      enqueue(async () => {
        const status = await getStatus();
        if (status.state === 'idle') {
          log.info('Offscreen inactivo: cerrando para liberar memoria');
          await closeOffscreen();
        }
      });
      return false;
  }
  return false;
});

// Ajustes del pipeline → al offscreen (el offscreen no puede leer storage).
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!PIPELINE_KEYS.some((k) => k in changes)) return;
  if (!(await hasOffscreen())) return;
  const settings = await loadSettings();
  sendToOffscreen({ type: 'settings', settings }).catch(() => {});
});

// ── Atajo Alt+S ─────────────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-subtitles') return;
  enqueue(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const status = await getStatus();
    if (['starting', 'loading', 'capturing'].includes(status.state)) {
      return stopCapture();
    }
    if (tab) return startCapture(tab.id);
  });
});

// ── Limpieza al cerrar la pestaña ───────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { activeTabId } = await chrome.storage.session.get('activeTabId');
  if (tabId === activeTabId) enqueue(() => stopCapture());
});

// ── Badge ───────────────────────────────────────────────────────

const BADGES = {
  idle: { text: '', color: '#666666' },
  starting: { text: '…', color: '#EAB308' },
  loading: { text: '…', color: '#EAB308' },
  capturing: { text: 'ON', color: '#22C55E' },
  error: { text: '!', color: '#EF4444' }
};

function setBadge(state) {
  const b = BADGES[state] || BADGES.idle;
  chrome.action.setBadgeText({ text: b.text });
  chrome.action.setBadgeBackgroundColor({ color: b.color });
}

// Al despertar, el badge refleja el estado real.
getStatus().then((s) => setBadge(s.state));
log.info('Service worker cargado');
