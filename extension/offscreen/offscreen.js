// trtw.tv — Documento offscreen
//
// Aquí vive todo lo pesado: captura del audio de la pestaña, AudioWorklet,
// VAD, Whisper (en un worker) y traducción. Es la FUENTE DE VERDAD del estado:
// el service worker nos pregunta con 'get-status'.
//
// Ojo: los documentos offscreen solo tienen acceso a chrome.runtime (no a
// chrome.storage), por eso los ajustes llegan en los mensajes.

import { Pipeline } from '../lib/pipeline.js';
import { createLogger } from '../lib/log.js';

const log = createLogger('offscreen');
const IDLE_CLOSE_MS = 10 * 60 * 1000; // liberar modelos tras 10 min parado

let status = { state: 'idle' };
let pipeline = null;
let audioContext = null;
let mediaStream = null;
let workletNode = null;
let idleTimer = null;
let statusTimer = null;

// ── Estado ──────────────────────────────────────────────────────

function setStatus(patch) {
  status = { ...status, ...patch };
  // Los avisos de progreso pueden ser muchos: agrupamos ~5 por segundo.
  if (statusTimer) return;
  statusTimer = setTimeout(() => {
    statusTimer = null;
    chrome.runtime.sendMessage({ type: 'status', status }).catch(() => {});
  }, 200);
}

// recoverable = el fallo es solo de la captura de audio (streamId caducado,
// pestaña cerrada…): los modelos siguen sirviendo y se conservan para el
// siguiente Start. Si falla el propio pipeline, se descarta y se empieza de cero.
function fail(error, { recoverable = false } = {}) {
  const message = error?.message || String(error);
  log.error(recoverable ? 'Error de captura:' : 'Error fatal:', message);
  teardownAudio();
  if (!recoverable) {
    pipeline?.dispose();
    pipeline = null;
  }
  setStatus({ state: 'error', error: message, recoverable });
  armIdleClose();
}

// Si nadie vuelve a pulsar Start en un rato, pedimos que nos cierren para
// liberar los modelos (memoria / GPU).
function armIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'offscreen-idle' }).catch(() => {});
  }, IDLE_CLOSE_MS);
}

// ── Captura ─────────────────────────────────────────────────────

async function start({ streamId, tabId, settings }) {
  clearTimeout(idleTimer);
  teardownAudio();
  setStatus({ state: 'starting', tabId, error: null, recoverable: null, modelId: settings.modelId });

  // 1) Modelos: reutilizamos el pipeline si el modelo/backend no han cambiado.
  if (pipeline && !pipeline.isCompatible(settings)) {
    log.info('Cambió el modelo o el backend: recargando');
    pipeline.dispose();
    pipeline = null;
  }
  if (!pipeline) {
    pipeline = new Pipeline({
      baseUrl: chrome.runtime.getURL(''),
      settings,
      tabRelay: (op, text) => chrome.runtime.sendMessage({ type: 'tab-translate', tabId: status.tabId, op, text }),
      onStatus: (patch) => setStatus(patch),
      onSubtitle: (payload) => {
        chrome.runtime.sendMessage({ type: 'subtitle', tabId: status.tabId, payload }).catch(() => {});
      },
      onFatal: (e) => fail(e)
    });
  } else {
    pipeline.updateSettings(settings);
  }

  // 2) Audio de la pestaña
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
  });

  // AudioContext a la frecuencia nativa: el usuario lo sigue oyendo con calidad
  // completa; el worklet ya se encarga de bajar a 16 kHz para el ASR.
  audioContext = new AudioContext({ latencyHint: 'playback' });
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio/capture-worklet.js'));
  const source = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'trtw-capture', {
    processorOptions: { targetRate: 16000, frameSize: 512 }
  });
  workletNode.port.onmessage = (e) => {
    if (e.data?.type === 'frame') pipeline?.pushFrame(e.data.frame);
  };
  source.connect(workletNode);
  // tabCapture silencia la pestaña: volvemos a sacar el audio por los altavoces.
  source.connect(audioContext.destination);

  // Si el usuario deja de compartir o la pestaña muere, el track termina.
  mediaStream.getAudioTracks()[0]?.addEventListener('ended', () => {
    log.warn('El stream de la pestaña terminó');
    const endedTab = status.tabId;
    stop();
    // stop() deja tabId en null: avisamos al service worker para que limpie el overlay.
    chrome.runtime.sendMessage({ type: 'capture-ended', tabId: endedTab }).catch(() => {});
  });

  log.info(`Captura iniciada (AudioContext a ${audioContext.sampleRate} Hz)`);

  // 3) Carga de modelos en segundo plano (el progreso llega por onStatus).
  //    No se espera aquí: el service worker solo aguarda a que la captura arranque.
  const p = pipeline;
  if (!p.ready) {
    setStatus({ state: 'loading' });
    p.load().then(
      () => { if (pipeline === p && status.state === 'loading') setStatus({ state: 'capturing', progress: null }); },
      (e) => { if (pipeline === p) fail(e); }
    );
  } else {
    setStatus({ state: 'capturing' });
    p.prepareForTab();
  }
}

function teardownAudio() {
  if (workletNode) {
    workletNode.port.postMessage({ type: 'stop' });
    workletNode.disconnect();
    workletNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function stop() {
  teardownAudio();
  pipeline?.resetStream();
  setStatus({ state: 'idle', tabId: null, partial: null });
  log.info('Captura detenida');

  armIdleClose();
}

// ── Mensajes ────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  switch (message.type) {
    case 'start':
      start(message).then(
        () => sendResponse({ success: true, status }),
        (e) => {
          // Todo lo que puede fallar en start() es la captura de audio.
          fail(e, { recoverable: true });
          sendResponse({ success: false, error: e.message });
        }
      );
      return true;

    case 'stop':
      stop();
      sendResponse({ success: true });
      return false;

    case 'get-status':
      sendResponse(status);
      return false;

    case 'settings':
      pipeline?.updateSettings(message.settings);
      sendResponse({ success: true });
      return false;
  }
  return false;
});

log.info('Documento offscreen cargado');
