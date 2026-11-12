/*
 * games/street-walk/map.js -- the dock street, as data.
 *
 * No DOM, no canvas: this module builds the 20x15 tile grid from a seed and
 * answers "can I walk here" and "how do I get there", so the same code runs
 * in the browser and in a Node check. game.js owns the drawing.
 *
 * Layout (always): a three-tile-wide cobbled street runs left to right,
 * a quay column on the right edge of the land, the ship moored beyond it
 * in the Mersey. Seeded: where the four alleys branch off, how deep they
 * go, which stall sits at the end of each, and which vendor it is.
 */

import { rng } from '../../shared/reward.js';

export const T = { WATER: 0, STREET: 1, BUILDING: 2, STALL: 3, SHIP: 4, QUAY: 5 };
export const W = 20;
export const H = 15;

const STREET_TOP = 6, STREET_BOT = 8;     // rows of the main street
const STREET_X0 = 1, STREET_X1 = 14;      // columns of the main street
const QUAY_X = 15;                        // promenade along the water
const SHIP_X0 = 16, SHIP_X1 = 18;         // hull columns
const SHIP_Y0 = 6, SHIP_Y1 = 8;           // hull rows
const GANGWAY = { x: SHIP_X0, y: 7 };     // ship tile the player walks into
const DOCK = { x: QUAY_X, y: 7 };         // quay tile in front of the gangway
const START = { x: STREET_X0, y: 7 };

/** The fixed geometry, for the renderer (lamp posts, building spans). */
export const LAYOUT = { STREET_TOP, STREET_BOT, STREET_X0, STREET_X1, QUAY_X, SHIP_X0, SHIP_X1, SHIP_Y0, SHIP_Y1 };

export function isWalkable(t) { return t === T.STREET || t === T.QUAY; }

export function tileAt(map, x, y) {
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return T.BUILDING;
    return map.tiles[y * map.w + x];
}

/** Build one map from a seed; retries nearby seeds if validation fails. */
export function generateMap(seed) {
    let last = null;
    for (let k = 0; k < 32; k++) {
        const m = build((seed + k) >>> 0);
        last = validateMap(m);
        if (last.ok) return m;
    }
    throw new Error('street-walk: no valid map near seed ' + seed + ': ' + last.reasons.join('; '));
}

function build(seed) {
    const rand = rng(seed);
    const tiles = new Uint8Array(W * H).fill(T.BUILDING);
    const set = (x, y, t) => { tiles[y * W + x] = t; };

    // Water on the right, quay in front of it, ship in the water.
    for (let y = 0; y < H; y++) for (let x = SHIP_X0; x < W; x++) set(x, y, T.WATER);
    for (let y = 3; y <= 11; y++) set(QUAY_X, y, T.QUAY);
    for (let y = SHIP_Y0; y <= SHIP_Y1; y++) for (let x = SHIP_X0; x <= SHIP_X1; x++) set(x, y, T.SHIP);

    // Main street.
    for (let y = STREET_TOP; y <= STREET_BOT; y++) for (let x = STREET_X0; x <= STREET_X1; x++) set(x, y, T.STREET);

    // Four stall alleys at distinct columns, each at least two apart, two
    // branching up and two down so the street has life on both sides.
    const cols = pickColumns(rand, 4, 2, 13, 2);
    const sides = shuffle(rand, ['up', 'up', 'down', 'down']);
    const stalls = [];
    for (let i = 0; i < 4; i++) {
        const x = cols[i];
        const depth = Math.floor(rand() * 5);           // 0..4 alley tiles
        let sy;
        if (sides[i] === 'up') {
            for (let d = 1; d <= depth; d++) set(x, STREET_TOP - d, T.STREET);
            sy = STREET_TOP - depth - 1;
        } else {
            for (let d = 1; d <= depth; d++) set(x, STREET_BOT + d, T.STREET);
            sy = STREET_BOT + depth + 1;
        }
        set(x, sy, T.STALL);
        stalls.push({ x, y: sy, side: sides[i], face: sides[i] === 'up' ? { x, y: sy + 1 } : { x, y: sy - 1 } });
    }
    // Which vendor stands at which stall (content index 0..3), seeded.
    const order = shuffle(rand, [0, 1, 2, 3]);
    stalls.forEach((s, i) => { s.content = order[i]; });

    // Facade variety for the renderer: one byte per tile, seeded here so a
    // given day always looks the same.
    const facade = new Uint8Array(W * H);
    for (let i = 0; i < facade.length; i++) facade[i] = Math.floor(rand() * 256);

    return {
        w: W, h: H, seed, tiles, facade,
        start: { ...START },
        stalls,
        ship: { x0: SHIP_X0, y0: SHIP_Y0, x1: SHIP_X1, y1: SHIP_Y1, gangway: { ...GANGWAY }, dock: { ...DOCK } },
    };
}

