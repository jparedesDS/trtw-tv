# trtw.tv — Live Subtitles

Real-time automatic subtitles for **Twitch** and **YouTube** live streams,
rendered as a clean overlay on top of the player.

Two transcription engines:

| Engine | Where it runs | Latency | Cost | Notes |
| --- | --- | --- | --- | --- |
| **Whisper** | Locally in your browser (WebGPU/WASM via `transformers.js`) | ~3s windows | Free, fully offline | Downloads the model once (Tiny → Small). |
| **Gemini Live** | Google Gemini Live API (streaming WebSocket) | Sub-second | Requires your own API key | Real-time transcription **and** translation. |

## How it works

```
Tab audio → AudioWorklet (16 kHz mono PCM)
          → ┌ Whisper pipeline  → text → overlay
            └ Gemini Live socket → text → overlay
```

- The service worker captures the active tab's audio (`tabCapture`) and drives
  an **offscreen document** (`extension/offscreen/`), which owns the audio
  pipeline.
- An `AudioWorklet` (`extension/utils/audio-processor.js`) accumulates PCM
  frames: ~3 s windows for Whisper, ~0.25 s for the continuous Gemini stream.
- The chosen engine produces text, which the content script
  (`extension/content/overlay.js`) renders over the video player.

## Engines

### Whisper (local, offline)
Uses [`@huggingface/transformers`](https://github.com/huggingface/transformers.js)
to run Whisper entirely in the browser. Translation to a non-English target
falls back to the free MyMemory API (or OpenAI if a key is provided).

### Gemini Live (cloud, low-latency)
Streams raw 16-bit/16 kHz PCM over a single WebSocket to the
[Gemini Live API](https://ai.google.dev/gemini-api/docs/live-api).

- **Transcribe** (Translate toggle **off**): `gemini-*-flash-live` with
  `inputAudioTranscription` → the original-language transcript.
- **Translate** (Translate toggle **on**): the dedicated
  `*-live-translate` model with `translationConfig.targetLanguageCode` →
  the translated transcript via `outputAudioTranscription`.

The client lives in `extension/utils/gemini-live.js`. The model IDs are
defined at the top of that file — bump them as Google promotes newer Live
previews to GA.

#### Getting a Gemini API key
1. Open [Google AI Studio](https://aistudio.google.com/apikey) and create an
   API key.
2. In the extension popup, set **Engine → Gemini Live** and paste the key into
   **Gemini API Key**. It is stored in `chrome.storage.sync` and never leaves
   your browser except to call Google's API directly.

## Development

```bash
npm install
npm run build      # bundle the offscreen document (esbuild)
npm run watch      # rebuild on change
npm run package    # zip the extension for distribution
```

Load `extension/` as an unpacked extension at `chrome://extensions`
(Developer mode → Load unpacked). Requires Chrome 121+.

## Usage
- Click the toolbar icon (or press **Alt+S**) on a Twitch/YouTube tab to toggle
  subtitles.
- Pick the engine, source/target language, and tweak the overlay appearance
  from the popup.
