/*
 * games/street-walk/game.js -- 老街漫步 RPG Street Walk.
 *
 * Top-down tile walk along a Liverpool dock street (tour 7622, day 8).
 * Four vendor stalls, one token each, the ship at the end. All text the
 * vendors say comes from the day-8 description and the Liverpool 360
 * hotspots; the map is generated in map.js from the daily seed.
 *
 * Rendering is the "drawn-in" pass: the world is painted once per round to
 * a static layer (cobbles, brick and timber facades, slate roofs, the quay),
 * sprites are drawn each frame sorted by their feet, a light map is
 * multiplied over the frame with warm bloom at the lamps, and a blurred
 * copy of the frame is masked into the top and bottom bands for a
 * tilt-shift depth of field. On narrow screens a camera follows the player
 * at 2x. The four vendor portraits and the key art under the intro are
 * AI-generated (Workers AI flux-1-schnell), see README.
 */

import { loadLevel } from '../../shared/level.js';
import { resolveLook } from '../../shared/look.js';
import { dailySeed, createScore, saveRun, loadRuns, rng } from '../../shared/reward.js';
import { T, LAYOUT, generateMap, findPath, tileAt, isWalkable } from './map.js';

const TOUR_ID = 7622;
const BASE = '../..';
const SITE = 'https://www.xotours.net';
const GAME = 'street-walk';
const DAY_INDEX = 7;             // day 8 (0-based)
const TILE = 32;
const MOVE_MS = 130;             // one tile, the player
const NPC_MS = 460;              // one tile, a townsperson
const RM_KEY = 'xo-reduce-motion';
const WORLD_W = 20 * TILE, WORLD_H = 15 * TILE;

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const dof = $('dof');
const dofCtx = dof.getContext('2d');
const world = document.createElement('canvas');
world.width = WORLD_W; world.height = WORLD_H;
const wctx = world.getContext('2d');
const el = {
    hudSub: $('hud-sub'), time: $('time'), tokens: $('tokens'), toast: $('toast'),
    dialog: $('dialog'), dlgWho: $('dlg-who'), dlgLine: $('dlg-line'), dlgNext: $('dlg-next'), dlgPortrait: $('dlg-portrait'),
    dpad: $('dpad'), ok: $('ok'), rmHud: $('rm-hud'), rmIntro: $('rm-intro'),
    intro: $('intro'), introSub: $('intro-sub'), introSeed: $('intro-seed'), start: $('start'),
    end: $('end'), endPoints: $('end-points'), endDetail: $('end-detail'), endBest: $('end-best'),
    cardImg: $('card-img'), cardStop: $('card-stop'), cardDay: $('card-day'), cardTour: $('card-tour'),
    cardPrice: $('card-price'), again: $('again'), see: $('see'), err: $('err'),
};

// ---------- state ----------
const S = {
    level: null, day: null, stop: null, price: null, look: null,
    seed: dailySeed(), map: null, vendors: [],
    phase: 'intro',                       // intro | play | dialog | end
    player: { x: 0, y: 0, fx: 0, fy: 0, dir: 'right', moving: null },
    held: [],                             // directions, last pressed last
    path: [],                             // tap-to-walk queue
    tokens: new Set(), steps: 0, bumpLock: null,
    timer: { started: 0, paused: 0, pauseAt: 0, running: false, frozen: 0 },
    dialog: null,                         // { vendor, stallIdx, line, shown }
    score: null,
    reduceMotion: readRM(),
    bg: null,                             // static layer
    light: null,                          // light map, multiplied over the frame
    decor: null,                          // building spans, lamps, lit windows
    npcs: [], gulls: [],
    cam: { x: 0, y: 0, init: false }, zoom: 1,
    toastT: 0,
};

