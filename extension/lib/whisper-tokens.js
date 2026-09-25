// Utilidades puras para interpretar la salida de Whisper (sin dependencias,
// se prueban en Node).

// Convierte los tokens generados (con timestamps) en segmentos.
//
// Con return_timestamps Whisper genera:  <|0.00|> texto <|2.40|><|2.40|> texto <|5.10|><|endoftext|>
// El último segmento puede quedar abierto (sin timestamp de cierre) si el audio
// termina a media frase: lo marcamos con end = null (incompleto).
//
// tokens:      ids generados (sin los tokens iniciales)
// logprobs:    logprob de cada token (mismo índice) o null
// decode:      (ids) => string
// opts:        { timestampBegin, eosTokenId, timePrecision=0.02 }
export function tokensToSegments(tokens, logprobs, decode, opts) {
  const { timestampBegin, eosTokenId, timePrecision = 0.02 } = opts;
  const segments = [];
  let cur = null;       // segmento abierto
  let textIds = [];
  let lps = [];
  let lastEnd = null;   // fin del último segmento cerrado

  const close = (end) => {
    const text = decode(textIds).trim();
    if (text) {
      segments.push({
        start: cur ? cur.start : null,
        end,
        text,
        avgLogprob: lps.length ? lps.reduce((a, b) => a + b, 0) / lps.length : null,
        tokens: textIds.length
      });
    }
    if (end != null) lastEnd = end;
    cur = null;
    textIds = [];
    lps = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === eosTokenId) break;

    if (t >= timestampBegin) {
      const time = +((t - timestampBegin) * timePrecision).toFixed(2);
      if (cur && textIds.length > 0) {
        close(time);               // cierra el segmento actual
      } else if (!cur) {
        cur = { start: time };     // abre uno nuevo
      } else {
        cur.start = time;          // dos timestamps seguidos sin texto: nos quedamos con el último
      }
      continue;
    }

    if (t > eosTokenId) continue;  // otros tokens especiales
    if (!cur) cur = { start: lastEnd }; // texto tras un único timestamp de cierre
    textIds.push(t);
    if (logprobs && logprobs[i] != null) lps.push(logprobs[i]);
  }

  // Texto sin timestamp de cierre → segmento incompleto
  if (textIds.length > 0) close(null);
  return segments;
}

// Log-softmax de un vector de logits (solo lo que necesitamos: el
// logsumexp para calcular probabilidades de tokens concretos).
export function logSumExp(logits) {
  let max = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i];
  if (!Number.isFinite(max)) return max;
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max);
  return max + Math.log(sum);
}
