# Política de privacidad — trtw.tv

*Última actualización: 25 de septiembre de 2026*

trtw.tv es una extensión de Chrome que muestra subtítulos en español del audio
de directos de Twitch y vídeos de YouTube. **Todo el procesamiento se hace en tu
propio equipo.**

## Qué datos trata la extensión

- **Audio de la pestaña.** Solo cuando pulsas *Start* (o Alt+S) en una pestaña
  de Twitch o YouTube, la extensión captura el audio de esa pestaña para
  transcribirlo y traducirlo. El audio se procesa en memoria, en tu equipo, y se
  descarta al momento. **No se graba, no se guarda y no se envía a ningún sitio.**
- **Texto transcrito y traducido.** Se muestra sobre el vídeo y se descarta.
  No se guarda ni se envía.
- **Ajustes.** El modelo elegido, el glosario, el tamaño de letra y demás
  preferencias se guardan con `chrome.storage` en tu navegador. No salen de él.

## Qué NO hace

- No recoge datos personales, de navegación ni de uso.
- No tiene analítica, publicidad, cookies propias ni identificadores.
- No usa servidores propios ni APIs de terceros para transcribir o traducir.
- No vende ni comparte datos con nadie (no los tiene).

## Conexiones de red

La única conexión que hace la extensión es la **descarga de los modelos de IA**
desde `huggingface.co` la primera vez que los usas (Whisper para la voz y, si
hace falta, Opus-MT para traducir). Son descargas de ficheros públicos: no se
envía ningún audio, texto ni dato tuyo. Después quedan en la caché del
navegador y no se vuelven a descargar.

Si usas la traducción integrada de Chrome (Translator API), el modelo de idioma
lo descarga y gestiona el propio Chrome según la política de Google; la
traducción también se hace en tu equipo.

## Permisos

| Permiso | Para qué |
|---|---|
| `tabCapture` | Capturar el audio de la pestaña en la que pulsas Start. |
| `offscreen` | Procesar el audio y ejecutar los modelos en un documento oculto de la extensión. |
| `storage` | Guardar tus ajustes. |
| `activeTab` | Actuar solo sobre la pestaña en la que activas la extensión. |
| `scripting` | Si la pestaña se abrió antes de instalar o actualizar la extensión, cargar en ella el overlay de subtítulos al pulsar Start. |
| Acceso a twitch.tv y youtube.com | Mostrar los subtítulos sobre el reproductor. |

## Cambios y contacto

Si esta política cambia, se actualizará este documento y su fecha.
Dudas o incidencias: <https://github.com/jparedesDS/trtw-tv/issues>

---

# Privacy policy — trtw.tv (English)

*Last updated: September 25, 2026*

trtw.tv is a Chrome extension that shows Spanish subtitles for the audio of
Twitch streams and YouTube videos. **All processing happens on your own device.**

- **Tab audio** is captured only after you press *Start* (or Alt+S) on a Twitch
  or YouTube tab. It is processed in memory on your device and discarded
  immediately. It is never recorded, stored or sent anywhere.
- **Transcribed and translated text** is shown over the video and discarded.
- **Settings** are stored locally with `chrome.storage` and never leave your browser.
- No personal data, browsing data, analytics, ads or tracking of any kind.
- The only network traffic is the one-time download of public AI model files
  from `huggingface.co`. No audio, text or user data is sent.
- Chrome's built-in Translator API (if used) runs on-device and its language
  model is managed by Chrome itself.

Contact: <https://github.com/jparedesDS/trtw-tv/issues>