function readRM() {
    try {
        const v = localStorage.getItem(RM_KEY);
        if (v === '1') return true;
        if (v === '0') return false;
    } catch (_) { /* ignore */ }
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function setRM(on) {
    S.reduceMotion = on;
    try { localStorage.setItem(RM_KEY, on ? '1' : '0'); } catch (_) { /* ignore */ }
    for (const b of [el.rmHud, el.rmIntro]) {
        b.classList.toggle('on', on);
        b.textContent = (on ? '✓ ' : '') + '減少動態 Reduce motion';
    }
}

// ---------- content derived from the tour JSON ----------
function splitSentences(text) {
    return String(text || '').split(/[。！？!?]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Four vendors. Hotspots first (their title is the stall name, their text
 * the line); the day description, split into sentences, fills the rest in
 * order. Stall labels for description stalls are UI labels, not facts.
 */
function buildVendors(day, stop) {
    const hs = ((stop && stop.aiScene && stop.aiScene.hotspots) || []).filter((h) => h.title || h.text);
    const vendors = hs.slice(0, 3).map((h) => ({ name: h.title || '攤位 Stall', lines: [h.text].filter(Boolean) }));
    const need = 4 - vendors.length;
    const sentences = splitSentences(day.description);
    const labels = ['港口公告 Port notice', '城市導覽 City guide', '街角攤位 Corner stall', '碼頭攤位 Dock stall'];
    const groups = Array.from({ length: need }, () => []);
    sentences.forEach((s, i) => groups[Math.min(need - 1, Math.floor(i * need / sentences.length))].push(s));
    groups.forEach((g, i) => vendors.push({ name: labels[i], lines: g.length ? g : [day.title] }));
    return vendors.slice(0, 4);
}

async function loadPrice() {
    // level.js does not carry prices[]; read the same JSON (already in the
    // browser cache from loadLevel). See README "Asks for shared/".
    try {
        const res = await fetch(`${BASE}/kv_json_exports/tour_${TOUR_ID}.json`);
        const t = await res.json();
        return (t.prices && t.prices[0]) || (t.price != null ? { optionName: '', price: t.price } : null);
    } catch (_) { return null; }
}

// ---------- round setup ----------
function newRound() {
    S.map = generateMap(S.seed);
    S.tokens = new Set();
    S.steps = 0;
    S.bumpLock = null;
    S.path = [];
    S.held = [];
    S.dialog = null;
    S.score = createScore();
    S.timer = { started: 0, paused: 0, pauseAt: 0, running: false, frozen: 0 };
    const p = S.player;
    p.x = S.map.start.x; p.y = S.map.start.y; p.fx = p.x; p.fy = p.y; p.dir = 'right'; p.moving = null;
    S.decor = buildDecor(S.map);
    S.bg = renderStatic(S.map);
    S.light = renderLight(S.map);
    S.npcs = spawnNpcs(S.map);
    S.gulls = spawnGulls(S.map);
    S.cam.init = false;
    renderTokens();
    el.dialog.hidden = true;
    S.phase = 'play';
}

// ---------- timer ----------
function now() { return performance.now(); }
function elapsedMs() {
    const t = S.timer;
    if (!t.running) return t.frozen;
    const pausedNow = t.pauseAt ? now() - t.pauseAt : 0;
    return now() - t.started - t.paused - pausedNow;
}
function timerStart() { if (!S.timer.running) { S.timer.running = true; S.timer.started = now(); } }
function timerPause() { if (S.timer.running && !S.timer.pauseAt) S.timer.pauseAt = now(); }
function timerResume() { if (S.timer.pauseAt) { S.timer.paused += now() - S.timer.pauseAt; S.timer.pauseAt = 0; } }
function timerStop() { S.timer.frozen = elapsedMs(); S.timer.running = false; }

// ---------- movement ----------
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function press(dir) {
    if (!DIRS[dir]) return;
    S.path = [];
    S.held = S.held.filter((d) => d !== dir);
    S.held.push(dir);
    const b = el.dpad.querySelector(`[data-dir="${dir}"]`);
    if (b) b.classList.add('down');
}
function release(dir) {
    S.held = S.held.filter((d) => d !== dir);
    const b = el.dpad.querySelector(`[data-dir="${dir}"]`);
    if (b) b.classList.remove('down');
}

function tryStep(dir) {
    const p = S.player;
    if (p.moving || S.phase !== 'play') return false;
    const [dx, dy] = DIRS[dir];
    p.dir = dir;
    const nx = p.x + dx, ny = p.y + dy;
    const t = tileAt(S.map, nx, ny);
    if (isWalkable(t)) {
        timerStart();
        p.moving = { fromX: p.x, fromY: p.y, toX: nx, toY: ny, t0: now() };
        return true;
    }
    if (t === T.STALL) {
        const idx = S.map.stalls.findIndex((s) => s.x === nx && s.y === ny);
        if (idx >= 0 && S.bumpLock !== 'stall' + idx) openStall(idx);
        return false;
    }
    if (t === T.SHIP) {
        if (S.bumpLock !== 'ship') tryBoard();
        return false;
    }
    return false;
}

function updateMovement() {
    const p = S.player;
    if (p.moving) {
        const k = Math.min(1, (now() - p.moving.t0) / MOVE_MS);
        p.fx = p.moving.fromX + (p.moving.toX - p.moving.fromX) * k;
        p.fy = p.moving.fromY + (p.moving.toY - p.moving.fromY) * k;
        if (k >= 1) {
            p.x = p.moving.toX; p.y = p.moving.toY; p.fx = p.x; p.fy = p.y;
            p.moving = null;
            S.steps++;
            S.bumpLock = null;
        }
        return;
    }
    if (S.phase !== 'play') return;
    if (S.path.length) {
        const n = S.path[0];
        const dir = n.x > p.x ? 'right' : n.x < p.x ? 'left' : n.y > p.y ? 'down' : 'up';
        S.path.shift();
        const moved = tryStep(dir);
        if (!moved) S.path = [];          // bumped something or blocked
        return;
    }
    if (S.held.length) tryStep(S.held[S.held.length - 1]);
}

function tapTile(tx, ty) {
    if (S.phase !== 'play') return;
    if (tx < 0 || ty < 0 || tx >= S.map.w || ty >= S.map.h) return;
    const t = tileAt(S.map, tx, ty);
    if (t === T.BUILDING || t === T.WATER) { toast('走不過去 Can\'t walk there'); return; }
    const target = t === T.SHIP ? S.map.ship.gangway : { x: tx, y: ty };
    const from = S.player.moving ? { x: S.player.moving.toX, y: S.player.moving.toY } : { x: S.player.x, y: S.player.y };
    const path = findPath(S.map, from, target);
    if (!path.length) { toast('走不過去 Can\'t walk there'); return; }
    S.held = [];
    S.path = path;
}

// ---------- townspeople ----------
function spawnNpcs(map) {
    const rand = rng((map.seed + 9001) >>> 0);
    const taken = new Set([key(map.start.x, map.start.y), key(map.ship.dock.x, map.ship.dock.y)]);
    for (const s of map.stalls) taken.add(key(s.face.x, s.face.y));
    const cand = [];
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
        if (isWalkable(map.tiles[y * map.w + x]) && !taken.has(key(x, y))) cand.push({ x, y });
    }
    const npcs = [];
    for (let i = 0; i < 5 && cand.length; i++) {
        const c = cand.splice(Math.floor(rand() * cand.length), 1)[0];
        const pal = NPC_PALS[Math.floor(rand() * NPC_PALS.length)];
        npcs.push({
            x: c.x, y: c.y, fx: c.x, fy: c.y, dir: ['up', 'down', 'left', 'right'][Math.floor(rand() * 4)],
            moving: null, wait: 300 + rand() * 1500, chat: false, pal, rand: rng((map.seed + 31 * (i + 1)) >>> 0),
        });
    }
    return npcs;
}
function key(x, y) { return y * 64 + x; }

function updateNpcs(time, dt) {
    if (S.reduceMotion || S.phase === 'intro' || S.phase === 'end') return;
    const p = S.player;
    const occupied = new Set([key(p.x, p.y)]);
    if (p.moving) occupied.add(key(p.moving.toX, p.moving.toY));
    for (const n of S.npcs) { occupied.add(key(n.x, n.y)); if (n.moving) occupied.add(key(n.moving.toX, n.moving.toY)); }
    for (const n of S.npcs) {
        if (n.moving) {
            const k = Math.min(1, (time - n.moving.t0) / NPC_MS);
            n.fx = n.moving.fromX + (n.moving.toX - n.moving.fromX) * k;
            n.fy = n.moving.fromY + (n.moving.toY - n.moving.fromY) * k;
            if (k >= 1) {
                n.x = n.moving.toX; n.y = n.moving.toY; n.fx = n.x; n.fy = n.y; n.moving = null;
                n.wait = 400 + n.rand() * 1800; n.chat = n.rand() < 0.3;
            }
            continue;
        }
        n.wait -= dt;
        if (n.wait > 0) continue;
        const dirs = Object.keys(DIRS).sort(() => n.rand() - 0.5);
        let done = false;
        for (const dir of dirs) {
            const [dx, dy] = DIRS[dir];
            const nx = n.x + dx, ny = n.y + dy;
            if (!isWalkable(tileAt(S.map, nx, ny)) || occupied.has(key(nx, ny))) continue;
            n.dir = dir;
            if (n.rand() < 0.3) { n.wait = 500 + n.rand() * 800; n.chat = false; }
            else { n.moving = { fromX: n.x, fromY: n.y, toX: nx, toY: ny, t0: time }; occupied.add(key(nx, ny)); n.chat = false; }
            done = true;
            break;
        }
        if (!done) n.wait = 800;
    }
}

function spawnGulls(map) {
    const rand = rng((map.seed + 777) >>> 0);
    const out = [];
    for (let i = 0; i < 3; i++) {
        out.push({ cx: (LAYOUT.SHIP_X0 + 1.5) * TILE + rand() * 40, cy: (2 + rand() * 10) * TILE, r: 30 + rand() * 40, a: rand() * Math.PI * 2, speed: 0.4 + rand() * 0.4, flap: rand() * 10 });
    }
    return out;
}
function updateGulls(dt) {
    if (S.reduceMotion) return;
    for (const g of S.gulls) { g.a += dt / 1000 * g.speed; g.flap += dt / 1000 * 9; }
}

// ---------- stalls, tokens, ship ----------
function openStall(idx) {
    const stall = S.map.stalls[idx];
    const vendor = S.vendors[stall.content];
    S.phase = 'dialog';
    S.path = [];
    S.held = [];
    timerPause();
    S.dialog = { vendor, stallIdx: idx, line: 0, shown: 0, t0: now() };
    el.dlgWho.textContent = vendor.name;
    el.dlgPortrait.src = `assets/vendor${stall.content}.webp`;
    el.dlgPortrait.alt = vendor.name;
    el.dialog.hidden = false;
    renderDialogLine();
}

function renderDialogLine() {
    const d = S.dialog;
    const text = d.vendor.lines[d.line] || '';
    const last = d.line >= d.vendor.lines.length - 1;
    const got = S.tokens.has(S.map.stalls[d.stallIdx].content);
    el.dlgLine.textContent = S.reduceMotion ? text : text.slice(0, d.shown);
    el.dlgNext.textContent = last ? (got ? '點一下離開 Tap to leave' : '點一下收下紀念幣 Tap to take the token') : '點一下繼續 Tap to continue';
}

function advanceDialog() {
    const d = S.dialog;
    if (!d) return;
    const text = d.vendor.lines[d.line] || '';
    if (!S.reduceMotion && d.shown < text.length) { d.shown = text.length; renderDialogLine(); return; }
    if (d.line < d.vendor.lines.length - 1) { d.line++; d.shown = 0; d.t0 = now(); renderDialogLine(); return; }
    closeDialog();
}

function closeDialog() {
    const d = S.dialog;
    const stall = S.map.stalls[d.stallIdx];
    if (!S.tokens.has(stall.content)) {
        S.tokens.add(stall.content);
        S.score.reachStop();
        renderTokens();
        const n = S.tokens.size;
        toast(n === 4 ? '集滿了！去船上 All four, go to the ship' : `紀念幣 ${n}/4 Token ${n}/4`);
    }
    S.bumpLock = 'stall' + d.stallIdx;
    S.dialog = null;
    el.dialog.hidden = true;
    timerResume();
    S.phase = 'play';
}

function tryBoard() {
    const missing = 4 - S.tokens.size;
    if (missing > 0) {
        toast(`還缺 ${missing} 枚紀念幣 Need ${missing} more token${missing > 1 ? 's' : ''}`);
        S.bumpLock = 'ship';
        return;
    }
    finishRound();
}

function finishRound() {
    S.phase = 'end';
    timerStop();
    S.held = [];
    S.path = [];
    S.score.reachStop();                               // boarding counts as the fifth stop
    const seconds = elapsedMs() / 1000;
    const timeBonus = Math.max(0, 2000 - Math.floor(seconds) * 10);
    const points = S.score.get().points + timeBonus;
    const run = { game: GAME, tourId: String(TOUR_ID), seed: S.seed, points, seconds: Math.round(seconds * 10) / 10, tokens: 4, steps: S.steps };
    saveRun(run);
    const best = loadRuns().filter((r) => r.game === GAME).reduce((m, r) => Math.max(m, Number(r.points) || 0), 0);
    el.endPoints.textContent = String(points);
    el.endDetail.textContent = `時間 ${run.seconds} 秒・${S.steps} 步・時間加分 ${timeBonus}　Time ${run.seconds} s, ${S.steps} steps, time bonus ${timeBonus}`;
    el.endBest.textContent = `本機最佳 Best on this device: ${best}`;
    el.end.hidden = false;
}

// ---------- stop card ----------
function fillCard() {
    const day = S.day, stop = S.stop, lv = S.level;
    el.cardStop.textContent = stop ? stop.name : day.title;
    el.cardDay.textContent = `第 ${day.day} 天 Day ${day.day}・${day.title}`;
    el.cardTour.textContent = `${lv.name}　${lv.dateFull}`;
    if (S.price) {
        el.cardPrice.innerHTML = '';
        const label = document.createTextNode((S.price.optionName ? S.price.optionName + '　' : '') + '價格 Price ');
        const b = document.createElement('b');
        b.textContent = String(S.price.price);
        el.cardPrice.append(label, b);
    } else {
        el.cardPrice.textContent = '';
    }
    const img = day.image ? SITE + day.image : null;
    el.cardImg.alt = day.title;
    el.cardImg.onerror = () => { el.cardImg.onerror = null; el.cardImg.src = `${SITE}/assets/pdfs/${TOUR_ID}/cover.jpg`; };
    if (img) el.cardImg.src = img;
    el.see.href = lv.tourUrl ? SITE + lv.tourUrl : SITE;
}

// ---------- HUD ----------
function renderTokens() {
    const dots = el.tokens.querySelectorAll('i');
    dots.forEach((d, i) => d.classList.toggle('got', S.tokens.has(i)));
}
function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    S.toastT = now();
}

// =====================================================================
// Drawing
// =====================================================================

/** Seeded, position-stable noise in [0,1): the same tile looks the same every frame and every day with this seed. */
function hash(x, y, k) {
    let n = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(k | 0, 1274126177) + Math.imul(S.map.seed | 0, 97);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Rounded rect path with arcTo: ctx.roundRect needs Safari 16.4. */
function rr(c, x, y, w, h, r) {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}
function ellipse(c, x, y, rx, ry) { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fill(); }

// Building styles: a Victorian port street, red brick, stucco, stone, a
// timber-framed pub. One style per span of 2-4 facades, seeded.
const STYLES = [
    { kind: 'brick', wall: '#9c4b3b', wall2: '#7c3a2e', trim: '#ead9bf', roof: '#4f5a6b', roofL: '#63708a', roof2: '#3a4452' },
    { kind: 'timber', wall: '#e8dcc0', wall2: '#d2c3a0', trim: '#4a3220', roof: '#6d5047', roofL: '#866458', roof2: '#4f3a33' },
    { kind: 'stone', wall: '#8e8c84', wall2: '#75736c', trim: '#dcd7cb', roof: '#59626f', roofL: '#6f7a8a', roof2: '#424b57' },
    { kind: 'brick', wall: '#b45f49', wall2: '#95493a', trim: '#f3e7d0', roof: '#5a5464', roofL: '#71697e', roof2: '#443f4e' },
    { kind: 'stucco', wall: '#d8c7a2', wall2: '#bfae8a', trim: '#3e4e6a', roof: '#4f5f5b', roofL: '#657772', roof2: '#3b4845' },
];
const AWNINGS = [['#d9442f', '#f4efe2'], ['#2f5f9a', '#f4efe2'], ['#3f7a4a', '#f4efe2'], ['#c9352c', '#f6e7b8']];
const VENDOR_PALS = [
    { coat: '#6b4a2a', coat2: '#4a3220', pants: '#3a3a4a', skin: '#f0c9a0', hair: '#4a2e1a', hat: '#3a3f4a' },
    { coat: '#2a2a2e', coat2: '#1a1a1e', pants: '#2a2a3a', skin: '#f0c9a0', hair: '#2a1a10', hat: null },
    { coat: '#1f2f4a', coat2: '#15223a', pants: '#1f2f4a', skin: '#e8c4a0', hair: '#9a9a9a', hat: '#1f2f4a' },
    { coat: '#e8dcc4', coat2: '#b84a3a', pants: '#5a4a3a', skin: '#f0c9a0', hair: '#5a3a2a', hat: null },
];
const PLAYER_PAL = { coat: '#2d5d8f', coat2: '#1f4468', pants: '#3a3a4a', skin: '#f0c9a0', hair: '#3a2a1a', hat: '#c23b2a' };
const NPC_PALS = [
    { coat: '#7a3b3b', coat2: '#5a2a2a', pants: '#2f2f3a', skin: '#f0c9a0', hair: '#2a1a10', hat: null },
    { coat: '#3b5a7a', coat2: '#2a4058', pants: '#3a3a4a', skin: '#e8c4a0', hair: '#d9b36a', hat: '#2f2f3a' },
    { coat: '#5a6b3b', coat2: '#42502a', pants: '#4a3a2a', skin: '#c99a6a', hair: '#1a1a1a', hat: null },
    { coat: '#6b4a7a', coat2: '#50365c', pants: '#2f2f3a', skin: '#f0c9a0', hair: '#7a3a1a', hat: null },
    { coat: '#8a6a3a', coat2: '#6a4f2a', pants: '#3a3a4a', skin: '#e8c4a0', hair: '#4a2e1a', hat: '#5a3a1a' },
    { coat: '#e2d7c3', coat2: '#b8a98f', pants: '#5a4a3a', skin: '#f0c9a0', hair: '#8a8a8a', hat: null },
];

/** Building spans, lamp posts and lit windows for one map. Seeded, so a day always looks the same. */
function buildDecor(map) {
    const rand = rng((map.seed + 4242) >>> 0);
    const L = LAYOUT;
    const spansFor = () => {
        const out = [];
        let x = 0;
        while (x <= L.QUAY_X) {
            const w = 2 + Math.floor(rand() * 3);
            out.push({ x0: x, x1: Math.min(L.QUAY_X, x + w - 1), style: STYLES[Math.floor(rand() * STYLES.length)] });
            x += w;
        }
        return out;
    };
    const top = spansFor(), bottom = spansFor();
    const spanAt = (x, y) => (y < L.STREET_TOP ? top : bottom).find((s) => x >= s.x0 && x <= s.x1) || top[0];

    // Lamp posts: three on each side of the main street, never in an alley
    // mouth, two more along the quay. Base point is where the post meets the ground.
    const alleyCols = new Set(map.stalls.map((s) => s.x));
    const lamps = [];
    const place = (cols, y) => {
        for (let c of cols) {
            if (alleyCols.has(c)) c += 1;
            if (c > L.STREET_X1) c -= 2;
            lamps.push({ x: c * TILE + 16, y, side: y < (L.STREET_TOP + 1) * TILE ? 'top' : 'bottom' });
        }
    };
    const j = rand() < 0.5 ? 0 : 1;
    place([2 + j, 7 + j, 12 + j].map((c) => Math.min(c, L.STREET_X1)), L.STREET_TOP * TILE + 10);
    place([4 + j, 9 + j, 13 + j].map((c) => Math.min(c, L.STREET_X1)), L.STREET_BOT * TILE + 29);
    lamps.push({ x: L.QUAY_X * TILE + 9, y: 4 * TILE + 28, side: 'quay' });
    lamps.push({ x: L.QUAY_X * TILE + 9, y: 11 * TILE + 28, side: 'quay' });
    return { top, bottom, spanAt, lamps, windows: [] };
}

function renderStatic(map) {
    const off = document.createElement('canvas');
    off.width = WORLD_W; off.height = WORLD_H;
    const c = off.getContext('2d');
    S.decor.windows = [];
    for (let y = 0; y < map.h; y++) {
        for (let x = 0; x < map.w; x++) {
            const t = map.tiles[y * map.w + x];
            const px = x * TILE, py = y * TILE;
            c.save(); c.beginPath(); c.rect(px, py, TILE, TILE); c.clip();
            if (t === T.WATER || t === T.SHIP) drawWaterBase(c, px, py, x, y);
            else if (t === T.STREET || t === T.STALL) drawCobbles(c, px, py, x, y);
            else if (t === T.QUAY) drawQuay(c, px, py, x, y);
            else drawBuildingTile(c, map, x, y);
            c.restore();
        }
    }
    // Shadows cast by the buildings onto the ground beside them, and kerbs.
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
        const t = map.tiles[y * map.w + x];
        if (isWalkable(t) || t === T.STALL) drawEdges(c, map, x, y);
    }
    drawQuayFurniture(c, map);
    return off;
}

function drawCobbles(c, px, py, x, y) {
    c.fillStyle = '#3f3b45'; c.fillRect(px, py, TILE, TILE);          // grout
    for (let r = 0; r < 4; r++) {
        const offx = (r % 2) * 4;
        for (let k = -1; k < 4; k++) {
            const sx = px + offx + k * 8, sy = py + r * 8;
            const v = hash(x * 4 + k, y * 4 + r, 1);
            const l = 38 + Math.floor(v * 14);
            const hue = 220 + Math.floor(hash(x * 4 + k, y * 4 + r, 2) * 30);
            c.fillStyle = `hsl(${hue} 9% ${l}%)`;
            rr(c, sx + 1, sy + 1, 7, 6, 2); c.fill();
            c.fillStyle = 'rgba(255,255,255,0.09)'; c.fillRect(sx + 2, sy + 1, 5, 1);
        }
    }
    const v = hash(x, y, 3);
    if (v < 0.07) {                                                    // a tuft of grass between the stones
        c.fillStyle = '#5f8a3c';
        const gx = px + 6 + Math.floor(hash(x, y, 4) * 18), gy = py + 6 + Math.floor(hash(x, y, 5) * 18);
        c.fillRect(gx, gy, 2, 4); c.fillRect(gx + 3, gy - 2, 2, 6); c.fillRect(gx + 6, gy + 1, 2, 3);
    } else if (v > 0.95) {                                             // a puddle
        c.fillStyle = 'rgba(140,170,210,0.28)';
        ellipse(c, px + 16, py + 18, 9, 4);
        c.fillStyle = 'rgba(255,255,255,0.18)'; c.fillRect(px + 12, py + 16, 5, 1);
    }
}

function drawQuay(c, px, py, x, y) {
    c.fillStyle = '#6f675c'; c.fillRect(px, py, TILE, TILE);
    for (let r = 0; r < 2; r++) for (let k = 0; k < 2; k++) {
        const v = hash(x * 2 + k, y * 2 + r, 6);
        c.fillStyle = `hsl(35 9% ${44 + Math.floor(v * 8)}%)`;
        c.fillRect(px + k * 16 + 1, py + r * 16 + 1, 14, 14);
        c.fillStyle = 'rgba(255,255,255,0.07)'; c.fillRect(px + k * 16 + 1, py + r * 16 + 1, 14, 1);
    }
    // the quay edge, stone lip then the drop into the water
    c.fillStyle = '#8a8276'; c.fillRect(px + TILE - 4, py, 2, TILE);
    c.fillStyle = '#2d2a2a'; c.fillRect(px + TILE - 2, py, 2, TILE);
}

function drawQuayFurniture(c, map) {
    const qx = LAYOUT.QUAY_X;
    const posts = [];
    for (let y = 0; y < map.h; y++) {
        if (map.tiles[y * map.w + qx] !== T.QUAY) continue;
        const px = qx * TILE, py = y * TILE;
        if (y % 2 === 1) {
            posts.push({ x: px + TILE - 9, y: py + 16 });
        }
        const v = hash(qx, y, 7);
        if (v < 0.22) {                                                // a crate
            c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(px + 4, py + 11, 12, 9);
            c.fillStyle = '#8a6a3f'; c.fillRect(px + 3, py + 8, 12, 10);
            c.fillStyle = '#5c4730'; c.fillRect(px + 3, py + 12, 12, 1); c.fillRect(px + 8, py + 8, 1, 10);
        } else if (v > 0.84) {                                         // a barrel
            c.fillStyle = 'rgba(0,0,0,0.25)'; ellipse(c, px + 10, py + 22, 6, 3);
            c.fillStyle = '#6b4a2a'; ellipse(c, px + 9, py + 17, 5, 6);
            c.fillStyle = '#3a2a1a'; c.fillRect(px + 4, py + 14, 10, 1); c.fillRect(px + 4, py + 20, 10, 1);
            c.fillStyle = '#8a6a3f'; ellipse(c, px + 9, py + 12, 4, 2);
        }
    }
    // mooring rope sagging between bollards
    c.strokeStyle = '#b9a98a'; c.lineWidth = 1.5;
    for (let i = 0; i + 1 < posts.length; i++) {
        const a = posts[i], b = posts[i + 1];
        c.beginPath(); c.moveTo(a.x, a.y); c.quadraticCurveTo((a.x + b.x) / 2 + 6, (a.y + b.y) / 2, b.x, b.y); c.stroke();
    }
    for (const p of posts) {
        c.fillStyle = 'rgba(0,0,0,0.3)'; ellipse(c, p.x + 1, p.y + 3, 5, 2);
        c.fillStyle = '#2b2f36'; ellipse(c, p.x, p.y, 4, 4);
        c.fillStyle = '#4a515c'; ellipse(c, p.x, p.y - 1, 3, 2);
    }
}

function drawWaterBase(c, px, py, x, y) {
    const l = 23 + Math.floor(hash(x, y, 8) * 5);
    c.fillStyle = `hsl(204 52% ${l}%)`; c.fillRect(px, py, TILE, TILE);
    c.fillStyle = 'rgba(0,0,0,0.08)';
    for (let r = 0; r < 4; r++) if (hash(x, y * 4 + r, 9) < 0.5) c.fillRect(px, py + r * 8 + 3, TILE, 2);
}

function drawBuildingTile(c, map, x, y) {
    const px = x * TILE, py = y * TILE;
    const below = tileAt(map, x, y + 1);
    const st = S.decor.spanAt(x, y).style;
    if (y + 1 < map.h && (isWalkable(below) || below === T.STALL)) drawWall(c, px, py, x, y, st);
    else drawRoof(c, px, py, x, y, st, map);
}

function drawWall(c, px, py, x, y, st) {
    // eave: a strip of roof, then its shadow on the wall
    c.fillStyle = st.roof2; c.fillRect(px, py, TILE, 5);
    c.fillStyle = st.roofL; c.fillRect(px, py, TILE, 1);
    c.fillStyle = st.wall; c.fillRect(px, py + 5, TILE, TILE - 5);
    c.fillStyle = 'rgba(0,0,0,0.28)'; c.fillRect(px, py + 5, TILE, 3);
    if (st.kind === 'brick') {
        c.fillStyle = st.wall2;
        for (let r = 0; r < 6; r++) {
            c.fillRect(px, py + 8 + r * 4 + 3, TILE, 1);
            const o = (r % 2) * 4;
            for (let k = 0; k < 4; k++) c.fillRect(px + o + k * 8 + 7, py + 8 + r * 4, 1, 3);
        }
    } else if (st.kind === 'stone') {
        c.fillStyle = st.wall2;
        for (let r = 0; r < 4; r++) {
            c.fillRect(px, py + 8 + r * 6 + 5, TILE, 1);
            const o = (r % 2) * 5;
            for (let k = 0; k < 4; k++) c.fillRect(px + o + k * 10 + 9, py + 8 + r * 6, 1, 5);
        }
    } else if (st.kind === 'timber') {
        c.fillStyle = st.trim;
        c.fillRect(px, py + 8, TILE, 2); c.fillRect(px, py + TILE - 2, TILE, 2);
        c.fillRect(px, py + 8, 2, TILE - 8); c.fillRect(px + TILE - 2, py + 8, 2, TILE - 8);
        c.fillRect(px + 15, py + 8, 2, 12);
        c.strokeStyle = st.trim; c.lineWidth = 2;
        c.beginPath(); c.moveTo(px + 2, py + 20); c.lineTo(px + 14, py + 9); c.stroke();
        c.beginPath(); c.moveTo(px + 30, py + 20); c.lineTo(px + 18, py + 9); c.stroke();
    } else {
        c.fillStyle = 'rgba(255,255,255,0.08)'; c.fillRect(px + 3, py + 9, 10, 6);
        c.fillStyle = 'rgba(0,0,0,0.06)'; c.fillRect(px + 18, py + 20, 12, 8);
    }
    // two windows, warm or dark
    const lit1 = hash(x, y, 10) < 0.6, lit2 = hash(x, y, 11) < 0.6;
    drawWindow(c, px + 5, py + 10, lit1, st);
    drawWindow(c, px + 19, py + 10, lit2, st);
    if (lit1) S.decor.windows.push({ x: px + 9, y: py + 15 });
    if (lit2) S.decor.windows.push({ x: px + 23, y: py + 15 });
    // door or flower boxes
    if (hash(x, y, 12) < 0.24) {
        c.fillStyle = st.trim; c.fillRect(px + 11, py + 19, 11, 13);
        c.fillStyle = '#3b2a1e'; c.fillRect(px + 12, py + 20, 9, 12);
        c.fillStyle = '#e8b75a'; c.fillRect(px + 19, py + 26, 1, 1);
        c.fillStyle = '#8f877c'; c.fillRect(px + 10, py + 31, 13, 1);   // step
    } else {
        drawFlowerBox(c, px + 4, py + 20, x, y, 13);
        if (hash(x, y, 14) < 0.5) drawFlowerBox(c, px + 18, py + 20, x + 100, y, 15);
    }
    // the odd hanging sign
    if (hash(x, y, 16) < 0.16) {
        c.fillStyle = '#2a2320'; c.fillRect(px + 27, py + 8, 1, 6);
        c.fillStyle = hash(x, y, 17) < 0.5 ? '#2f5f9a' : '#7a3b3b'; c.fillRect(px + 23, py + 13, 9, 7);
        c.fillStyle = '#e8dcc4'; c.fillRect(px + 25, py + 15, 5, 3);
    }
}

function drawWindow(c, wx, wy, lit, st) {
    c.fillStyle = st.trim; c.fillRect(wx - 1, wy - 1, 10, 10);
    c.fillStyle = lit ? '#f6cf7a' : '#28283a'; c.fillRect(wx, wy, 8, 8);
    if (lit) { c.fillStyle = '#fff1c2'; c.fillRect(wx + 1, wy + 1, 3, 3); }
    c.fillStyle = st.trim; c.fillRect(wx + 3, wy, 1, 8); c.fillRect(wx, wy + 3, 8, 1);
}

function drawFlowerBox(c, bx, by, x, y, k) {
    c.fillStyle = '#5a3d25'; c.fillRect(bx, by + 3, 10, 4);
    c.fillStyle = '#3f6b2e'; c.fillRect(bx + 1, by + 1, 8, 3);
    const cols = ['#e04a5a', '#f2b544', '#f27ab0', '#f6f0d8'];
    for (let i = 0; i < 4; i++) {
        c.fillStyle = cols[Math.floor(hash(x + i, y, k) * cols.length)];
        c.fillRect(bx + 1 + i * 2 + (i % 2), by + (i % 2 ? 1 : 0), 2, 2);
    }
}

/**
 * Where this roof tile sits in its column of building: the rows above and
 * below it up to the next street (the wall row at the bottom, if any, is
 * not roof). A block of n roof rows gets a ridge in the middle, a darker
 * back slope above it and a lit front slope below, which is what makes a
 * mass of roofs read as houses instead of a colour field.
 */
function roofInfo(map, x, y) {
    const solid = (t) => t === T.BUILDING;
    let up = 0; while (y - up - 1 >= 0 && solid(tileAt(map, x, y - up - 1))) up++;
    let down = 0; while (y + down + 1 < map.h && solid(tileAt(map, x, y + down + 1))) down++;
    const bottomRow = y + down;
    const under = bottomRow + 1 < map.h ? tileAt(map, x, bottomRow + 1) : T.BUILDING;
    const wallAtBottom = isWalkable(under) || under === T.STALL;
    const total = up + down + 1 - (wallAtBottom ? 1 : 0);
    const ridge = Math.max(0, Math.floor((total - 1) / 2));
    return { pos: up, total, ridge, slope: up < ridge ? 'back' : up === ridge ? 'ridge' : 'front' };
}

function drawRoof(c, px, py, x, y, st, map) {
    const ri = roofInfo(map, x, y);
    const sp = S.decor.spanAt(x, y);
    c.fillStyle = st.roof; c.fillRect(px, py, TILE, TILE);
    for (let r = 0; r < 8; r++) {
        const o = (r % 2) * 4;
        for (let k = -1; k < 4; k++) {
            const v = hash(x * 4 + k, y * 8 + r, 18);
            c.fillStyle = v < 0.3 ? st.roofL : v > 0.9 ? st.roof2 : st.roof;
            c.fillRect(px + o + k * 8 + 1, py + r * 4, 7, 3);
        }
    }
    c.fillStyle = 'rgba(0,0,0,0.2)';
    for (let r = 0; r < 8; r++) c.fillRect(px, py + r * 4 + 3, TILE, 1);
    // slope shading
    if (ri.slope === 'back') { c.fillStyle = 'rgba(10,10,30,0.26)'; c.fillRect(px, py, TILE, TILE); }
    else if (ri.slope === 'front') { c.fillStyle = 'rgba(255,230,190,0.07)'; c.fillRect(px, py, TILE, TILE); }
    if (ri.slope === 'ridge') {
        c.fillStyle = 'rgba(10,10,30,0.26)'; c.fillRect(px, py, TILE, 14);           // back slope up to the ridge
        c.fillStyle = st.roof2; c.fillRect(px, py + 13, TILE, 3);
        c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(px, py + 14, TILE, 1);   // the ridge itself
        if (hash(x, y, 19) < 0.3) {                                                  // chimney on the ridge
            c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(px + 21, py + 7, 9, 12);
            c.fillStyle = '#6b3a2e'; c.fillRect(px + 19, py + 6, 9, 11);
            c.fillStyle = '#8a4a3a'; c.fillRect(px + 19, py + 6, 9, 1); c.fillRect(px + 23, py + 6, 1, 11);
            c.fillStyle = '#2e2424'; c.fillRect(px + 18, py + 3, 11, 4);
        }
    }
    if (ri.pos === 0) {                                                              // far eave of the block
        c.fillStyle = 'rgba(0,0,0,0.45)'; c.fillRect(px, py, TILE, 2);
        c.fillStyle = 'rgba(255,255,255,0.12)'; c.fillRect(px, py + 2, TILE, 1);
    }
    if (ri.slope === 'front' && ri.pos === ri.ridge + 1 && hash(x, y, 23) < 0.38) {  // a dormer on the front slope
        c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(px + 9, py + 8, 15, 15);
        c.fillStyle = st.trim; c.fillRect(px + 8, py + 8, 15, 13);
        c.fillStyle = st.roof2; c.fillRect(px + 7, py + 5, 17, 4);
        c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(px + 7, py + 5, 17, 1);
        const lit = hash(x, y, 24) < 0.6;
        c.fillStyle = lit ? '#f6cf7a' : '#28283a'; c.fillRect(px + 12, py + 11, 7, 7);
        c.fillStyle = st.trim; c.fillRect(px + 15, py + 11, 1, 7); c.fillRect(px + 12, py + 14, 7, 1);
        if (lit) S.decor.windows.push({ x: px + 15, y: py + 14 });
    } else if (ri.slope !== 'ridge' && hash(x, y, 20) < 0.1) {                       // moss
        c.fillStyle = 'rgba(90,140,70,0.35)'; ellipse(c, px + 10 + hash(x, y, 21) * 12, py + 10 + hash(x, y, 22) * 12, 5, 3);
    }
    // the gap between two houses
    if (x === sp.x1 && tileAt(map, x + 1, y) === T.BUILDING) {
        c.fillStyle = 'rgba(0,0,0,0.5)'; c.fillRect(px + TILE - 2, py, 2, TILE);
    }
}

function drawEdges(c, map, x, y) {
    const px = x * TILE, py = y * TILE;
    const solid = (t) => t === T.BUILDING || t === T.STALL;
    const above = tileAt(map, x, y - 1), left = tileAt(map, x - 1, y), right = tileAt(map, x + 1, y);
    if (solid(above) && y > 0) {
        c.fillStyle = '#8f877c'; c.fillRect(px, py, TILE, 2);          // kerb
        const g = c.createLinearGradient(0, py, 0, py + 11);
        g.addColorStop(0, 'rgba(0,0,0,0.42)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(px, py, TILE, 11);
    }
    if (solid(left) && x > 0) {
        const g = c.createLinearGradient(px, 0, px + 7, 0);
        g.addColorStop(0, 'rgba(0,0,0,0.32)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(px, py, 7, TILE);
    }
    if (solid(right) && x < map.w - 1) {
        const g = c.createLinearGradient(px + TILE - 5, 0, px + TILE, 0);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.22)');
        c.fillStyle = g; c.fillRect(px + TILE - 5, py, 5, TILE);
    }
}

/** Dusk light: a cool base multiplied over the frame, warm pools under the lamps, stalls and windows. */
function renderLight(map) {
    const off = document.createElement('canvas');
    off.width = WORLD_W; off.height = WORLD_H;
    const c = off.getContext('2d');
    c.fillStyle = '#ddd4d6'; c.fillRect(0, 0, WORLD_W, WORLD_H);
    c.globalCompositeOperation = 'lighter';
    const pool = (x, y, r, inner, mid) => {
        const g = c.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, inner); g.addColorStop(0.4, mid); g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g; c.fillRect(x - r, y - r, r * 2, r * 2);
    };
    for (const l of S.decor.lamps) pool(l.x, l.y - 34, 105, 'rgba(255,225,170,0.95)', 'rgba(255,190,120,0.4)');
    for (const w of S.decor.windows) pool(w.x, w.y + 6, 20, 'rgba(255,200,120,0.5)', 'rgba(255,180,100,0.18)');
    for (const s of map.stalls) pool(s.x * TILE + 16, s.y * TILE + 16, 46, 'rgba(255,215,150,0.6)', 'rgba(255,190,120,0.25)');
    const sh = map.ship;
    pool((sh.x0 + sh.x1 + 1) * TILE / 2, (sh.y0 + sh.y1 + 1) * TILE / 2, 80, 'rgba(210,225,255,0.55)', 'rgba(180,200,255,0.2)');
    return off;
}

// ---------- sprites (drawn each frame, sorted by their feet) ----------

/** A 16-bit townsperson. cx: centre x; baseY: the feet. step: -1/0/1 leg phase. */
function drawChar(c, cx, baseY, dir, step, pal) {
    c.fillStyle = 'rgba(0,0,0,0.32)'; ellipse(c, cx, baseY, 8, 3);
    c.fillStyle = pal.pants;
    c.fillRect(cx - 5, baseY - 7 + (step > 0 ? 1 : 0), 4, 7 - (step > 0 ? 1 : 0));
    c.fillRect(cx + 1, baseY - 7 + (step < 0 ? 1 : 0), 4, 7 - (step < 0 ? 1 : 0));
    c.fillStyle = '#2a2320'; c.fillRect(cx - 5, baseY - 2, 4, 2); c.fillRect(cx + 1, baseY - 2, 4, 2);
    c.fillStyle = pal.coat; c.fillRect(cx - 7, baseY - 17, 14, 11);
    c.fillStyle = pal.coat2; c.fillRect(cx - 7, baseY - 17, 14, 2); c.fillRect(cx - 1, baseY - 15, 2, 9);
    c.fillStyle = pal.coat; c.fillRect(cx - 9, baseY - 16, 2, 8); c.fillRect(cx + 7, baseY - 16, 2, 8);
    c.fillStyle = pal.skin; c.fillRect(cx - 9, baseY - 9, 2, 2); c.fillRect(cx + 7, baseY - 9, 2, 2);
    c.fillStyle = pal.skin; c.fillRect(cx - 5, baseY - 27, 10, 10);
    c.fillStyle = pal.hair; c.fillRect(cx - 5, baseY - 28, 10, 4);
    if (dir === 'up') c.fillRect(cx - 5, baseY - 28, 10, 9);
    if (pal.hat) { c.fillStyle = pal.hat; c.fillRect(cx - 6, baseY - 30, 12, 3); c.fillRect(cx - 4, baseY - 32, 8, 3); }
    if (dir !== 'up') {
        c.fillStyle = '#222';
        const ex = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
        if (dir !== 'right') c.fillRect(cx - 3 + ex, baseY - 23, 2, 2);
        if (dir !== 'left') c.fillRect(cx + 1 + ex, baseY - 23, 2, 2);
    }
}

function drawBubble(c, cx, y, text) {
    c.fillStyle = '#fff'; rr(c, cx - 9, y - 7, 18, 12, 4); c.fill();
    c.beginPath(); c.moveTo(cx - 3, y + 5); c.lineTo(cx + 3, y + 5); c.lineTo(cx, y + 8); c.closePath(); c.fill();
    c.fillStyle = '#333'; c.font = 'bold 10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(text, cx, y - 1);
}

function drawLamp(c, l, time) {
    c.fillStyle = 'rgba(0,0,0,0.3)'; ellipse(c, l.x + 1, l.y, 5, 2);
    c.fillStyle = '#23262c'; c.fillRect(l.x - 3, l.y - 4, 7, 4);
    c.fillRect(l.x - 1, l.y - 32, 3, 29);
    c.fillStyle = '#3a3f47'; c.fillRect(l.x - 1, l.y - 32, 1, 29);
    c.fillStyle = '#23262c'; c.fillRect(l.x - 5, l.y - 44, 11, 13);
    const flick = S.reduceMotion ? 1 : 0.92 + 0.08 * Math.sin(time / 97 + l.x);
    c.fillStyle = `rgba(255,${Math.floor(205 * flick)},${Math.floor(110 * flick)},1)`; c.fillRect(l.x - 4, l.y - 43, 9, 11);
    c.fillStyle = '#fff6d8'; c.fillRect(l.x - 2, l.y - 41, 5, 7);
    c.fillStyle = '#23262c'; c.fillRect(l.x - 6, l.y - 46, 13, 3); c.fillRect(l.x - 1, l.y - 48, 3, 2);
}

function drawGoods(c, px, py, content) {
    if (content === 0) {                                               // fish on ice
        c.fillStyle = '#dfe9f2'; c.fillRect(px + 5, py, 22, 6);
        c.fillStyle = '#8fb0c8'; c.fillRect(px + 7, py + 1, 7, 3); c.fillRect(px + 17, py + 2, 7, 3);
        c.fillStyle = '#5a7a90'; c.fillRect(px + 13, py + 1, 2, 3); c.fillRect(px + 23, py + 2, 2, 3);
    } else if (content === 1) {                                        // records
        c.fillStyle = '#1a1a1a'; ellipse(c, px + 10, py + 3, 5, 5); ellipse(c, px + 21, py + 3, 5, 5);
        c.fillStyle = '#c9352c'; ellipse(c, px + 10, py + 3, 2, 2);
        c.fillStyle = '#2f5f9a'; ellipse(c, px + 21, py + 3, 2, 2);
    } else if (content === 2) {                                        // notices
        c.fillStyle = '#f4efe2'; c.fillRect(px + 6, py - 1, 9, 8); c.fillRect(px + 18, py, 9, 8);
        c.fillStyle = '#5a5a6a'; c.fillRect(px + 8, py + 1, 5, 1); c.fillRect(px + 8, py + 3, 5, 1); c.fillRect(px + 20, py + 2, 5, 1);
    } else {                                                           // folded maps
        c.fillStyle = '#e8d9b0'; c.fillRect(px + 5, py, 10, 7); c.fillRect(px + 17, py + 1, 10, 6);
        c.fillStyle = '#7fa35a'; c.fillRect(px + 7, py + 2, 3, 2); c.fillRect(px + 19, py + 3, 4, 2);
        c.fillStyle = '#2f5f9a'; c.fillRect(px + 11, py + 1, 2, 5);
    }
}

function drawStall(c, s, time, got) {
    const px = s.x * TILE, py = s.y * TILE;
    const [a, b] = AWNINGS[s.content % AWNINGS.length];
    // shadow on the ground, posts, the vendor behind the counter
    c.fillStyle = 'rgba(0,0,0,0.25)'; c.fillRect(px + 1, py + 10, TILE, 22);
    c.fillStyle = '#4a3220'; c.fillRect(px + 2, py + 6, 3, 24); c.fillRect(px + TILE - 5, py + 6, 3, 24);
    drawChar(c, px + 16, py + 23, 'down', 0, VENDOR_PALS[s.content % VENDOR_PALS.length]);
    // counter
    c.fillStyle = '#8a5a34'; c.fillRect(px + 1, py + 18, TILE - 2, 12);
    c.fillStyle = '#a8753f'; c.fillRect(px + 1, py + 18, TILE - 2, 3);
    c.fillStyle = '#5a3a22'; c.fillRect(px + 1, py + 29, TILE - 2, 1); c.fillRect(px + 1, py + 24, TILE - 2, 1);
    drawGoods(c, px, py + 20, s.content);
    // awning: stripes, scalloped hem, shadow under it
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(px - 1, py + 10, TILE + 2, 3);
    for (let k = 0; k < 7; k++) { c.fillStyle = k % 2 ? b : a; c.fillRect(px - 1 + k * 5, py - 3, 5, 13); }
    c.fillStyle = a;
    for (let k = 0; k < 7; k++) { c.beginPath(); c.arc(px + 1.5 + k * 5, py + 10, 2.5, 0, Math.PI); c.fill(); }
    c.fillStyle = 'rgba(255,255,255,0.25)'; c.fillRect(px - 1, py - 3, TILE + 2, 1);
    // a lantern under the awning
    c.fillStyle = '#23262c'; c.fillRect(px + TILE - 8, py + 10, 1, 3);
    c.fillStyle = '#ffd37a'; c.fillRect(px + TILE - 10, py + 13, 5, 5);
    // marker: a bouncing "!" bubble until collected, a coin after
    const bob = S.reduceMotion ? 0 : Math.sin(time / 300 + s.x) * 2;
    const my = py - 10 + bob;
    if (got) {
        c.fillStyle = '#e8b75a'; ellipse(c, px + TILE / 2, my, 5, 5);
        c.fillStyle = '#7a5a1a'; ellipse(c, px + TILE / 2, my, 2, 2);
    } else {
        drawBubble(c, px + TILE / 2, my, '!');
    }
}

function drawShip(c, map, time) {
    const sh = map.ship;
    const x = sh.x0 * TILE, y = sh.y0 * TILE, w = (sh.x1 - sh.x0 + 1) * TILE, h = (sh.y1 - sh.y0 + 1) * TILE;
    const sway = S.reduceMotion ? 0 : Math.sin(time / 900) * 1.5;
    // A long narrow hull moored along the quay, bow to the top, overhanging
    // its three tiles so it reads as a liner rather than a 3x3 block.
    const hx = x + 16, hw = w - 32;
    const top = y - 10, bot = y + h + 6;
    c.fillStyle = 'rgba(0,0,0,0.28)'; ellipse(c, hx + hw / 2 + 6, (top + bot) / 2 + 8, hw / 2 + 2, (bot - top) / 2 - 2);
    c.save();
    c.translate(0, sway);
    c.beginPath();
    c.moveTo(hx, bot - 10); c.lineTo(hx, top + 34); c.quadraticCurveTo(hx + hw / 2, top - 14, hx + hw, top + 34);
    c.lineTo(hx + hw, bot - 10); c.quadraticCurveTo(hx + hw / 2, bot + 6, hx, bot - 10); c.closePath();
    c.fillStyle = '#f1f1ec'; c.fill();
    c.strokeStyle = '#1e3b66'; c.lineWidth = 3; c.stroke();
    // decks: a long lower deck, a narrower upper deck, the bridge near the bow
    c.fillStyle = '#e0e0d8'; rr(c, hx + 6, top + 30, hw - 12, bot - top - 48, 6); c.fill();
    c.fillStyle = '#f8f8f4'; rr(c, hx + 11, top + 38, hw - 22, bot - top - 64, 5); c.fill();
    c.fillStyle = '#d4d4cc'; rr(c, hx + 15, top + 26, hw - 30, 14, 4); c.fill();
    c.fillStyle = '#6fa3d8'; for (let k = 0; k < 5; k++) c.fillRect(hx + 18 + k * 6, top + 30, 4, 4);
    // cabin windows down both sides of each deck
    c.fillStyle = '#7fb0e0';
    for (let k = 0; k < 9; k++) {
        const wy = top + 44 + k * 7;
        c.fillRect(hx + 8, wy, 2, 4); c.fillRect(hx + hw - 10, wy, 2, 4);
        c.fillRect(hx + 13, wy, 2, 3); c.fillRect(hx + hw - 15, wy, 2, 3);
    }
    // the pool aft on the top deck, two funnels, mast and bow light
    c.fillStyle = '#4fa3d8'; rr(c, hx + hw / 2 - 7, bot - 44, 14, 12, 3); c.fill();
    c.fillStyle = 'rgba(255,255,255,0.5)'; c.fillRect(hx + hw / 2 - 4, bot - 41, 4, 1);
    for (const fy of [top + 56, top + 74]) {
        c.fillStyle = '#d9442f'; c.fillRect(hx + hw / 2 - 5, fy, 10, 12);
        c.fillStyle = '#2a2a2a'; c.fillRect(hx + hw / 2 - 6, fy - 2, 12, 4);
    }
    c.fillStyle = '#9a9a9a'; c.fillRect(hx + hw / 2, top + 6, 1, 20);
    c.fillStyle = '#fff6d8'; c.fillRect(hx + hw / 2 - 1, top + 4, 3, 3);
    // lifeboats
    c.fillStyle = '#f2a33a';
    for (let k = 0; k < 4; k++) { ellipse(c, hx + 3, top + 50 + k * 14, 2.5, 4); ellipse(c, hx + hw - 3, top + 50 + k * 14, 2.5, 4); }
    c.restore();
    // bow wave
    if (!S.reduceMotion) {
        c.strokeStyle = 'rgba(255,255,255,0.35)'; c.lineWidth = 1;
        const ph = Math.sin(time / 500) * 2;
        c.beginPath(); c.moveTo(hx - 4, top + 36 + ph); c.quadraticCurveTo(hx + hw / 2, top - 8 + ph, hx + hw + 4, top + 36 + ph); c.stroke();
    }
    // gangway plank from the dock to the hull
    const gx = sh.dock.x * TILE + TILE - 6, gy = sh.gangway.y * TILE + 11, gl = hx - gx + 2;
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(gx, gy + 9, gl, 3);
    c.fillStyle = '#8a6f4e'; c.fillRect(gx, gy, gl, 10);
    c.fillStyle = '#5c4730'; c.fillRect(gx, gy + 4, gl, 1);
    c.fillStyle = '#a89070'; c.fillRect(gx, gy, gl, 1);
    // name under the hull, from the day's hotel field
    if (S.day && S.day.hotel) {
        c.fillStyle = 'rgba(0,0,0,0.5)'; c.font = '10px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'top';
        c.fillText(S.day.hotel, hx + hw / 2 + 1, bot + 5);
        c.fillStyle = '#fff'; c.fillText(S.day.hotel, hx + hw / 2, bot + 4);
    }
}

function drawWaterFx(c, map, time) {
    if (S.reduceMotion) return;
    c.strokeStyle = 'rgba(255,255,255,0.2)'; c.lineWidth = 1;
    for (let y = 0; y < map.h; y++) {
        for (let x = LAYOUT.SHIP_X0; x < map.w; x++) {
            if (map.tiles[y * map.w + x] !== T.WATER) continue;
            const ph = time / 700 + x * 0.9 + y * 0.6;
            const wx = x * TILE + 6 + Math.sin(ph) * 4, wy = y * TILE + 16 + Math.cos(ph * 0.7) * 3;
            c.beginPath(); c.moveTo(wx, wy); c.quadraticCurveTo(wx + 5, wy - 3, wx + 10, wy); c.stroke();
            const ph2 = ph + 2.1;
            const wx2 = x * TILE + 16 + Math.cos(ph2) * 5, wy2 = y * TILE + 26 + Math.sin(ph2 * 0.8) * 2;
            c.beginPath(); c.moveTo(wx2, wy2); c.quadraticCurveTo(wx2 + 4, wy2 - 2, wx2 + 8, wy2); c.stroke();
        }
    }
    // the ship's lights on the water, below the hull
    const sh = map.ship;
    const x = sh.x0 * TILE, w = (sh.x1 - sh.x0 + 1) * TILE, y = (sh.y1 + 1) * TILE;
    c.fillStyle = 'rgba(255,240,200,0.14)';
    for (let k = 0; k < 6; k++) {
        const rx = x + 10 + k * (w - 20) / 5 + Math.sin(time / 400 + k) * 3;
        c.fillRect(rx, y + 10 + k * 3, 8 + Math.sin(time / 300 + k * 2) * 3, 2);
    }
}

function drawGulls(c, time) {
    if (S.reduceMotion) return;
    c.strokeStyle = '#f4f4f4'; c.lineWidth = 1.5;
    for (const g of S.gulls) {
        const x = g.cx + Math.cos(g.a) * g.r, y = g.cy + Math.sin(g.a) * g.r * 0.5;
        const f = Math.sin(g.flap) * 3;
        c.fillStyle = 'rgba(0,0,0,0.12)'; ellipse(c, x + 10, y + 30, 5, 2);
        c.beginPath(); c.moveTo(x - 6, y - f); c.quadraticCurveTo(x - 3, y + 1, x, y); c.quadraticCurveTo(x + 3, y + 1, x + 6, y - f); c.stroke();
    }
}

function drawPath(c) {
    if (!S.path.length) return;
    c.fillStyle = 'rgba(232,183,90,0.5)';
    for (const q of S.path) { ellipse(c, q.x * TILE + TILE / 2, q.y * TILE + TILE / 2, 3, 3); }
}

/** One frame of the world into the offscreen world canvas. */
function renderWorld(time) {
    const c = wctx;
    const map = S.map;
    c.globalCompositeOperation = 'source-over';
    c.drawImage(S.bg, 0, 0);
    drawWaterFx(c, map, time);
    drawPath(c);
    const items = [];
    items.push({ y: (map.ship.y1 + 1) * TILE + 6, draw: () => drawShip(c, map, time) });
    for (const l of S.decor.lamps) items.push({ y: l.y, draw: () => drawLamp(c, l, time) });
    for (const s of map.stalls) items.push({ y: s.y * TILE + TILE, draw: () => drawStall(c, s, time, S.tokens.has(s.content)) });
    for (const n of S.npcs) {
        const step = n.moving ? (Math.floor(time / 140) % 2 ? 1 : -1) : 0;
        items.push({ y: n.fy * TILE + TILE - 3, draw: () => {
            drawChar(c, n.fx * TILE + 16, n.fy * TILE + TILE - 3, n.dir, step, n.pal);
            if (n.chat && !n.moving) drawBubble(c, n.fx * TILE + 16, n.fy * TILE - 8, '…');
        } });
    }
    const p = S.player;
    const pstep = p.moving ? (Math.floor(time / 90) % 2 ? 1 : -1) : 0;
    items.push({ y: p.fy * TILE + TILE - 3 + 0.5, draw: () => drawChar(c, p.fx * TILE + 16, p.fy * TILE + TILE - 3, p.dir, pstep, PLAYER_PAL) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();
    drawGulls(c, time);
    // lighting: multiply the light map, then warm bloom at each lamp
    c.globalCompositeOperation = 'multiply';
    c.drawImage(S.light, 0, 0);
    c.globalCompositeOperation = 'lighter';
    for (const l of S.decor.lamps) {
        const flick = S.reduceMotion ? 1 : 0.85 + 0.15 * Math.sin(time / 90 + l.x * 0.3);
        const g = c.createRadialGradient(l.x, l.y - 37, 0, l.x, l.y - 37, 34);
        g.addColorStop(0, `rgba(255,205,130,${0.5 * flick})`); g.addColorStop(1, 'rgba(255,205,130,0)');
        c.fillStyle = g; c.fillRect(l.x - 34, l.y - 71, 68, 68);
    }
    c.globalCompositeOperation = 'source-over';
}

// ---------- camera and display ----------
function fitCanvas() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; dof.width = w; dof.height = h; }
    S.zoom = r.width < 600 ? 2 : 1;        // phones see half the street at twice the size
    return { w, h };
}

function updateCamera() {
    const vw = WORLD_W / S.zoom, vh = WORLD_H / S.zoom;
    const p = S.player;
    const tx = Math.max(0, Math.min(WORLD_W - vw, p.fx * TILE + 16 - vw / 2));
    const ty = Math.max(0, Math.min(WORLD_H - vh, p.fy * TILE + 16 - vh / 2));
    const cam = S.cam;
    if (!cam.init) { cam.x = tx; cam.y = ty; cam.init = true; }
    else { cam.x += (tx - cam.x) * 0.14; cam.y += (ty - cam.y) * 0.14; }
    return { vw, vh };
}

let lastT = 0;
function frame() {
    requestAnimationFrame(frame);
    tick();
}
/** One step of the game: input, townspeople, render. Also reachable as XOStreetWalk.tick() for scripted checks while the tab is hidden. */
function tick() {
    if (!S.map) return;
    const time = now();
    const dt = lastT ? Math.min(100, time - lastT) : 16;
    lastT = time;
    updateMovement();
    updateNpcs(time, dt);
    updateGulls(dt);
    renderWorld(time);
    const { w, h } = fitCanvas();
    const { vw, vh } = updateCamera();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(world, S.cam.x, S.cam.y, vw, vh, 0, 0, w, h);
    dofCtx.drawImage(canvas, 0, 0);

    // typewriter
    if (S.dialog && !S.reduceMotion) {
        const d = S.dialog, text = d.vendor.lines[d.line] || '';
        const want = Math.min(text.length, Math.floor((time - d.t0) / 28));
        if (want > d.shown) { d.shown = want; renderDialogLine(); }   // never undo a tap that skipped to the end
    }
    // HUD
    el.time.textContent = (elapsedMs() / 1000).toFixed(1);
    if (S.toastT && time - S.toastT > 1800) { el.toast.classList.remove('show'); S.toastT = 0; }
}

// ---------- input wiring ----------
function canvasToTile(e) {
    const r = canvas.getBoundingClientRect();
    const vw = WORLD_W / S.zoom, vh = WORLD_H / S.zoom;
    const wx = (e.clientX - r.left) / r.width * vw + S.cam.x;
    const wy = (e.clientY - r.top) / r.height * vh + S.cam.y;
    return { x: Math.floor(wx / TILE), y: Math.floor(wy / TILE) };
}
canvas.addEventListener('pointerdown', (e) => {
    if (!S.map) return;
    if (S.phase === 'dialog') { advanceDialog(); return; }
    const t = canvasToTile(e);
    tapTile(t.x, t.y);
    e.preventDefault();
});
el.dialog.addEventListener('pointerdown', (e) => { e.stopPropagation(); e.preventDefault(); advanceDialog(); });

const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right', W: 'up', S: 'down', A: 'left', D: 'right' };
window.addEventListener('keydown', (e) => {
    if (S.phase === 'intro' || S.phase === 'end') return;
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (S.phase === 'dialog') advanceDialog(); else okAction();
        return;
    }
    const dir = KEYS[e.key];
    if (!dir) return;
    e.preventDefault();
    if (S.phase === 'dialog') return;
    if (!e.repeat) press(dir);
});
window.addEventListener('keyup', (e) => { const dir = KEYS[e.key]; if (dir) release(dir); });
window.addEventListener('blur', () => { S.held = []; el.dpad.querySelectorAll('button').forEach((b) => b.classList.remove('down')); });

