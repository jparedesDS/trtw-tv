// trtw.tv Popup — Settings UI controller

const DEFAULT_SETTINGS = {
  engine: 'whisper',
  modelId: 'onnx-community/whisper-tiny',
  sourceLanguage: 'auto',
  task: 'transcribe',
  translateToEnglish: false,
  targetLanguage: 'es',
  fontSize: 20,
  textColor: '#FFFFFF',
  bgOpacity: 0.78,
  subtitlePosition: 'bottom',
  useCloudApi: false,
  cloudApiKey: '',
  geminiApiKey: ''
};

let settings = { ...DEFAULT_SETTINGS };
let isCapturing = false;
let debounceTimer = null;

// ── DOM Elements ────────────────────────────────────────────

const els = {};

function initElements() {
  els.mainToggle = document.getElementById('main-toggle');
  els.toggleLabel = document.getElementById('toggle-label');
  els.statusBadge = document.getElementById('status-badge');
  els.statusText = document.getElementById('status-text');
  els.progressSection = document.getElementById('progress-section');
  els.progressLabel = document.getElementById('progress-label');
  els.progressPercent = document.getElementById('progress-percent');
  els.progressFill = document.getElementById('progress-fill');
  els.engineSelect = document.getElementById('engine-select');
  els.modelGroup = document.getElementById('model-group');
  els.modelSelect = document.getElementById('model-select');
  els.geminiKeyGroup = document.getElementById('gemini-key-group');
  els.geminiKey = document.getElementById('gemini-key');
  els.sourceLang = document.getElementById('source-lang');
  els.translateToggle = document.getElementById('translate-toggle');
  els.targetLangGroup = document.getElementById('target-lang-group');
  els.targetLang = document.getElementById('target-lang');
  els.fontSize = document.getElementById('font-size');
  els.fontSizeValue = document.getElementById('font-size-value');
  els.bgOpacity = document.getElementById('bg-opacity');
  els.bgOpacityValue = document.getElementById('bg-opacity-value');
  els.colorOptions = document.getElementById('color-options');
  els.positionSelect = document.getElementById('position-select');
  els.cloudToggle = document.getElementById('cloud-toggle');
  els.apiKeyGroup = document.getElementById('api-key-group');
  els.apiKey = document.getElementById('api-key');
}

// ── Settings Load/Save ──────────────────────────────────────

async function loadSettings() {
  try {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = { ...DEFAULT_SETTINGS, ...stored };
  } catch {
    settings = { ...DEFAULT_SETTINGS };
  }

  // Apply to UI
  els.engineSelect.value = settings.engine;
  els.modelSelect.value = settings.modelId;
  els.geminiKey.value = settings.geminiApiKey;
  els.sourceLang.value = settings.sourceLanguage;
  els.translateToggle.checked = settings.translateToEnglish;
  els.targetLang.value = settings.targetLanguage;
  els.targetLangGroup.classList.toggle('hidden', !settings.translateToEnglish);
  els.fontSize.value = settings.fontSize;
  els.fontSizeValue.textContent = settings.fontSize + 'px';
  els.bgOpacity.value = Math.round(settings.bgOpacity * 100);
  els.bgOpacityValue.textContent = Math.round(settings.bgOpacity * 100) + '%';
  els.positionSelect.value = settings.subtitlePosition;
  els.cloudToggle.checked = settings.useCloudApi;
  els.apiKey.value = settings.cloudApiKey;

  // Color buttons
  els.colorOptions.querySelectorAll('.color-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === settings.textColor);
  });

  // API key visibility
  els.apiKeyGroup.classList.toggle('hidden', !settings.useCloudApi);

  // Engine-dependent visibility
  updateEngineUI();
}

// Show the Whisper model picker for the local engine, or the Gemini API key
// field for the cloud engine.
function updateEngineUI() {
  const isGemini = settings.engine === 'gemini';
  els.modelGroup.classList.toggle('hidden', isGemini);
  els.geminiKeyGroup.classList.toggle('hidden', !isGemini);
}

function saveSettings() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(async () => {
    try {
      await chrome.storage.sync.set(settings);
    } catch (e) {
      console.error('[trtw.tv] Failed to save settings:', e);
    }
  }, 300);
}

// ── State Management ────────────────────────────────────────

async function queryState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get-state' });
    if (response) {
      updateUI(response.state);
    }
  } catch {
    updateUI('idle');
  }
}

