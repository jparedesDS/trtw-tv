# trtw.tv — subtítulos en español en directo para Twitch y YouTube

Extensión de Chrome (Manifest V3) que escucha el audio de la pestaña, transcribe
el inglés con **Whisper** y muestra **subtítulos en español** sobre el
reproductor, con 1,5–3 s de retraso.

- **100 % gratis y local**: sin APIs de pago, sin claves y sin servidor. Lo único
  que se descarga de Internet son los modelos (de Hugging Face, solo la primera vez).
- **No necesita una gráfica NVIDIA**: usa **WebGPU** (vale la gráfica integrada
  Intel/AMD/Apple) y, si no hay, **WASM** (CPU, multihilo).
- **Frases completas y sin texto inventado** antes que velocidad: detector de voz
  Silero VAD, confirmación por *local agreement* y filtro anti-alucinaciones.

## Requisitos

| | |
|---|---|
| Navegador | **Chrome 138 o superior** (por la Translator API integrada). |
| Para compilar | **Node.js 22 LTS** (mínimo 21: `npm test` usa patrones glob de `node --test`) y npm. |
| Hardware | Cualquier equipo reciente. Con WebGPU va holgado; en CPU usa `tiny.en` o `base.en`. |

## Instalación

```bash
git clone <este repo>
cd trtw-tv
npm install        # instala dependencias y compila automáticamente
npm run build      # (vuelve a compilar si cambias el código)
```

1. Abre `chrome://extensions`.
2. Activa **Modo de desarrollador** (arriba a la derecha).
3. Pulsa **Cargar descomprimida** y elige la carpeta **`extension/`** del repo.

> `npm run build` genera `extension/dist/` (código empaquetado con esbuild) y
> copia los ficheros WASM de onnxruntime a `extension/vendor/ort/`. Sin ese paso
> la extensión no puede arrancar; el popup te avisará con
> *"Falta compilar la extensión"*.

## Uso

1. Abre un directo de Twitch (o un vídeo de YouTube).
2. Pulsa el icono de trtw.tv y después **Start** (o usa **Alt+S**).
3. La primera vez se descarga el modelo de voz (verás el progreso en el popup y
   sobre el vídeo). Las siguientes veces se carga de la caché en unos segundos.
4. Los subtítulos aparecen sobre el vídeo. **Stop** (o Alt+S) para parar.

El popup muestra el **backend** en uso (WebGPU / WASM), el **motor de
traducción** y la **latencia media** real (desde que llega el audio hasta que
se pinta el subtítulo).

### Modelos de voz (solo inglés)

| Modelo | Descarga aprox. | Cuándo usarlo |
|---|---|---|
| `whisper-tiny.en` | ~50 MB | Equipos modestos o solo CPU. |
| `whisper-base.en` | ~130 MB | **Por defecto.** Buen equilibrio. |
| `whisper-small.en` | ~450 MB | Más preciso; mejor con WebGPU. |

Los cambios de modelo o backend se aplican al pulsar Start.

### Traducción

1. **Chrome integrado** (Translator API, en el propio equipo). Chrome descarga su
   modelo inglés→español una sola vez; para eso necesita un clic, así que se
   inicia al pulsar Start en el popup. Si arrancas con **Alt+S** sin haber
   usado nunca el popup, la descarga empieza con tu siguiente clic (o tecla) en
   la página de Twitch/YouTube.
2. **Opus-MT** (`Xenova/opus-mt-en-es`, ~75 MB, también local, en su propio
   hilo para no frenar a Whisper): respaldo automático si la API de Chrome no
   está disponible. Si más tarde la de Chrome pasa a estar lista, la extensión
   cambia sola a ella.

El traductor nunca retrasa el arranque: si aún se está descargando, los
primeros subtítulos salen en inglés y pasan a español en cuanto esté listo.

Opciones:

- **Contexto**: se traduce junto a la frase anterior para mejorar la concordancia.
- **Glosario**: términos que no se traducen (gg, clutch, nerf, nombres propios,
  emotes…), uno por línea. `término = traducción` fuerza una traducción concreta.
- **Bilingüe**: muestra el inglés original debajo del español.
- **Texto provisional**: la hipótesis aún no confirmada, en gris.

## Página de test (sin directo)

Popup → **Página de test** (o `chrome-extension://<id>/test/test.html`).

1. Elige un `.wav`/`.mp3` o pulsa **Usar ejemplo** (fragmento del discurso de
   J. F. Kennedy, dominio público).
2. **Cargar modelos**.
3. **Tiempo real**: reproduce el audio y lo pasa por el mismo AudioWorklet que
   la captura de la pestaña (mide la latencia real).
   **Rápido**: procesa sin reproducir, como si el equipo fuera infinitamente
   rápido (resultado reproducible).
4. Verás los subtítulos en un reproductor simulado, una tabla con cada frase
   (inglés, español, latencia, `avg_logprob`, `no_speech`), lo que el filtro
   descartó y por qué, y el registro.

**Analizar solo VAD** dibuja la probabilidad de voz sin descargar ningún modelo.

## Cómo comprobar WebGPU

- Abre `chrome://gpu` y busca **WebGPU: Hardware accelerated**.
- El popup muestra *Backend: WebGPU · <gráfica>* cuando se usa. Si pone *WASM*,
  pasa el ratón por encima para ver el motivo.
- En Linux puede hacer falta activar `chrome://flags/#enable-unsafe-webgpu` y
  `chrome://flags/#enable-vulkan`.
- Si WebGPU da problemas en tu gráfica, elige **Backend: WASM** en el popup.

