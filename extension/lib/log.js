// Logs con prefijo común para poder filtrar en la consola por "[trtw.tv]".
// Uso: const log = createLogger('offscreen'); log.info('hola');

export function createLogger(scope) {
  const prefix = scope ? `[trtw.tv][${scope}]` : '[trtw.tv]';
  return {
    debug: (...args) => console.debug(prefix, ...args),
    info: (...args) => console.info(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args)
  };
}