function updateUI(state) {
  const states = {
    idle: { badge: 'status-idle', text: 'Idle', label: 'Start Subtitles', active: false },
    starting: { badge: 'status-loading', text: 'Starting...', label: 'Starting...', active: false },
    capturing: { badge: 'status-capturing', text: 'Capturing', label: 'Stop Subtitles', active: true },
    stopping: { badge: 'status-loading', text: 'Stopping...', label: 'Stopping...', active: false },
    error: { badge: 'status-error', text: 'Error', label: 'Retry', active: false }
  };

  const s = states[state] || states.idle;
  isCapturing = s.active;

  els.statusBadge.className = 'status-badge ' + s.badge;
  els.statusText.textContent = s.text;
  els.toggleLabel.textContent = s.label;
  els.mainToggle.classList.toggle('active', s.active);
}

// ── Event Handlers ──────────────────────────────────────────

function setupListeners() {
  // Main toggle
  els.mainToggle.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    if (isCapturing) {
      updateUI('stopping');
      const result = await chrome.runtime.sendMessage({ type: 'stop-capture' });
      updateUI(result.success ? 'idle' : 'error');
    } else {
      updateUI('starting');
      const result = await chrome.runtime.sendMessage({
        type: 'start-capture',
        tabId: tab.id
      });
      updateUI(result.success ? 'capturing' : 'error');
    }
  });

  // Engine selection
  els.engineSelect.addEventListener('change', () => {
    settings.engine = els.engineSelect.value;
    updateEngineUI();
    saveSettings();
  });

  // Model selection
  els.modelSelect.addEventListener('change', () => {
    settings.modelId = els.modelSelect.value;
    saveSettings();
  });

  // Gemini API key input
  els.geminiKey.addEventListener('input', () => {
    settings.geminiApiKey = els.geminiKey.value;
    saveSettings();
  });

  // Source language
  els.sourceLang.addEventListener('change', () => {
    settings.sourceLanguage = els.sourceLang.value;
    saveSettings();
  });

  // Translate toggle
  els.translateToggle.addEventListener('change', () => {
    settings.translateToEnglish = els.translateToggle.checked;
    settings.task = settings.translateToEnglish ? 'translate' : 'transcribe';
    els.targetLangGroup.classList.toggle('hidden', !settings.translateToEnglish);
    saveSettings();
  });

  // Target language
  els.targetLang.addEventListener('change', () => {
    settings.targetLanguage = els.targetLang.value;
    saveSettings();
  });

  // Font size slider
  els.fontSize.addEventListener('input', () => {
    settings.fontSize = parseInt(els.fontSize.value, 10);
    els.fontSizeValue.textContent = settings.fontSize + 'px';
    saveSettings();
  });

  // Background opacity slider
  els.bgOpacity.addEventListener('input', () => {
    const val = parseInt(els.bgOpacity.value, 10);
    settings.bgOpacity = val / 100;
    els.bgOpacityValue.textContent = val + '%';
    saveSettings();
  });

  // Color buttons
  els.colorOptions.addEventListener('click', (e) => {
    const btn = e.target.closest('.color-btn');
    if (!btn) return;

    els.colorOptions.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    settings.textColor = btn.dataset.color;
    saveSettings();
  });

  // Position select
  els.positionSelect.addEventListener('change', () => {
    settings.subtitlePosition = els.positionSelect.value;
    saveSettings();
  });

  // Cloud API toggle
  els.cloudToggle.addEventListener('change', () => {
    settings.useCloudApi = els.cloudToggle.checked;
    els.apiKeyGroup.classList.toggle('hidden', !settings.useCloudApi);
    saveSettings();
  });

  // API key input
  els.apiKey.addEventListener('input', () => {
    settings.cloudApiKey = els.apiKey.value;
    saveSettings();
  });
}

// ── Model Progress Listener ─────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'model-progress') return;

  if (message.status === 'loading') {
    els.progressSection.classList.remove('hidden');
    els.progressLabel.textContent = message.modelId === 'Gemini Live'
      ? 'Connecting to Gemini Live...'
      : 'Loading model...';
    els.progressPercent.textContent = '';
    els.progressFill.style.width = '0%';
  } else if (message.status === 'ready') {
    els.progressSection.classList.add('hidden');
  } else if (message.progress !== undefined) {
    els.progressSection.classList.remove('hidden');
    const percent = Math.round(message.progress);
    els.progressLabel.textContent = message.file
      ? `Downloading ${message.file.split('/').pop()}...`
      : 'Downloading model...';
    els.progressPercent.textContent = percent + '%';
    els.progressFill.style.width = percent + '%';
  }
});

// ── Init ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initElements();
  await loadSettings();
  setupListeners();
  await queryState();
});
