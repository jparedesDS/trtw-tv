// Utilidades asíncronas compartidas.

// Rechaza si `promise` no termina en `ms`. Evita que una llamada colgada
// (la pestaña no responde, la Translator API espera un gesto…) bloquee una cola.
export function withTimeout(promise, ms, what = 'operación') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: tiempo agotado`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}
