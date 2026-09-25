// Empaqueta extension/ en un .zip listo para la Chrome Web Store.
//
// Funciona igual en Windows, macOS y Linux (no usa el comando `zip`): el ZIP
// se escribe a mano con zlib, como scripts/generate-icons.cjs con los PNG.
//
// Uso:  npm run package      (compila antes)
// Sale: trtw-tv-<versión>.zip en la raíz del repo.

import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');

// Lo que no debe ir en el paquete público.
const EXCLUDE = [
  /\.map$/,                          // source maps del build
  /^icons\/generate-icons\.html$/,   // herramienta de desarrollo
  /(^|\/)\.DS_Store$/,
  /(^|\/)Thumbs\.db$/
];

// ── Comprobaciones previas ──────────────────────────────────────

const manifest = JSON.parse(await readFile(path.join(ext, 'manifest.json'), 'utf8'));
const errors = [];

// Todo lo que el manifest (y el código) necesita tiene que existir.
const required = new Set([
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  'offscreen/offscreen.html',
  'dist/offscreen.js',
  'dist/asr-worker.js',
  'dist/test.js',
  'vendor/ort/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/ort/ort-wasm-simd-threaded.jsep.wasm',
  'models/silero/silero_vad_v5.onnx'
]);
for (const f of required) {
  try {
    await stat(path.join(ext, f));
  } catch {
    errors.push(`Falta ${f}${f.startsWith('dist/') || f.startsWith('vendor/') ? ' (¿has ejecutado npm run build?)' : ''}`);
  }
}
if (manifest.description.length > 132) errors.push(`La descripción del manifest supera 132 caracteres (${manifest.description.length})`);
if (manifest.name.length > 75) errors.push(`El nombre del manifest supera 75 caracteres (${manifest.name.length})`);
if (!/^\d+(\.\d+){0,3}$/.test(manifest.version)) errors.push(`Versión no válida: ${manifest.version}`);

if (errors.length) {
  console.error('[package] No se puede empaquetar:\n  - ' + errors.join('\n  - '));
  process.exit(1);
}

// ── Recogida de ficheros ────────────────────────────────────────

async function walk(dir, rel = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), r)));
    else if (!EXCLUDE.some((re) => re.test(r))) out.push(r);
  }
  return out.sort();
}
const files = await walk(ext);

// ── Escritor ZIP mínimo (deflate, sin ZIP64: de sobra para < 4 GB) ─────

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fecha fija: el mismo código produce siempre el mismo zip.
const DOS_TIME = 0;
const DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1;

const chunks = [];
const central = [];
let offset = 0;
let rawTotal = 0;

for (const name of files) {
  const data = await readFile(path.join(ext, name));
  const deflated = deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  rawTotal += data.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);                 // versión necesaria
  local.writeUInt16LE(0x0800, 6);             // nombres en UTF-8
  local.writeUInt16LE(useDeflate ? 8 : 0, 8); // método
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(20, 4);
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
  cen.writeUInt16LE(DOS_TIME, 12);
  cen.writeUInt16LE(DOS_DATE, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt32LE(offset, 42);              // resto de campos a 0

  chunks.push(local, nameBuf, body);
  central.push(cen, nameBuf);
  offset += local.length + nameBuf.length + body.length;
}

const centralBuf = Buffer.concat(central);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

const zip = Buffer.concat([...chunks, centralBuf, eocd]);
const out = path.join(root, `trtw-tv-${manifest.version}.zip`);
await writeFile(out, zip);

const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
console.log(`[package] ${files.length} ficheros (${mb(rawTotal)} → ${mb(zip.length)})`);
console.log(`[package] OK → ${path.relative(root, out)}  (versión ${manifest.version})`);
console.log('[package] Recuerda subir la versión en extension/manifest.json antes de cada envío a la tienda.');
