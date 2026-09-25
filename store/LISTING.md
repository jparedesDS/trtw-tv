# Ficha de la Chrome Web Store — textos para copiar y pegar

Todo lo que pide el panel de desarrollador
(<https://chrome.google.com/webstore/devconsole>), en el orden en que aparece.
Imágenes en [`store/images/`](images/).

---

## 1. Paquete

Sube `trtw-tv-<versión>.zip`, generado con `npm run package`.

---

## 2. Pestaña *Ficha de la tienda*

### Idioma principal: Español

**Nombre** (sale del manifest, máx. 75): `trtw.tv — Subtítulos en español`

**Resumen** (máx. 132 caracteres):

```
Subtítulos en español en tiempo real para directos de Twitch y vídeos de YouTube en inglés. Gratis y 100 % en tu equipo.
```

**Descripción:**

```
trtw.tv pone subtítulos en español a los directos de Twitch y a los vídeos de YouTube que están en inglés, en tiempo real y sin salir de tu navegador.

✅ GRATIS Y PRIVADO
• Sin cuentas, sin claves y sin suscripciones.
• El audio se procesa en tu propio equipo: no se graba ni se envía a ningún servidor.
• Solo se descargan los modelos de IA la primera vez; después funciona desde la caché.

🎧 CÓMO FUNCIONA
• Pulsa Start en el icono (o Alt+S) en la pestaña de Twitch o YouTube.
• Whisper transcribe el inglés y se traduce al español al momento.
• Los subtítulos aparecen sobre el vídeo con 1,5–3 s de retraso, también en pantalla completa y en el modo teatro de Twitch.

⚙️ PENSADO PARA DIRECTOS
• Detector de voz (Silero VAD): ignora la música y los efectos del juego.
• Filtro anti-alucinaciones: descarta frases inventadas como “Thank you for watching”.
• Frases completas: el texto provisional aparece en gris y se fija cuando es seguro.
• Glosario editable: gg, clutch, nerf, nombres propios o emotes se quedan como están.
• Modo bilingüe: el inglés original debajo del español.

💻 FUNCIONA SIN GRÁFICA NVIDIA
• Usa WebGPU (vale la gráfica integrada Intel, AMD o Apple) y, si no hay, la CPU.
• Tres modelos a elegir: tiny.en (equipos modestos), base.en (recomendado) y small.en (más preciso).

🌐 TRADUCCIÓN LOCAL
• Traductor integrado de Chrome (en el equipo) y, como respaldo, Opus-MT, también local.

Requisitos: Chrome 138 o superior. La primera vez se descargan unos 130 MB (modelo base.en).

Proyecto de código abierto: https://github.com/jparedesDS/trtw-tv

Créditos: Whisper (OpenAI, MIT) · Opus-MT (Helsinki-NLP, CC-BY 4.0) · Silero VAD (MIT) · transformers.js y ONNX Runtime (Apache-2.0).
Twitch y YouTube son marcas de sus respectivos propietarios; esta extensión no está afiliada a ellos.
```

**Categoría:** Accesibilidad

**Icono de la tienda (128×128):** `extension/icons/icon128.png`

**Capturas (1280×800):** `store/images/screenshot-1-subtitulos.png`,
`store/images/screenshot-2-bilingue.png`, `store/images/screenshot-3-ajustes.png`

**Mosaico promocional pequeño (440×280):** `store/images/promo-440x280.png`

**Sitio web oficial / página de asistencia:** `https://github.com/jparedesDS/trtw-tv`

---

### Idioma adicional: English (opcional, *Añadir idioma*)

**Summary:**

```
Real-time Spanish subtitles for English Twitch streams and YouTube videos. Free, private and 100% on your device.
```

**Description:**

```
trtw.tv adds real-time Spanish subtitles to English Twitch streams and YouTube videos, right in your browser.

• Free and private: no accounts, no API keys. Audio is processed on your device and never recorded or uploaded.
• Press Start (or Alt+S) on a Twitch/YouTube tab: Whisper transcribes the English audio and it is translated to Spanish on the fly.
• Subtitles appear over the player with ~1.5–3 s delay, including fullscreen and Twitch theatre mode.
• Built for live streams: voice activity detection ignores music and game sounds, a hallucination filter drops made-up lines, and an editable glossary keeps gaming slang and names untranslated.
• No NVIDIA GPU needed: WebGPU (integrated Intel/AMD/Apple graphics) with CPU fallback.
• Local translation: Chrome's built-in Translator, with Opus-MT as an on-device fallback.

Requires Chrome 138+. The first run downloads the speech model (~130 MB).
Open source: https://github.com/jparedesDS/trtw-tv
Not affiliated with Twitch or YouTube.
```

---

## 3. Pestaña *Prácticas de privacidad*

**Propósito único:**

```
Mostrar subtítulos en español, en tiempo real, del audio en inglés de directos de Twitch y vídeos de YouTube. La transcripción (Whisper) y la traducción se hacen localmente en el equipo del usuario.
```

**Justificación de permisos:**

| Permiso | Justificación (copiar) |
|---|---|
| `tabCapture` | `Captura el audio de la pestaña de Twitch/YouTube en la que el usuario pulsa Start, para transcribirlo y traducirlo localmente. Solo se activa a petición del usuario y se detiene con Stop.` |
| `offscreen` | `Crea un documento oculto de la extensión donde se reproduce y procesa el audio capturado y se ejecutan los modelos de voz y traducción (Web Audio, WebGPU/WASM), que no pueden ejecutarse en el service worker.` |
| `storage` | `Guarda localmente los ajustes del usuario (modelo, tamaño y color de los subtítulos, glosario de términos).` |
| `activeTab` | `Permite capturar el audio y mostrar los subtítulos únicamente en la pestaña en la que el usuario activa la extensión.` |
| `scripting` | `Al pulsar Start, si la pestaña de Twitch/YouTube se abrió antes de instalar o actualizar la extensión y no tiene cargado el overlay de subtítulos, lo inyecta (el mismo script y CSS del paquete) para que los subtítulos se vean sin recargar la página. Solo actúa en la pestaña que el usuario activa.` |
| Permisos de host (`*://*.twitch.tv/*`, `*://*.youtube.com/*`) | `El content script dibuja los subtítulos sobre el reproductor de vídeo de Twitch y YouTube, se adapta a la pantalla completa y al modo teatro, y puede usar la traducción integrada de Chrome en esa pestaña.` |

**¿Usas código remoto?** → **No, no uso código remoto.**

Si pide explicación:

```
Todo el JavaScript y el WebAssembly (ONNX Runtime) van incluidos en el paquete. La extensión solo descarga de huggingface.co ficheros de pesos de modelos de IA (datos, no código ejecutable), que se ejecutan con el runtime incluido.
```

**Uso de datos** — marca **ninguna** categoría (no se recoge ningún tipo de dato:
el audio y el texto se procesan en memoria y se descartan). Marca las tres
certificaciones:

- [x] No vendo ni transfiero datos de usuarios a terceros, salvo en los casos de uso aprobados.
- [x] No uso ni transfiero datos de usuarios para fines no relacionados con el propósito único del elemento.
- [x] No uso ni transfiero datos de usuarios para determinar la solvencia crediticia ni para conceder préstamos.

> Si la revisión insiste en que el audio de la pestaña es "contenido del sitio
> web", márcalo y explica: *"Se procesa solo en el equipo del usuario, en
> memoria, y nunca se transmite ni se guarda."*

**URL de la política de privacidad:**

```
https://github.com/jparedesDS/trtw-tv/blob/main/PRIVACY.md
```

(El repositorio tiene que ser **público** para que el revisor pueda abrirla. Si
no quieres hacerlo público, publica `PRIVACY.md` en GitHub Pages o en otra web.)

---

## 4. Pestaña *Distribución*

- **Visibilidad:** empieza con **No listado** (solo quien tenga el enlace) para
  probar con algunos usuarios; cuando esté probado, cambia a **Público**.
- **Regiones:** todas.
- **Precio:** gratuito.

---

## 5. Instrucciones para el revisor (campo opcional *Test instructions*)

```
1. Abre un vídeo de YouTube en inglés (p. ej. cualquier charla TED) o un directo de Twitch en inglés.
2. Pulsa el icono de trtw.tv y después "Start".
3. La primera vez se descarga el modelo de voz (~130 MB, se muestra el progreso). Después aparecen subtítulos en español sobre el vídeo.
4. Sin reproducir nada: icono → "Página de test" → "Usar ejemplo (JFK)" → "Cargar modelos" → "Rápido".
No hace falta cuenta ni clave. Requiere Chrome 138+.
```
