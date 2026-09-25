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
import { withTimeout } from './lib/async.js';

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
  return withTimeout(
    chrome.runtime.sendMessage({ ...message, target: 'offscreen' }),
    timeoutMs,
    'El documento offscreen no responde'
  );
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

  // El overlay tiene que estar en la pestaña: si se abrió antes de instalar o
  // actualizar la extensión, no tiene el content script y lo inyectamos.
  try {
    await ensureOverlay(tabId);
  } catch (e) {
    log.error('No se pudo inyectar el overlay:', e.message);
    return { success: false, error: 'No se pudo preparar la pestaña. Recárgala (F5) y vuelve a pulsar Start.' };
  }

  const status = await getStatus();
  const active = ['starting', 'loading', 'capturing'].includes(status.state);

  // Ya capturando esta pestaña → nada que hacer.
  if (active && status.tabId === tabId) return { success: true, status };

  // 1) Offscreen listo ANTES de pedir el streamId: los ids de tabCapture
  //    caducan en pocos segundos y crear el offscreen la primera vez (cargar
  //    su código) puede tardar lo suficiente como para invalidarlo.
  //    Solo se cierra si está roto (no responde o su error no es recuperable).
  if (status.state === 'error' && (status.unresponsive || !status.recoverable)) {
    log.info('Reset desde estado de error:', status.error);
    await closeOffscreen();
  }
  let settings;
  try {
    await ensureOffscreen();
    settings = await loadSettings();
  } catch (e) {
    log.error('No se pudo crear el offscreen:', e.message);
    return { success: false, error: friendlyError(e.message) };
  }

  // 2) Si se estaba capturando otra pestaña, la paramos (los modelos se quedan).
  if (active) await stopCapture({ keepOffscreen: true });

  // 3) streamId recién pedido → al offscreen inmediatamente. Si Chrome no logra
  //    arrancar la captura con él, se reintenta una vez con uno nuevo.
  setBadge('starting');
  let resp;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (e) {
      log.warn('tabCapture:', e.message);
      setBadge((await getStatus()).state);
      return { success: false, error: friendlyError(e.message) };
    }
    try {
      resp = await sendToOffscreen({ type: 'start', streamId, tabId, settings }, 15000);
    } catch (e) {
      // Sin respuesta: el offscreen está roto → el siguiente intento empieza de cero.
      log.error('El offscreen no arrancó:', e.message);
      await closeOffscreen();
      await chrome.storage.session.remove('activeTabId');
      setBadge('error');
      return { success: false, error: friendlyError(e.message) };
    }
    if (resp?.success || attempt === 2 || !/tab capture|captur/i.test(resp?.error || '')) break;
    log.warn(`La captura falló (${resp.error}); reintentando con un streamId nuevo`);
    await new Promise((r) => setTimeout(r, 300));
  }

  if (!resp?.success) {
    // Falló la captura de audio; el offscreen ya está en 'error' recuperable.
    log.error('Fallo al iniciar la captura:', resp?.error);
    await chrome.storage.session.remove('activeTabId');
    setBadge('error');
    return { success: false, error: friendlyError(resp?.error || 'No se pudo iniciar la captura') };
  }

  await chrome.storage.session.set({ activeTabId: tabId });
  log.info('Captura iniciada en la pestaña', tabId);
  return { success: true, status: resp.status };
}

// ¿Hay un content script vivo en la pestaña? Si no, lo inyectamos.
async function ensureOverlay(tabId) {
  const alive = await withTimeout(chrome.tabs.sendMessage(tabId, { type: 'trtw-ping' }), 1000, 'ping')
    .then((r) => r?.ok === true, () => false);
  if (alive) return;
  log.info('La pestaña no tiene el overlay: inyectándolo');
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/overlay.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['dist/overlay.js'] });
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
  if (/error starting tab capture/i.test(msg)) {
    return 'Chrome no pudo capturar el audio de la pestaña. Vuelve a pulsar Start; si se repite, recarga la pestaña (F5) y comprueba que no se esté compartiendo o grabando con otra extensión.';
  }
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
      // Sin pestaña (p. ej. un reintento del traductor después de Stop).
      if (!message.tabId) {
        sendResponse({ ok: false, error: 'No hay pestaña capturada' });
        return false;
      }
      chrome.tabs.sendMessage(message.tabId, { type: 'trtw-translate', op: message.op, text: message.text })
        .then(sendResponse, (e) => sendResponse({ ok: false, error: e.message }));
      return true;

    // Del offscreen: el audio de la pestaña se cortó solo (pestaña cerrada,
    // captura revocada…). Limpiamos el overlay y el estado como en un Stop.
    case 'capture-ended':
      enqueue(async () => {
        if (message.tabId) sendToTab(message.tabId, { type: 'clear-subtitles' });
        await chrome.storage.session.remove('activeTabId');
        setBadge('idle');
      });
      return false;

    // Del offscreen: lleva un rato parado → liberamos memoria/GPU.
    case 'offscreen-idle':
      enqueue(async () => {
        const status = await getStatus();
        if (status.state === 'idle' || status.state === 'error') {
          log.info('Offscreen inactivo: cerrando para liberar memoria');
          await closeOffscreen();
          setBadge('idle');
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
