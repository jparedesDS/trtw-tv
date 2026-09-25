// Envoltorio de la Translator API integrada en Chrome (138+), que traduce en
// el propio equipo con un modelo que Chrome descarga una sola vez.
// Se usa en el documento offscreen, en el content script y en la página de test.
//
// Ojo: si el modelo aún no está descargado, create() necesita un gesto del
// usuario y, sin él, puede quedarse colgado en vez de fallar. Por eso solo se
// llama a create() si el modelo ya está 'available', salvo que quien llama
// venga de un clic (allowDownload).

const OPTS = { sourceLanguage: 'en', targetLanguage: 'es' };

function timeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => { t = setTimeout(() => reject(new Error('tiempo agotado')), ms); })
  ]).finally(() => clearTimeout(t));
}

// Devuelve { translator, availability, error? }.
export async function createChromeTranslator({ onProgress, allowDownload = false } = {}) {
  if (!('Translator' in globalThis)) return { translator: null, availability: 'no-api' };
  let availability = 'unknown';
  try {
    availability = await timeout(globalThis.Translator.availability(OPTS), 5000);
    if (availability !== 'available' && !allowDownload) return { translator: null, availability };
    if (availability === 'unavailable') return { translator: null, availability };
    const create = globalThis.Translator.create({
      ...OPTS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.(Math.round(e.loaded * 100)));
      }
    });
    // Con descarga puede tardar minutos; sin ella debería ser inmediato.
    const translator = await timeout(create, availability === 'available' ? 15000 : 10 * 60000);
    return { translator, availability };
  } catch (e) {
    return { translator: null, availability, error: e.message };
  }
}