for (const b of el.dpad.querySelectorAll('[data-dir]')) {
    const dir = b.dataset.dir;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture(e.pointerId); if (S.phase === 'dialog') advanceDialog(); else press(dir); });
    const up = (e) => { e.preventDefault(); release(dir); };
    b.addEventListener('pointerup', up);
    b.addEventListener('pointercancel', up);
    b.addEventListener('lostpointercapture', up);
    b.addEventListener('contextmenu', (e) => e.preventDefault());
}
function okAction() {
    // Bump whatever the player faces: a stall opens, the ship boards.
    if (S.phase === 'play' && !S.player.moving) { S.bumpLock = null; tryStep(S.player.dir); }
}
el.ok.addEventListener('pointerdown', (e) => { e.preventDefault(); if (S.phase === 'dialog') advanceDialog(); else okAction(); });

el.rmHud.addEventListener('click', () => setRM(!S.reduceMotion));
el.rmIntro.addEventListener('click', () => setRM(!S.reduceMotion));

el.start.addEventListener('click', () => {
    el.intro.hidden = true;
    newRound();
});
el.again.addEventListener('click', () => {
    el.end.hidden = true;
    newRound();                                       // same seed, same street
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) { S.held = []; if (S.phase === 'play') timerPause(); }
    else if (S.phase === 'play') timerResume();
});

