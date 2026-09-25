// Envoltorio de la Translator API integrada en Chrome (138+), que traduce en
// el propio equipo con un modelo que Chrome descarga una sola vez.
// Se usa en el documento offscreen, en el content script y en la página de test.

const OPTS = { sourceLanguage: 'en', targetLanguage: 'es' };

// Devuelve { translator, availability } o { translator: null, availability, error }.
export async function createChromeTranslator({ onProgress } = {}) {
  if (!('Translator' in globalThis)) return { translator: null, availability: 'no-api' };
  let availability = 'unknown';
  try {
    availability = await globalThis.Translator.availability(OPTS);
    if (availability === 'unavailable') return { translator: null, availability };
    // Si hay que descargar el modelo, Chrome exige un gesto del usuario: si no
    // lo hay, create() falla y el llamante usará otro motor.
    const translator = await globalThis.Translator.create({
      ...OPTS,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => onProgress?.(Math.round(e.loaded * 100)));
      }
    });
    return { translator, availability };
  } catch (e) {
    return { translator: null, availability, error: e.message };
  }
}
