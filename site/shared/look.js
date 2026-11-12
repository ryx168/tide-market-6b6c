/*
 * shared/look.js -- the art preset and music choice for a level.
 *
 * Phase 0 Day 1: a table, nothing generated yet. Day 7 adds the
 * environment-builder script that writes the parallax layers and sprites
 * into assets/levels/<tourId>/<day>/<season>/, and Day 8 wires the music
 * through js/tour-bgm.js (window.XOBgm). Until then every level resolves to
 * the 'flat' preset, which the road renderer draws with plain colours, so
 * the game is playable before any image exists.
 *
 * Presets follow GAME_HUB_PLAN.md "Local art style and music".
 */

export const PRESETS = {
    flat: { name: 'Flat colour (no assets yet)', sky: '#8fb8de', ground: '#6b9b4a', road: '#555a60', line: '#e9e3c8', far: '#a9c4d8' },
    'britain-poster': { name: 'Impressionist brush, vintage travel poster', sky: '#cfe0ee', ground: '#7fa35a', road: '#4d5257', line: '#f1ead1', far: '#9fb9c9' },
    zellige: { name: 'Zellige tile frames, miniature-painting figures', sky: '#e9d8a6', ground: '#c9a06a', road: '#6a5a4a', line: '#f6e9c8', far: '#d9b98a' },
    'ink-wash': { name: 'Ink-wash landscape, 國畫 brushwork', sky: '#eef0ec', ground: '#9aa89a', road: '#3a3f44', line: '#e8e6dd', far: '#c5ccc6' },
    'ukiyo-e': { name: 'Ukiyo-e woodblock, flat colour', sky: '#d9e6f2', ground: '#8ab07a', road: '#4b4f55', line: '#f3ecd8', far: '#b4c9d9' },
    aurora: { name: 'Northern-lights watercolour, snow-field gouache', sky: '#1b2a44', ground: '#dfe8f1', road: '#3b4350', line: '#f8f8f8', far: '#2f4a6a' },
};

// Tour -> preset. A tour not listed falls back to 'flat'.
const BY_TOUR = {
    7622: 'britain-poster',
    7540: 'zellige',
};

export const SEASONS = ['spring', 'summer', 'autumn', 'winter'];

export function currentSeason(date = new Date()) {
    const m = date.getMonth() + 1;
    if (m >= 3 && m <= 5) return 'spring';
    if (m >= 6 && m <= 8) return 'summer';
    if (m >= 9 && m <= 11) return 'autumn';
    return 'winter';
}

/**
 * Resolve the look for a level day. Returns colours now; after Day 7 also
 * returns `layers` (parallax image URLs) and `sprites` when the files exist.
 */
export function resolveLook(level, day, season = currentSeason()) {
    const key = BY_TOUR[Number(level.tourId)] || 'flat';
    const preset = PRESETS[key] || PRESETS.flat;
    return {
        presetKey: key,
        preset,
        season,
        assetDir: `assets/levels/${level.tourId}/${day}/${season}`,
        layers: null,     // Day 7
        sprites: null,    // Day 7
        music: null,      // Day 8: { loop, stingers }
    };
}
