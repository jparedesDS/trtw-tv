// Genera las imágenes de la Chrome Web Store en store/images/.
//
// Requiere Playwright (no es dependencia del proyecto):
//   npm i --no-save playwright && npx playwright install chromium
//   npm run build && node store/render.mjs
//
// Las escenas usan el CSS y el renderer REALES del overlay; el popup se
// captura con la extensión cargada de verdad.

import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Falta Playwright: npm i --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const out = (f) => path.join(root, 'store', 'images', f);

// Sin build, Chrome rechaza la extensión y solo veríamos un timeout.
try {
  await stat(path.join(ext, 'dist', 'overlay.js'));
} catch {
  console.error('Falta compilar la extensión: ejecuta "npm run build" antes.');
  process.exit(1);
}

// ── Servidor estático mínimo (los módulos ES no cargan desde file://) ──

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm'
};

// Solo se sirve lo necesario para las escenas: store/src, store/images y extension/.
const SERVED = [path.join(root, 'store', 'src'), path.join(root, 'store', 'images'), ext];

function resolveSafe(urlPath) {
  const p = path.resolve(root, '.' + decodeURIComponent(urlPath));
  return SERVED.some((dir) => {
    const rel = path.relative(dir, p);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }) ? p : null;
}

const server = createServer(async (req, res) => {
  const p = resolveSafe(new URL(req.url, 'http://x').pathname);
  try {
    if (!p) throw new Error('fuera de las carpetas servidas');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

let profile = null;
let ctx = null;

try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/store/src/`;

  profile = await mkdtemp(path.join(tmpdir(), 'trtw-store-'));
  ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });

  // 1) Popup real, en estado "En directo"
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 1000 });
  await popup.goto(`chrome-extension://${sw.url().split('/')[2]}/popup/popup.html`);
  await popup.waitForFunction(() => document.querySelectorAll('#model-select option').length > 0);

  // El popup consulta su estado real al abrirse y puede repintar "Parado"
  // después de nuestro mensaje: reenviamos hasta que "En directo" se mantenga.
  const fake = { state: 'capturing', device: 'webgpu', engine: 'chrome' };
  const text = () => popup.textContent('#status-text');
  let stable = false;
  for (let i = 0; i < 20 && !stable; i++) {
    await sw.evaluate((status) => chrome.runtime.sendMessage({ type: 'status', status }), fake);
    await popup.waitForTimeout(250);
    stable = (await text()) === 'En directo';
    if (stable) {
      await popup.waitForTimeout(400);
      stable = (await text()) === 'En directo';
    }
  }
  if (!stable) throw new Error(`El popup no muestra "En directo" (muestra "${await text()}")`);

  // Recorte intencionado: estado, botón, backend y la primera sección de ajustes.
  const box = await popup.locator('.app').boundingBox();
  await popup.screenshot({
    path: out('_popup.png'),
    clip: { x: box.x, y: box.y, width: box.width, height: Math.min(640, box.height) }
  });
  console.log('✓ _popup.png');

  // 2) Resto de imágenes con el mismo procedimiento
  const page = await ctx.newPage();
  const shot = async (file, url, { width = 1280, height = 800 } = {}) => {
    await page.setViewportSize({ width, height });
    await page.goto(base + url);
    await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400); // transición de opacidad del overlay
    await page.screenshot({ path: out(file) });
    console.log('✓', file);
  };
  const scene = (params) => 'scene.html?' + new URLSearchParams(params);

  await shot('screenshot-1-subtitulos.png', scene({
    title: 'Subtítulos en español, <span class="accent">en directo</span>',
    subtitle: 'Para directos de Twitch y vídeos de YouTube en inglés',
    finals: JSON.stringify([['Vale, chat, vamos a por la última ronda. Si ganamos esta, subimos de rango.',
      "Okay chat, let's go for the last round. If we win this one, we rank up."]])
  }));

  await shot('screenshot-2-bilingue.png', scene({
    title: 'Modo bilingüe y <span class="accent">frases completas</span>',
    subtitle: 'El inglés original debajo · el texto provisional en gris hasta que es seguro',
    bilingual: '1',
    finals: JSON.stringify([['Ese clutch ha sido increíble, gg a todos.', 'That clutch was insane, gg everyone.']]),
    partialEs: 'Ahora vamos a probar',
    partialEn: "Now we're going to try"
  }));

  await shot('screenshot-3-ajustes.png', 'settings.html');
  await shot('promo-440x280.png', 'promo.html', { width: 440, height: 280 });
} catch (e) {
  console.error('Error generando las imágenes:', e.message);
  process.exitCode = 1;
} finally {
  await ctx?.close().catch(() => {});
  server.close();
  if (profile) await rm(profile, { recursive: true, force: true });
}
