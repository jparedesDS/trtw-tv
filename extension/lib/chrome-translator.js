// Envoltorio de la Translator API integrada en Chrome (138+), que traduce en
// el propio equipo con un modelo que Chrome descarga una sola vez.
// Se usa en el documento offscreen, en el content script, en el popup y en la
// página de test.
//
// Ojo: si el modelo aún no está descargado, create() necesita un gesto del
// usuario y, sin él, puede quedarse colgado en vez de fallar. Por eso solo se
// llama a create() si el modelo ya está 'available', salvo que quien llama
// venga de un clic o una tecla (allowDownload).

import { withTimeout } from './async.js';

const OPTS = { sourceLanguage: 'en', targetLanguage: 'es' };

export const CHROME_TRANSLATOR_TIMEOUTS = {
  availabilityMs: 5000,
  createMs: 15000,             // modelo ya descargado: debería ser inmediato
  downloadMs: 10 * 60 * 1000   // con descarga puede tardar minutos
};

// Devuelve { translator, availability, error? }.
export async function createChromeTranslator({ onProgress, allowDownload = false, timeouts = {} } = {}) {
  if (!('Translator' in globalThis)) return { translator: null, availability: 'no-api' };
  const t = { ...CHROME_TRANSLATOR_TIMEOUTS, ...timeouts };
  let availability = 'unknown';
  try {
    availability = await withTimeout(globalThis.Translator.availability(OPTS), t.availabilityMs, 'Translator.availability');
    if (availability === 'unavailable') return { translator: null, availability };
    if (availability !== 'available' && !allowDownload) return { translator: null, availability };

    const create = globalThis.Translator.create({
      ...OPTS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.(Math.round(e.loaded * 100)));
      }
    });
    try {
      const ms = availability === 'available' ? t.createMs : t.downloadMs;
      return { translator: await withTimeout(create, ms, 'Translator.create'), availability };
    } catch (e) {
      // Si create() termina después del timeout, liberamos ese traductor
      // huérfano en lugar de dejarlo vivo para siempre.
      create.then((late) => late?.destroy?.(), () => {});
      throw e;
    }
  } catch (e) {
    return { translator: null, availability, error: e.message };
  }
}
