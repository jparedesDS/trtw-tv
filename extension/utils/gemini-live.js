// trtw.tv — Gemini Live API client
//
// Streams raw 16 kHz / 16-bit PCM audio over a single bidirectional WebSocket
// to the Gemini Live API and surfaces real-time subtitles:
//   • Transcription only  → display the input audio transcript verbatim.
//   • Translation         → use the dedicated live-translate model and display
//                           the translated transcript of the audio.
//
// The Live API speaks JSON over WebSocket (BidiGenerateContent). No SDK is
// required, which keeps the offscreen bundle small.
//
// Docs: https://ai.google.dev/gemini-api/docs/live-api
//       https://ai.google.dev/gemini-api/docs/live-api/live-translate

const ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

// Live model IDs. Update these as Google promotes newer Live previews to GA.
// `gemini-*-flash-live` handles plain transcription; the dedicated
// `*-live-translate` model handles real-time speech translation.
const TRANSCRIBE_MODEL = 'models/gemini-3.1-flash-live-preview';
const TRANSLATE_MODEL = 'models/gemini-3.5-live-translate-preview';

/**
 * Convert a Float32 PCM frame (range [-1, 1]) into a base64-encoded
 * little-endian 16-bit PCM string, the wire format the Live API expects.
 */
function floatTo16BitPcmBase64(float32) {
  const len = float32.length;
  const buffer = new ArrayBuffer(len * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < len; i++) {
    let s = Math.max(-1, Math.min(1, float32[i]));
    s = s < 0 ? s * 0x8000 : s * 0x7fff;
    view.setInt16(i * 2, s, true); // little-endian
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export class GeminiLiveClient {
  /**
   * @param {object} opts
   * @param {string}  opts.apiKey          Google AI Studio API key (BYO).
   * @param {boolean} opts.translate       Translate (true) vs transcribe (false).
   * @param {string}  opts.sourceLanguage  Source hint, 'auto' or a BCP-47 code.
   * @param {string}  opts.targetLanguage  Target BCP-47 code for translation.
   * @param {(text:string, isFinal:boolean)=>void} opts.onTranscript
   * @param {(error:string)=>void} [opts.onError]
   * @param {()=>void} [opts.onReady]
   */
  constructor({
    apiKey,
    translate,
    sourceLanguage,
    targetLanguage,
    onTranscript,
    onError,
    onReady,
  }) {
    this.apiKey = apiKey;
    this.translate = !!translate;
    this.sourceLanguage = sourceLanguage || 'auto';
    this.targetLanguage = targetLanguage || 'en';
    this.onTranscript = onTranscript || (() => {});
    this.onError = onError || (() => {});
    this.onReady = onReady || (() => {});

    this.ws = null;
    this.ready = false;
    this.closed = false;
    // Accumulated transcript for the current turn (subtitles grow then reset).
    this.inputBuf = '';
    this.outputBuf = '';
  }

  /** Build the initial BidiGenerateContent setup message. */
  buildSetup() {
    const setup = {
      model: this.translate ? TRANSLATE_MODEL : TRANSCRIBE_MODEL,
      generationConfig: {
        responseModalities: [this.translate ? 'AUDIO' : 'TEXT'],
      },
      inputAudioTranscription: {},
    };

    if (this.translate) {
      // Translated transcript arrives via outputAudioTranscription.
      setup.outputAudioTranscription = {};
      setup.translationConfig = {
        targetLanguageCode: this.targetLanguage,
        // Echo audio already in the target language so captions never stall.
        echoTargetLanguage: true,
      };
    } else {
      // Keep the model from chatting back — we only want the transcript.
      setup.systemInstruction = {
        parts: [
          {
            text:
              'You are a real-time speech-to-text engine for a livestream. ' +
              'Transcribe the incoming audio verbatim. Do not translate, ' +
              'summarize, answer questions, or add any commentary.',
          },
        ],
      };
    }

    return { setup };
  }

  /** Open the socket and resolve once the server confirms setup. */
  connect() {
    if (!this.apiKey) {
      return Promise.reject(
        new Error('Gemini API key is required. Add it in the extension popup.')
      );
    }

    return new Promise((resolve, reject) => {
      const url = `${ENDPOINT}?key=${encodeURIComponent(this.apiKey)}`;
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.ws.send(JSON.stringify(this.buildSetup()));
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event, resolve);
      };

      this.ws.onerror = () => {
        this.onError('Gemini Live connection error.');
        if (!this.ready) reject(new Error('Gemini Live connection error.'));
      };

      this.ws.onclose = (event) => {
        if (!this.ready && !this.closed) {
          const reason = event.reason || `closed (code ${event.code})`;
          this.onError(`Gemini Live ${reason}.`);
          reject(new Error(`Gemini Live ${reason}.`));
        }
      };
    });
  }

  async handleMessage(event, resolveReady) {
    let raw = event.data;
    if (raw instanceof Blob) {
      raw = await raw.text();
    } else if (raw instanceof ArrayBuffer) {
      raw = new TextDecoder().decode(raw);
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.setupComplete) {
      this.ready = true;
      this.onReady();
      resolveReady?.();
      return;
    }

    const sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription?.text) {
      this.inputBuf += sc.inputTranscription.text;
      if (!this.translate) this.onTranscript(this.inputBuf.trim(), false);
    }

    if (sc.outputTranscription?.text) {
      this.outputBuf += sc.outputTranscription.text;
      if (this.translate) this.onTranscript(this.outputBuf.trim(), false);
    }

    // End of an utterance — emit the final caption and reset the buffers.
    if (sc.turnComplete || sc.generationComplete) {
      const finalText = (this.translate ? this.outputBuf : this.inputBuf).trim();
      if (finalText) this.onTranscript(finalText, true);
      this.inputBuf = '';
      this.outputBuf = '';
    }
  }

  /** Stream a Float32 PCM frame (already resampled to 16 kHz mono). */
  sendAudio(float32) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          audio: {
            data: floatTo16BitPcmBase64(float32),
            mimeType: 'audio/pcm;rate=16000',
          },
        },
      })
    );
  }

  close() {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
  }
}