## Resolución de problemas

| Síntoma | Qué hacer |
|---|---|
| *"Falta compilar la extensión"* | `npm install && npm run build` y recarga la extensión en `chrome://extensions`. |
| *"Chrome no permite capturar esta pestaña"* | Abre el popup **desde la pestaña** de Twitch/YouTube y pulsa Start (Chrome exige ese gesto). |
| *"No se pudo descargar … de Hugging Face"* | Hace falta conexión la primera vez. Revisa bloqueadores o proxies para `huggingface.co`. |
| Se queda en error | Pulsa **Reintentar**. Si solo falló la captura de audio, se reintenta conservando los modelos ya cargados; si falló el propio pipeline, se reinicia desde cero. |
| Los subtítulos salen en inglés | No hay traductor disponible. Mira el motor en el popup; prueba **Opus-MT**. El estado del modelo de Chrome está en `chrome://on-device-translation-internals`. |
| Mucho retraso | Usa WebGPU o un modelo más pequeño (`tiny.en`). En la página de test, un RTF > 0,5 indica que el equipo va justo. |
| Texto inventado con música | El filtro descarta lo típico; lo que se cuele aparece en la página de test con el motivo. |
| No oigo el stream tras Start | La captura silencia la pestaña y la extensión reproduce el audio; comprueba el volumen del sistema o haz Stop/Start. |

**Logs**: `chrome://extensions` → trtw.tv → *Inspeccionar vistas*
(`offscreen/offscreen.html` o *service worker*) y filtra por `[trtw.tv]`.

**Borrar modelos descargados**: DevTools del documento offscreen → *Application*
→ *Cache Storage* → `transformers-cache`.

## Publicar en la Chrome Web Store

Todo lo necesario está preparado en el repo:

| Qué | Dónde |
|---|---|
| Paquete `.zip` (funciona en Windows, sin `zip`) | `npm run package` → `trtw-tv-<versión>.zip` |
| Textos de la ficha (ES/EN), justificación de permisos, respuestas de privacidad e instrucciones para el revisor | [`store/LISTING.md`](store/LISTING.md) |
| Política de privacidad | [`PRIVACY.md`](PRIVACY.md) |
| Capturas 1280×800 y mosaico 440×280 | [`store/images/`](store/images/) (se regeneran con `node store/render.mjs`) |

Pasos:

1. **Pruébala de verdad** antes de publicar: página de test con el ejemplo de
   JFK y un directo de Twitch en inglés.
2. Sube `version` en `extension/manifest.json` (la tienda no acepta repetirla).
3. `npm run package`: compila, comprueba que no falte nada y crea el zip.
4. Crea la cuenta en <https://chrome.google.com/webstore/devconsole> (pago
   único de registro y verificación en dos pasos).
5. *Añadir elemento* → sube el zip y rellena cada pestaña copiando de
   [`store/LISTING.md`](store/LISTING.md).
6. La política de privacidad tiene que ser accesible: haz público el repo (o
   publica `PRIVACY.md` en GitHub Pages) y pon su URL.
7. Empieza con visibilidad **No listada**, compártela con algunos usuarios y,
   cuando esté probada, pásala a **Pública**.

Las capturas actuales son una maqueta hecha con el CSS y el renderer reales del
overlay. Cuando la tengas funcionando en Twitch, conviene sustituirlas por
capturas reales (1280×800).

## Cómo funciona

```
popup ─▶ service worker ─▶ documento offscreen
                              ├─ tabCapture → AudioContext (se sigue oyendo a calidad completa)
                              ├─ AudioWorklet: mono + remuestreo con filtro a 16 kHz, tramas de 32 ms
                              ├─ Silero VAD (ONNX local) → locuciones de voz
                              ├─ Streamer: hipótesis cada ~1 s, local agreement, corte por silencio o a los 9 s
                              ├─ Filtro anti-alucinaciones
                              ├─ Traducción (Chrome / relé a la pestaña / Opus-MT) + glosario + contexto
                              └─ Workers: Whisper (transformers.js, WebGPU o WASM) y, si hace falta, Opus-MT en otro
content script (Twitch/YouTube) ◀── subtítulos ── service worker
```

- El **documento offscreen** es la fuente de verdad del estado; el service worker
  (que Chrome duerme cuando quiere) lo consulta cada vez, así que nunca se queda
  "atascado" en un estado viejo. Desde error, Start reinicia todo.
- Los errores puntuales de transcripción o traducción no paran la sesión; solo
  5 fallos seguidos de Whisper se consideran fatales.
- Las únicas peticiones de red son las descargas de modelos desde
  `huggingface.co` (se guardan en la Cache API). El WASM de onnxruntime y el
  modelo del VAD van dentro de la extensión.

Plan y reparto de ficheros: [`docs/PLAN-v2.md`](docs/PLAN-v2.md).

## Desarrollo

```bash
npm run watch   # recompila al guardar
npm test        # tests unitarios (Node): remuestreo, VAD, streamer, filtro, glosario, traducción
npm run package # compila y genera trtw-tv-<versión>.zip para la Chrome Web Store
```

Después de recompilar, pulsa ↻ en `chrome://extensions`.

## Licencias de terceros

- Silero VAD (MIT) — `extension/models/silero/`.
- transformers.js y onnxruntime-web (Apache-2.0).
- Modelos Whisper (MIT) y Opus-MT (CC-BY 4.0), descargados de Hugging Face.
- Audio de ejemplo: discurso inaugural de J. F. Kennedy (1961), dominio público.
