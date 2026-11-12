/*
 * shared/reward.js -- score, seed and the local run record.
 *
 * Phase 0 keeps everything on the device. Phase 2 adds the leaderboard,
 * the daily seed from KV and the coupon gate (GAME_HUB_PLAN.md "Reward loop
 * and conversion"). The seed is here from Day 1 so that Day 5's "same seed
 * gives the same run twice" check has something to test.
 */

const STORE_KEY = 'xo-game-runs';

/** Deterministic PRNG (mulberry32). Same seed, same sequence. */
export function rng(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** One seed per calendar day, so everyone gets the same run on the same day. */
export function dailySeed(date = new Date()) {
    const y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
    return (y * 10000 + m * 100 + d) >>> 0;
}

export function createScore() {
    const s = { distanceM: 0, cleanM: 0, crashes: 0, stopsReached: 0, styleBonus: 0, points: 0 };
    return {
        get() { return { ...s }; },
        addDistance(m, clean) { s.distanceM += m; if (clean) s.cleanM += m; this._recalc(); },
        crash() { s.crashes += 1; this._recalc(); },
        reachStop() { s.stopsReached += 1; this._recalc(); },
        setStyleBonus(source) { s.styleBonus = (source === 'gyro' || source === 'gesture') ? 0.1 : 0; this._recalc(); },
        _recalc() {
            const base = s.distanceM / 10 + s.cleanM / 20 + s.stopsReached * 500 - s.crashes * 100;
            s.points = Math.max(0, Math.round(base * (1 + s.styleBonus)));
        },
    };
}

export function saveRun(run) {
    try {
        const all = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
        all.push({ ...run, at: new Date().toISOString() });
        localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(-50)));
    } catch (_) { /* private mode, quota -- the run just is not kept */ }
}

export function loadRuns() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (_) { return []; }
}