// ---------- boot ----------
window.XOStreetWalk = { tick, state: S };     // debug handle: step the game from the console, inspect state
async function boot() {
    setRM(S.reduceMotion);
    el.introSeed.textContent = String(S.seed);
    for (let i = 0; i < 4; i++) { const im = new Image(); im.src = `assets/vendor${i}.webp`; }   // warm the cache
    try {
        const [level, price] = await Promise.all([loadLevel(TOUR_ID, BASE), loadPrice()]);
        S.level = level;
        S.price = price;
        S.day = level.days[DAY_INDEX] || level.days.find((d) => /利物浦|Liverpool/.test(d.title + d.stops.map((s) => s.name).join(''))) || level.days[0];
        S.stop = S.day.stops.find((s) => s.aiScene) || S.day.stops[0] || null;
        S.look = resolveLook(level, S.day.day);
        S.vendors = buildVendors(S.day, S.stop);
        el.hudSub.textContent = `${S.stop ? S.stop.name : S.day.title}・第 ${S.day.day} 天 Day ${S.day.day}`;
        el.introSub.textContent = `${level.name}　${level.dateFull}　第 ${S.day.day} 天 Day ${S.day.day}：${S.day.title}`;
        fillCard();
        el.start.disabled = false;
        requestAnimationFrame(frame);
    } catch (e) {
        el.err.hidden = false;
        el.err.textContent = '載入行程失敗 Could not load the tour: ' + (e && e.message ? e.message : e) +
            '\n(需從網站根目錄以 http 提供，file:// 無法 fetch)';
        el.introSub.textContent = '載入失敗 Load failed';
    }
}
boot();
