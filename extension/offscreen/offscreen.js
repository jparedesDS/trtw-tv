// trtw.tv Offscreen Document
// Captures tab audio, processes via AudioWorklet, transcribes with Whisper

import { pipeline } from '@huggingface/transformers';
import { translateText, translateWithOpenAI } from '../utils/translation.js';

let audioContext = null;
let mediaStream = null;
let workletNode = null;
let transcriber = null;
let isTranscribing = false;
let pendingChunk = null;

const WHISPER_SAMPLE_RATE = 16000;
const VAD_THRESHOLD = 0.008;

// ── Settings ────────────────────────────────────────────────────

async function getSettings() {
  const defaults = {
    modelId: 'onnx-community/whisper-tiny',
    sourceLanguage: 'auto',
    task: 'transcribe',
    targetLanguage: 'en',
    useCloudApi: false,
    cloudApiKey: ''
  };

  try {
    const stored = await chrome.storage.sync.get(defaults);
    return { ...defaults, ...stored };
  } catch {
    return defaults;
  }
}

// ── Whisper Pipeline ────────────────────────────────────────────

async function initWhisper() {
  if (transcriber) return transcriber;

  const settings = await getSettings();

  chrome.runtime.sendMessage({
    type: 'model-progress',
    status: 'loading',
    modelId: settings.modelId
  });

  const device = navigator.gpu ? 'webgpu' : 'wasm';
  console.log(`[trtw.tv] Initializing Whisper on ${device}:`, settings.modelId);

  transcriber = await pipeline(
    'automatic-speech-recognition',
    settings.modelId,
    {
      device,
      progress_callback: (progress) => {
        chrome.runtime.sendMessage({
          type: 'model-progress',
          ...progress
        });
      }
    }
  );

  chrome.runtime.sendMessage({
    type: 'model-progress',
    status: 'ready'
  });

  console.log('[trtw.tv] Whisper pipeline ready');
  return transcriber;
}

// ── Voice Activity Detection ────────────────────────────────────

function hasVoiceActivity(audioData) {
  let sum = 0;
  for (let i = 0; i < audioData.length; i++) {
    sum += audioData[i] * audioData[i];
  }
  const rms = Math.sqrt(sum / audioData.length);
  return rms > VAD_THRESHOLD;
}

// ── Transcription ───────────────────────────────────────────────

async function transcribeChunk(audioData) {
  if (isTranscribing) {
    // Keep only the latest pending chunk (drop older ones)
    pendingChunk = audioData;
    return;
  }

  if (!hasVoiceActivity(audioData)) {
    return;
  }

  isTranscribing = true;

  try {
    const whisper = await initWhisper();
    const settings = await getSettings();

    const options = {
      language: settings.sourceLanguage === 'auto' ? null : settings.sourceLanguage,
      task: settings.task
    };

    const result = await whisper(audioData, options);

    if (result && result.text && result.text.trim()) {
      let finalText = result.text.trim();

      // Secondary translation: if task is 'translate' (→ English) but target
      // language is not English, translate the English output to target language
      const targetLang = settings.targetLanguage || 'en';
      if (settings.task === 'translate' && targetLang !== 'en') {
        if (settings.useCloudApi && settings.cloudApiKey) {
          finalText = await translateWithOpenAI(finalText, targetLang, settings.cloudApiKey);
        } else {
          finalText = await translateText(finalText, 'en', targetLang);
        }
      }

      chrome.runtime.sendMessage({
        type: 'transcription',
        text: finalText,
        language: settings.sourceLanguage,
        timestamp: Date.now()
      });
    }
  } catch (error) {
    console.error('[trtw.tv] Transcription error:', error);
    chrome.runtime.sendMessage({
      type: 'capture-error',
      error: error.message
    });
  } finally {
    isTranscribing = false;

    // Process pending chunk if any
    if (pendingChunk) {
      const chunk = pendingChunk;
      pendingChunk = null;
      transcribeChunk(chunk);
    }
  }
}

// ── Audio Capture ───────────────────────────────────────────────

async function startCapture(streamId) {
  try {
    // Get MediaStream from tab
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });

    // Create AudioContext at Whisper's expected sample rate
    // The browser handles resampling automatically
    let contextOptions = { sampleRate: WHISPER_SAMPLE_RATE };

    try {
      audioContext = new AudioContext(contextOptions);
    } catch {
      // Fallback: use default sample rate, will need manual resampling
      console.warn('[trtw.tv] Could not create AudioContext at 16kHz, using default');
      audioContext = new AudioContext();
    }

    // Load the AudioWorklet processor
    const processorUrl = chrome.runtime.getURL('utils/audio-processor.js');
    await audioContext.audioWorklet.addModule(processorUrl);

    // Create source from MediaStream
    const source = audioContext.createMediaStreamSource(mediaStream);

    // Create AudioWorklet node
    workletNode = new AudioWorkletNode(audioContext, 'audio-chunk-processor', {
      processorOptions: {
        chunkDurationSec: 3
      }
    });

    // Listen for audio chunks from the worklet
    workletNode.port.onmessage = (event) => {
      if (event.data.type === 'audio-chunk') {
        let audioData = event.data.buffer;

        // If AudioContext is not at 16kHz, we need to resample
        if (audioContext.sampleRate !== WHISPER_SAMPLE_RATE) {
          audioData = resample(audioData, audioContext.sampleRate, WHISPER_SAMPLE_RATE);
        }

        transcribeChunk(audioData);
      }
    };

    // Connect: source → worklet (for chunk processing, worklet outputs silence)
    source.connect(workletNode);

    // Connect source directly to output so user continues hearing audio
    source.connect(audioContext.destination);

    console.log('[trtw.tv] Audio capture started');

    // Start loading the model in parallel
    initWhisper().catch(console.error);

  } catch (error) {
    console.error('[trtw.tv] Failed to start capture:', error);
    chrome.runtime.sendMessage({
      type: 'capture-error',
      error: error.message
    });
  }
}

function stopCapture() {
  if (workletNode) {
    workletNode.port.postMessage({ type: 'stop' });
    workletNode.disconnect();
    workletNode = null;
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }

  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }

  pendingChunk = null;
  console.log('[trtw.tv] Audio capture stopped');
}

// ── Resampling (fallback) ───────────────────────────────────────

function resample(audioData, fromRate, toRate) {
  const ratio = fromRate / toRate;
  const newLength = Math.floor(audioData.length / ratio);
  const result = new Float32Array(newLength);

  for (let i = 0; i < newLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const srcCeil = Math.min(srcFloor + 1, audioData.length - 1);
    const frac = srcIndex - srcFloor;
    result[i] = audioData[srcFloor] * (1 - frac) + audioData[srcCeil] * frac;
  }

  return result;
}

// ── Message Listener ────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  switch (message.type) {
    case 'start-audio-capture':
      startCapture(message.data.streamId)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // Keep message channel open for async response

    case 'stop-audio-capture':
      stopCapture();
      sendResponse({ success: true });
      break;
  }
});

console.log('[trtw.tv] Offscreen document loaded');
