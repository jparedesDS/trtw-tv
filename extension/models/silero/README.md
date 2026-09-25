# Silero VAD v5

`silero_vad_v5.onnx` — detector de voz de [snakers4/silero-vad](https://github.com/snakers4/silero-vad)
(licencia MIT, © Silero Team). Se incluye en la extensión para que la detección de
voz funcione sin descargas. Copia obtenida del paquete npm `@ricky0123/vad-web`.

Entradas: `input` [1, 576] (64 muestras de contexto + 512 nuevas a 16 kHz),
`state` [2, 1, 128], `sr` (int64). Salidas: `output` (prob. de voz), `stateN`.
