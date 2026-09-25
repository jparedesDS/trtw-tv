// Build de la extensión con esbuild.
//
//  - Empaqueta los módulos que importan dependencias npm (transformers.js,
//    onnxruntime-web) en extension/dist/.
//  - Copia los ficheros WASM de onnxruntime-web a extension/vendor/ort/ para
//    que NO se descarguen de jsDelivr (la CSP de MV3 lo bloquea).
//
// Uso: node scripts/build.mjs [--watch]

import * as esbuild from 'esbuild';
import { copyFile, mkdir, rm, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const watch = process.argv.includes('--watch');

// onnxruntime-web se resuelve desde transformers.js para garantizar que todo
// el código (incluido nuestro VAD) usa exactamente la misma versión y los
// mismos ficheros WASM.
const require = createRequire(import.meta.url);
const pkgRoot = (entry) => entry.slice(0, entry.lastIndexOf(`${path.sep}dist${path.sep}`));
const transformersDir = pkgRoot(require.resolve('@huggingface/transformers'));
const ortDir = pkgRoot(require.resolve('onnxruntime-web', { paths: [transformersDir] }));
const ortVersion = JSON.parse(await readFile(path.join(ortDir, 'package.json'), 'utf8')).version;

// Variante "extern-wasm": el pegamento .mjs y el .wasm se cargan desde
// env.wasm.wasmPaths (nuestra carpeta vendor/ort/) en lugar de ir incrustados
// o de pedirse al CDN.
const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];

async function copyOrtFiles() {
  const dest = path.join(ext, 'vendor', 'ort');
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  for (const f of ORT_FILES) {
    await copyFile(path.join(ortDir, 'dist', f), path.join(dest, f));
  }
  console.log(`[build] onnxruntime-web ${ortVersion}: WASM copiado a extension/vendor/ort/`);
}

const common = {
  bundle: true,
  platform: 'browser',
  target: 'chrome120',
  conditions: ['onnxruntime-web-use-extern-wasm'],
  alias: { 'onnxruntime-web': path.join(ortDir, 'dist', 'ort.min.mjs') },
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' }
};

// Módulos ES (páginas de la extensión y workers).
const esmEntries = {
  offscreen: 'extension/offscreen/offscreen.js',
  'asr-worker': 'extension/workers/asr-worker.js',
  test: 'extension/test/test.js'
};

// Scripts clásicos (content scripts no admiten módulos ES).
const iifeEntries = {
  overlay: 'extension/content/overlay.js'
};

function existing(entries) {
  return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, path.join(root, v)]));
}

const configs = [
  { ...common, format: 'esm', entryPoints: existing(esmEntries), outdir: path.join(ext, 'dist') },
  { ...common, format: 'iife', entryPoints: existing(iifeEntries), outdir: path.join(ext, 'dist') }
];

await rm(path.join(ext, 'dist'), { recursive: true, force: true });
await copyOrtFiles();

if (watch) {
  for (const cfg of configs) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
  console.log('[build] Vigilando cambios… (Ctrl+C para salir)');
} else {
  await Promise.all(configs.map((cfg) => esbuild.build(cfg)));
  console.log('[build] OK → extension/dist/');
}
