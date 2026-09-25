# trtw.tv v2 — plan de ficheros y cambios

Objetivo: subtítulos en español, en directo, para Twitch/YouTube. Todo gratis
y local (transformers.js + onnxruntime-web + Chrome Translator API), con
WebGPU cuando la hay y WASM como respaldo.

## Arquitectura

```
popup ──(start/stop/get-state)──▶ service-worker ──▶ offscreen document
                                      ▲   │                │  tabCapture → AudioContext
                                      │   │                │  AudioWorklet (mono + 16 kHz, tramas de 512)
                                      │   │                │  Silero VAD (ORT wasm, 1 hilo)
                                      │   │                │  Streamer (segmentación + local agreement)
                                      │   │                │  Filtro anti-alucinaciones
                                      │   │                │  Traducción (Chrome Translator / pestaña / Opus-MT)
                                      │   │                └─▶ Worker ASR (transformers.js Whisper .en + Opus-MT)
                                      │   └──(subtitle/status)──▶ content script (overlay)
                                      └──(status, progreso)── offscreen
```

- La **fuente de verdad del estado** es el documento offscreen. El service
  worker (que MV3 puede dormir en cualquier momento) no guarda estado propio:
  consulta `chrome.runtime.getContexts` + `get-status` al offscreen.
- El offscreen solo tiene acceso a `chrome.runtime`, así que **los ajustes se
  los pasa el service worker** en cada `start` y cuando cambian.
- Whisper corre en un **Worker** propio (su propia instancia de ORT), así la
  inferencia no bloquea la captura ni el VAD, y no se mezclan ejecuciones
  concurrentes de ORT (el backend WASM/JSEP no las admite).

## Ficheros

| Fichero | Cambio |
|---|---|
| `package.json` | scripts `build`/`watch`/`test`/`package`; `prepare` compila tras `npm install`. |
| `scripts/build.mjs` | **nuevo**. esbuild (offscreen, worker ASR, content script, test) + copia de `ort-wasm-simd-threaded.jsep.{mjs,wasm}` a `extension/vendor/ort/`. |
| `extension/manifest.json` | Chrome 138+, content script compilado, sin fuentes externas. Sin COOP/COEP: el aislamiento impide consumir el streamId de tabCapture en el offscreen. |
| `extension/service-worker.js` | Reescrito: sin estado en memoria, cola de operaciones, reset desde error, relé de mensajes, badge. |
| `extension/offscreen/offscreen.{html,js}` | Reescrito: captura + `Pipeline`, estado y errores no fatales. |
| `extension/audio/capture-worklet.js` | **nuevo** (sustituye `utils/audio-processor.js`): downmix + remuestreo con filtro paso bajo a 16 kHz, tramas de 512. |
| `extension/lib/resampler.js` | **nuevo**. Remuestreador en streaming (FIR windowed-sinc + interpolación). |
| `extension/lib/vad.js` | **nuevo**. Silero VAD v5 (`extension/models/silero/`, incluido en el repo, 2,3 MB). |
| `extension/lib/streamer.js` | **nuevo**. Segmentación por voz, ventana deslizante, local agreement, corte por silencio o a los ~9 s. |
| `extension/lib/whisper-tokens.js` | **nuevo**. Tokens → segmentos con timestamps, avg_logprob por segmento. |
| `extension/lib/hallucination-filter.js` | **nuevo**. Limpieza, frases típicas, repeticiones, no_speech/avg_logprob, ratio de voz. |
| `extension/lib/glossary.js` | **nuevo**. Parseo del glosario y protección con marcadores. |
| `extension/lib/translator.js` | **nuevo**. Motores: Chrome Translator, relé a la pestaña, Opus-MT. Contexto y caché. |
| `extension/lib/chrome-translator.js` | **nuevo**. Envoltorio de la Translator API con timeouts (sin gesto del usuario, `create()` puede colgarse). |
| `extension/lib/async.js` | **nuevo**. `withTimeout` compartido. |
| `extension/lib/inference-client.js` | **nuevo**. Cliente con promesas para los workers (uno para Whisper y otro para Opus-MT). |
| `extension/lib/pipeline.js` | **nuevo**. Une VAD + Streamer + ASR + traducción; lo usan offscreen y la página de test. |
| `extension/lib/settings.js`, `log.js` | **nuevos**. Ajustes por defecto y logs con prefijo `[trtw.tv]`. |
| `extension/workers/asr-worker.js` | **nuevo**. Whisper (`onnx-community/whisper-*.en`) con WebGPU/WASM + Opus-MT. |
| `extension/lib/subtitle-renderer.js` | **nuevo**. Pintado sin parpadeos, máximo 2 líneas, modo bilingüe, parcial en gris. |
| `extension/content/overlay.{js,css}` | Reescrito: usa el renderer, pantalla completa/modo teatro, relé de traducción. |
| `extension/popup/*` | Reescrito en español: modelo, backend, motor, glosario, bilingüe; sin OpenAI. |
| `extension/test/test.{html,js,css}` | **nuevo**. Página de test con audio local. |
| `extension/test/samples/jfk.mp3`, `test/fixtures/jfk.wav` | Ejemplo de dominio público (discurso de J. F. Kennedy, 1961), el mismo que usa whisper.cpp. |
| `extension/utils/*` | **eliminado** (OpenAI, MyMemory, trozos fijos de 3 s). |
| `test/*.test.mjs` | **nuevos**. Tests unitarios con `node --test`. |
| `README.md` | **nuevo**, en español. |

## Fases (un commit por fase)

1. **Base**: build con esbuild, WASM local, manifest, máquina de estados
   robusta, logs `[trtw.tv]`, fuera OpenAI.
2. **ASR**: worker con Whisper `.en` (tiny/base/small), WebGPU → WASM, backend
   visible en el popup.
3. **VAD + streaming**: Silero VAD, remuestreo correcto, local agreement,
   corte por silencio / máximo.
4. **Anti-alucinaciones**.
5. **Traducción local**: Chrome Translator (offscreen → pestaña) + Opus-MT,
   glosario y contexto.
6. **Overlay**: 2 líneas, bilingüe, pantalla completa, Alt+S.
7. **Página de test, tests y README**.
