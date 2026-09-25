// Genera las imágenes de la Chrome Web Store en store/images/.
//
// Requiere Playwright (no es dependencia del proyecto):
//   npm i --no-save playwright && npx playwright install chromium
//   npm run build && node store/render.mjs
//
// Las escenas usan el CSS y el renderer REALES del overlay; el popup se
// captura con la extensión cargada de verdad.

import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
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
const out = (f) => path.join(root, 'store', 'images', f);

// Servidor estático mínimo (los módulos ES no cargan desde file://).
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!p.startsWith(root)) throw new Error('fuera del repo');
    const body = await readFile(p);
    res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/store/src/`;

const ext = path.join(root, 'extension');
const profile = await mkdtemp(path.join(tmpdir(), 'trtw-store-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});

try {
  // 1) Popup real, en estado "En directo"
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 380, height: 700 });
  await popup.goto(`chrome-extension://${sw.url().split('/')[2]}/popup/popup.html`);
  await popup.waitForTimeout(500);
  await sw.evaluate(() => chrome.runtime.sendMessage({
    type: 'status',
    status: { state: 'capturing', device: 'webgpu', engine: 'chrome' }
  }));
  await popup.waitForTimeout(300);
  await popup.screenshot({ path: out('_popup.png'), clip: { x: 0, y: 0, width: 380, height: 640 } });

  // 2) Escenas con subtítulos
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const scene = async (file, params) => {
    await page.goto(base + 'scene.html?' + new URLSearchParams(params));
    await page.waitForSelector('body[data-ready="1"]');
    await page.waitForTimeout(400); // transición de opacidad
    await page.screenshot({ path: out(file) });
    console.log('✓', file);
  };

  await scene('screenshot-1-subtitulos.png', {
    title: 'Subtítulos en español, <span class="accent">en directo</span>',
    subtitle: 'Para directos de Twitch y vídeos de YouTube en inglés',
    finals: JSON.stringify([['Vale, chat, vamos a por la última ronda. Si ganamos esta, subimos de rango.',
      "Okay chat, let's go for the last round. If we win this one, we rank up."]])
  });

  await scene('screenshot-2-bilingue.png', {
    title: 'Modo bilingüe y <span class="accent">frases completas</span>',
    subtitle: 'El inglés original debajo · el texto provisional en gris hasta que es seguro',
    bilingual: '1',
    finals: JSON.stringify([['Ese clutch ha sido increíble, gg a todos.', 'That clutch was insane, gg everyone.']]),
    partialEs: 'Ahora vamos a probar',
    partialEn: "Now we're going to try"
  });

  // 3) Ajustes (popup) + ventajas
  await page.goto(base + 'settings.html');
  await page.waitForTimeout(300);
  await page.screenshot({ path: out('screenshot-3-ajustes.png') });
  console.log('✓ screenshot-3-ajustes.png');

  // 4) Mosaico promocional
  await page.setViewportSize({ width: 440, height: 280 });
  await page.goto(base + 'promo.html');
  await page.waitForTimeout(200);
  await page.screenshot({ path: out('promo-440x280.png') });
  console.log('✓ promo-440x280.png');
} finally {
  await ctx.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
