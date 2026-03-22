// trtw.tv Translation utilities
// Whisper translate task handles any→English natively.
// For other target languages, we use a free translation API.

const TRANSLATION_CACHE = new Map();
const CACHE_MAX_SIZE = 100;

/**
 * Translate text using a free translation API (MyMemory).
 * Falls back gracefully if the API is unavailable.
 */
export async function translateText(text, sourceLang, targetLang) {
  if (!text || sourceLang === targetLang) return text;

  // Check cache
  const cacheKey = `${sourceLang}:${targetLang}:${text}`;
  if (TRANSLATION_CACHE.has(cacheKey)) {
    return TRANSLATION_CACHE.get(cacheKey);
  }

  try {
    const langPair = `${sourceLang}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langPair)}`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      const translated = data.responseData.translatedText;

      // Update cache (LRU-style eviction)
      if (TRANSLATION_CACHE.size >= CACHE_MAX_SIZE) {
        const firstKey = TRANSLATION_CACHE.keys().next().value;
        TRANSLATION_CACHE.delete(firstKey);
      }
      TRANSLATION_CACHE.set(cacheKey, translated);

      return translated;
    }

    return text; // Fallback to original
  } catch {
    return text; // Fallback to original on error
  }
}

/**
 * Translate using OpenAI API (premium fallback).
 */
export async function translateWithOpenAI(text, targetLang, apiKey) {
  if (!text || !apiKey) return text;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Translate the following text to ${targetLang}. Return only the translation, nothing else.`
          },
          { role: 'user', content: text }
        ],
        max_tokens: 500,
        temperature: 0.1
      })
    });

    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}