function pickColumns(rand, n, lo, hi, gap) {
    for (let attempt = 0; attempt < 200; attempt++) {
        const out = [];
        while (out.length < n) {
            const c = lo + Math.floor(rand() * (hi - lo + 1));
            if (out.every((o) => Math.abs(o - c) >= gap)) out.push(c);
            if (out.length < n && attempt > 100 && out.length === 0) break;
        }
        if (out.length === n) return out.sort((a, b) => a - b);
    }
    // Deterministic fallback, still valid.
    return [3, 6, 9, 12].slice(0, n);
}

function shuffle(rand, arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/** Breadth-first distances over walkable tiles from one point. -1 = unreachable. */
export function bfs(map, from) {
    const dist = new Int16Array(map.w * map.h).fill(-1);
    const q = [from.y * map.w + from.x];
    dist[q[0]] = 0;
    for (let head = 0; head < q.length; head++) {
        const i = q[head], x = i % map.w, y = (i - x) / map.w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
            const j = ny * map.w + nx;
            if (dist[j] !== -1 || !isWalkable(map.tiles[j])) continue;
            dist[j] = dist[i] + 1;
            q.push(j);
        }
    }
    return dist;
}

/**
 * Shortest walkable path from a to b, as [{x,y}, ...] excluding a. If b is
 * not walkable (a stall or the ship), path to the walkable neighbour nearest
 * to a and append b as the final "bump" step. Returns [] when unreachable.
 */
export function findPath(map, a, b) {
    const tb = tileAt(map, b.x, b.y);
    const dist = bfs(map, a);
    let goal = b, bump = null;
    if (!isWalkable(tb)) {
        let best = null;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const n = { x: b.x + dx, y: b.y + dy };
            if (n.x < 0 || n.y < 0 || n.x >= map.w || n.y >= map.h) continue;
            const d = dist[n.y * map.w + n.x];
            if (d >= 0 && (best === null || d < best.d)) best = { ...n, d };
        }
        if (!best) return [];
        goal = best;
        bump = b;
    }
    const gi = goal.y * map.w + goal.x;
    if (dist[gi] < 0) return [];
    // Walk back from the goal along strictly decreasing distance.
    const path = [];
    let cur = { x: goal.x, y: goal.y };
    while (!(cur.x === a.x && cur.y === a.y)) {
        path.push(cur);
        const d = dist[cur.y * map.w + cur.x];
        let next = null;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = cur.x + dx, ny = cur.y + dy;
            if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
            if (dist[ny * map.w + nx] === d - 1) { next = { x: nx, y: ny }; break; }
        }
        if (!next) return [];
        cur = next;
    }
    path.reverse();
    if (bump) path.push(bump);
    return path;
}

/** The checks the Node script and the game both run before trusting a map. */
export function validateMap(map) {
    const reasons = [];
    if (map.w !== 20 || map.h !== 15) reasons.push(`size ${map.w}x${map.h}, want 20x15`);
    if (map.tiles.length !== map.w * map.h) reasons.push('tile count mismatch');
    if (!isWalkable(tileAt(map, map.start.x, map.start.y))) reasons.push('start not walkable');
    const dist = bfs(map, map.start);
    const reach = (p) => dist[p.y * map.w + p.x] >= 0;
    if (map.stalls.length !== 4) reasons.push(`${map.stalls.length} stalls, want 4`);
    map.stalls.forEach((s, i) => {
        if (tileAt(map, s.x, s.y) !== T.STALL) reasons.push(`stall ${i} tile is not STALL`);
        if (!reach(s.face)) reasons.push(`stall ${i} at ${s.x},${s.y} unreachable`);
    });
    const contents = new Set(map.stalls.map((s) => s.content));
    if (contents.size !== 4) reasons.push('stall contents not distinct');
    if (!reach(map.ship.dock)) reasons.push('ship dock unreachable');
    if (tileAt(map, map.ship.gangway.x, map.ship.gangway.y) !== T.SHIP) reasons.push('gangway is not a SHIP tile');
    const stallCount = map.tiles.filter((t) => t === T.STALL).length;
    if (stallCount !== 4) reasons.push(`${stallCount} STALL tiles on grid`);
    return { ok: reasons.length === 0, reasons };
}
