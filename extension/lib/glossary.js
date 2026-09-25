// Glosario: términos que NO se traducen (gg, clutch, nombres, emotes…) o que
// se traducen de una forma concreta ("término = traducción").
//
// Antes de traducir, cada término se sustituye por un marcador opaco (ZQX0,
// ZQX1…) que los traductores copian tal cual; después se restaura.

const MARK = 'ZQX';

// "gg\nclutch = embrague\n# comentario" → [{ term, replacement }]
export function parseGlossary(text) {
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith('#')) continue;
    const [term, ...rest] = clean.split('=');
    const t = term.trim();
    if (!t) continue;
    const replacement = rest.length ? rest.join('=').trim() : null;
    entries.push({ term: t, replacement: replacement || null });
  }
  // Los más largos primero: "Pog Champ" antes que "Pog".
  return entries.sort((a, b) => b.term.length - a.term.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function buildMatcher(entries) {
  if (!entries.length) return null;
  const alt = entries.map((e) => escapeRe(e.term).replace(/\s+/g, '\\s+')).join('|');
  // Límites de palabra que funcionan también con acentos y emotes con mayúsculas.
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, 'giu');
}

// Sustituye los términos por marcadores. `slots[i]` es el texto final del marcador i.
export function protect(text, entries, matcher = buildMatcher(entries)) {
  const slots = [];
  if (!matcher) return { text, slots };
  const byTerm = new Map(entries.map((e) => [e.term.toLowerCase().replace(/\s+/g, ' '), e]));
  const out = text.replace(matcher, (match) => {
    const e = byTerm.get(match.toLowerCase().replace(/\s+/g, ' '));
    slots.push(e?.replacement ?? match);
    return `${MARK}${slots.length - 1}`;
  });
  return { text: out, slots };
}

// Restaura los marcadores. ok = false si el traductor se ha comido alguno.
export function restore(text, slots) {
  if (!slots.length) return { text, ok: true };
  const seen = new Set();
  const out = text.replace(/Z\s*Q\s*X\s*(\d+)/gi, (m, n) => {
    const i = Number(n);
    if (i >= slots.length) return m;
    seen.add(i);
    return slots[i];
  });
  return { text: out, ok: seen.size === slots.length };
}
