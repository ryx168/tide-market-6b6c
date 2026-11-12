// Smoke test for CI: serve site/, play one full round of the street walk in
// headless Chrome under SwiftShader, save stills so the deploy can be eyeballed.
// Fails on console errors, on a round that does not reach the end screen, or
// on an end card without the tour price.
import puppeteer from 'puppeteer';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('site');
const out = path.resolve('stills');
fs.mkdirSync(out, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
};
const server = http.createServer((req, res) => {
  let u = decodeURIComponent(req.url.split('?')[0]);
  if (u.endsWith('/')) u += 'index.html';
  const p = path.join(root, u);
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const sl = ms => new Promise(r => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--mute-audio', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-compositing', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 720, height: 980 });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => {
  if (m.type() !== 'error') return;
  const url = (m.location() && m.location().url) || '';
  // The browser asks for /favicon.ico on its own; the day photo on the end
  // card comes from xotours.net, which the sandbox may not reach.
  if (url.includes('favicon') || url.includes('xotours.net')) return;
  errors.push((m.text() + ' @ ' + url).slice(0, 300));
});
page.on('requestfailed', r => { const u = r.url(); if (u.includes('127.0.0.1')) errors.push('REQUESTFAILED ' + u); });

await page.goto(`http://127.0.0.1:${port}/games/street-walk/`, { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.XOStreetWalk && !document.getElementById('start').disabled, { timeout: 60000 });
await sl(800);
await page.screenshot({ path: path.join(out, '1_intro.png') });

await page.click('#start');
await sl(1200);
await page.screenshot({ path: path.join(out, '2_street.png') });

// Phone layout: the 2x camera follows the player.
await page.setViewport({ width: 375, height: 760 });
await sl(600);
await page.screenshot({ path: path.join(out, '3_phone.png') });
await page.setViewport({ width: 720, height: 980 });
await sl(400);

// Tap-to-walk to each stall, read the dialogue through, then board the ship.
const tap = (tx, ty) => page.evaluate((tx, ty) => {
  const S = window.XOStreetWalk.state, cv = document.getElementById('canvas');
  const r = cv.getBoundingClientRect(), vw = 640 / S.zoom, vh = 480 / S.zoom;
  cv.dispatchEvent(new PointerEvent('pointerdown', {
    clientX: r.left + ((tx + 0.5) * 32 - S.cam.x) / vw * r.width,
    clientY: r.top + ((ty + 0.5) * 32 - S.cam.y) / vh * r.height,
    bubbles: true, pointerId: 1, pointerType: 'mouse',
  }));
}, tx, ty);
const phase = () => page.evaluate(() => window.XOStreetWalk.state.phase);
const stalls = await page.evaluate(() => window.XOStreetWalk.state.map.stalls.map(s => ({ x: s.x, y: s.y, content: s.content })));
const visited = [];
for (const [i, st] of stalls.entries()) {
  await tap(st.x, st.y);
  await page.waitForFunction(() => window.XOStreetWalk.state.phase === 'dialog', { timeout: 20000 });
  await sl(900);
  if (i === 0) await page.screenshot({ path: path.join(out, '4_dialog.png') });
  const who = await page.$eval('#dlg-who', e => e.textContent);
  const portrait = await page.$eval('#dlg-portrait', e => e.getAttribute('src'));
  let taps = 0;
  while ((await phase()) === 'dialog' && taps++ < 20) { await page.click('#dialog'); await sl(150); }
  const tokens = await page.evaluate(() => window.XOStreetWalk.state.tokens.size);
  visited.push({ stall: [st.x, st.y], who, portrait, taps, tokens });
}
const ship = await page.evaluate(() => window.XOStreetWalk.state.map.ship.gangway);
await tap(ship.x, ship.y);
await page.waitForFunction(() => window.XOStreetWalk.state.phase === 'end', { timeout: 20000 });
await sl(800);
await page.screenshot({ path: path.join(out, '5_end_card.png') });
const end = await page.evaluate(() => ({
  points: document.getElementById('end-points').textContent,
  detail: document.getElementById('end-detail').textContent,
  stop: document.getElementById('card-stop').textContent,
  day: document.getElementById('card-day').textContent,
  price: document.getElementById('card-price').textContent,
  see: document.getElementById('see').href,
  endHidden: document.getElementById('end').hidden,
}));

await browser.close(); server.close();

const report = { visited, end, errors };
console.log(JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
let bad = 0;
if (errors.length) { console.error('console errors during smoke run'); bad++; }
if (visited.length !== 4 || visited[3].tokens !== 4) { console.error('did not collect four tokens'); bad++; }
if (!end || end.endHidden || Number(end.points) <= 0) { console.error('round did not end on the stop card'); bad++; }
if (!/4099/.test(end.price)) { console.error('end card has no tour price'); bad++; }
if (!end.see.startsWith('https://www.xotours.net/')) { console.error('See-this-tour link is wrong'); bad++; }
process.exit(bad ? 1 : 0);
