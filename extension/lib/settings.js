// Ajustes compartidos (popup, service worker, content script y página de test).
// Se guardan en chrome.storage.local: el glosario puede superar el límite
// por elemento de storage.sync.

export const MODELS = [
  { id: 'onnx-community/whisper-tiny.en', label: 'Tiny.en (~50 MB, equipos modestos)' },
  { id: 'onnx-community/whisper-base.en', label: 'Base.en (~130 MB, recomendado)' },
  { id: 'onnx-community/whisper-small.en', label: 'Small.en (~450 MB, más preciso)' }
];

export const DEFAULT_GLOSSARY = [
  'gg', 'ggs', 'clutch', 'nerf', 'buff', 'OP', 'noob', 'lol', 'lmao',
  'Pog', 'PogChamp', 'KEKW', 'LUL', 'Kappa', 'OMEGALUL', 'monkaS', 'Sadge',
  'Twitch', 'streamer', 'stream', 'raid', 'sub', 'subs', 'emote', 'emotes'
].join('\n');

export const DEFAULT_SETTINGS = {
  // Reconocimiento de voz
  modelId: 'onnx-community/whisper-base.en',
  device: 'auto',               // 'auto' | 'webgpu' | 'wasm'

  // Traducción
  translationEngine: 'auto',    // 'auto' | 'chrome' | 'opus'
  translateWithContext: true,
  glossary: DEFAULT_GLOSSARY,

  // Overlay
  bilingual: false,             // muestra el inglés original debajo
  showPartial: true,            // hipótesis parcial en gris
  fontSize: 26,
  textColor: '#FFFFFF',
  bgOpacity: 0.7,
  subtitlePosition: 'bottom'    // 'bottom' | 'top'
};

// Claves que afectan al pipeline del offscreen (el resto es solo visual).
export const PIPELINE_KEYS = [
  'modelId', 'device', 'translationEngine', 'translateWithContext', 'glossary', 'showPartial'
];

export async function loadSettings() {
  try {
    const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(partial) {
  await chrome.storage.local.set(partial);
}
