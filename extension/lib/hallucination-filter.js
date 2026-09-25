// Filtro anti-alucinaciones de Whisper.
//
// Whisper, ante música, ruido o silencio, "rellena" con frases típicas de
// YouTube ("Thank you for watching", "Subtitles by…"), repite la misma frase
// en bucle o inventa texto con poca confianza. Aquí se combinan varias señales:
//
//   1. Limpieza: fuera anotaciones tipo [Music], (applause), ♪…
//   2. Frases típicas: unas se descartan siempre (créditos de subtítulos) y
//      otras solo si hay poca voz o poca confianza ("thank you", "bye"…).
//   3. Métricas del modelo: no_speech_prob alto + avg_logprob bajo (la regla
//      de OpenAI) o avg_logprob muy bajo.
//   4. Proporción de voz según el VAD dentro del segmento.
//   5. Repeticiones: se colapsan; si el texto es casi todo repetición, fuera.
//   6. Duplicados de la frase anterior.

import { normalizeText } from './streamer.js';

export const FILTER_DEFAULTS = {
  noSpeechThreshold: 0.6,  // como en OpenAI Whisper
  logprobThreshold: -1.0,  // como en OpenAI Whisper
  minLogprob: -1.6,        // por debajo: se descarta aunque no_speech sea bajo
  minSpeechRatio: 0.2,     // fracción mínima de tramas con voz
  suspiciousSpeechRatio: 0.5
};

// Se descartan SIEMPRE (nunca aparecen en un directo real como tal).
const ALWAYS = [
  /\bamara\.?org\b/i,
  /\b(subtitles?|captions?|subtitled|transcri(bed|ption)|translated|translation)\s+(by|from|provided)\b/i,
  /\bsubtitulado por\b/i,
  /\b(www\.|https?:\/\/)/i,
  /\bcopyright\b.*\ball rights reserved\b/i
];

// Frases típicas: se descartan si la frase es SOLO eso y además hay poca voz o
// poca confianza (un streamer puede decir "thank you" de verdad).
const TYPICAL = new Set([
  'thank you', 'thank you very much', 'thank you so much', 'thanks', 'thanks for watching',
  'thank you for watching', 'thank you for watching and see you next time',
  'thanks for watching and see you next time', 'please subscribe', 'please like and subscribe',
  'like and subscribe', 'subscribe to my channel', 'dont forget to like and subscribe',
  "don't forget to like and subscribe", 'see you next time', 'see you in the next video',
  'see you in the next one', 'bye', 'bye bye', 'goodbye', 'you', 'the end', 'oh', 'uh', 'um',
  'hmm', 'mm', 'so', 'okay', 'ok', 'yeah', 'i', 'the', 'and', 'music', 'applause', 'laughter'
]);

// Quita anotaciones de sonido y símbolos musicales.
export function cleanText(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')          // [Music], [BLANK_AUDIO]
    .replace(/\([^)]*\)/g, ' ')           // (applause)
    .replace(/\*[^*]*\*/g, ' ')           // *laughs*
    .replace(/[♪♫♬🎵🎶]+/gu, ' ')
    .replace(/^\s*[-–—>]+\s*/, '')        // guiones de diálogo al principio
    .replace(/\s+/g, ' ')
    .trim();
}

// Colapsa repeticiones de n-gramas consecutivos (1 a 6 palabras) que se
// repiten más de `maxRepeats` veces: "no no no no no no" → "no no no".
export function collapseRepetitions(text, maxRepeats = 3) {
  let words = text.split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 6; n++) {
    const out = [];
    let i = 0;
    while (i < words.length) {
      const gram = words.slice(i, i + n);
      const key = normalizeText(gram.join(' '));
      let reps = 1;
      while (
        i + (reps + 1) * n <= words.length &&
        normalizeText(words.slice(i + reps * n, i + (reps + 1) * n).join(' ')) === key
      ) reps++;
      if (reps > maxRepeats && key) {
        for (let r = 0; r < maxRepeats; r++) out.push(...gram);
        i += reps * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }
  return words.join(' ');
}

// seg: { text, avgLogprob }  ·  ctx: { noSpeechProb, avgLogprob, speechRatio, durationSec, previousText }
// Devuelve { text, reject, reason }.
export function judgeSegment(seg, ctx = {}, opts = {}) {
  const o = { ...FILTER_DEFAULTS, ...opts };
  const raw = seg.text || '';
  let text = cleanText(raw);
  const norm = normalizeText(text);
  const reject = (reason) => ({ text, reject: true, reason });

  if (!norm) return reject('vacío o solo anotaciones');
  if (!/[a-z]/i.test(norm)) return reject('sin letras');

  // Texto con muchos caracteres no latinos en un modelo solo-inglés = basura.
  const letters = norm.replace(/[^\p{L}]/gu, '');
  const latin = letters.replace(/[^a-z]/gi, '');
  if (letters.length > 3 && latin.length / letters.length < 0.7) return reject('caracteres no latinos');

  for (const re of ALWAYS) if (re.test(text)) return reject('frase típica de alucinación');

  const lp = ctx.avgLogprob ?? seg.avgLogprob;
  const ns = ctx.noSpeechProb;
  const ratio = ctx.speechRatio;

  // Regla de OpenAI: probablemente no hay voz.
  if (ns != null && lp != null && ns > o.noSpeechThreshold && lp < o.logprobThreshold) {
    return reject(`sin voz (no_speech=${ns.toFixed(2)}, logprob=${lp.toFixed(2)})`);
  }
  if (lp != null && lp < o.minLogprob) return reject(`confianza muy baja (logprob=${lp.toFixed(2)})`);
  if (ratio != null && ratio < o.minSpeechRatio) return reject(`casi sin voz según el VAD (${Math.round(ratio * 100)}%)`);

  if (TYPICAL.has(norm)) {
    const weak =
      (ratio != null && ratio < o.suspiciousSpeechRatio) ||
      (ns != null && ns > 0.3) ||
      (lp != null && lp < -0.7);
    if (weak) return reject('frase típica con poca voz/confianza');
  }

  // Repeticiones en bucle
  const collapsed = collapseRepetitions(text);
  if (collapsed !== text) {
    const before = text.split(' ').length;
    const after = collapsed.split(' ').length;
    if (after / before < 0.35 && before >= 12) return reject('repetición en bucle');
    text = collapsed;
  }

  // Misma frase que la anterior (Whisper repitiendo contexto)
  if (ctx.previousText && normalizeText(ctx.previousText) === normalizeText(text) && norm.split(' ').length >= 3) {
    return reject('duplicado de la frase anterior');
  }

  return { text, reject: false };
}
