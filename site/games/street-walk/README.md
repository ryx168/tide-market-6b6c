# 老街漫步 RPG Street Walk (`games/street-walk/`)

Tour 7622, six port days. Top-down 20×15 tile map, 32 px tiles, on a 2D canvas.
Files: `index.html`, `game.js`, `map.js`, `style.css`, `assets/`.

## Ports (`?day=N`, default 8)

| Day | Port | Time, weather | Vessel | Landmark over the roofs | Stall goods |
| --- | --- | --- | --- | --- | --- |
| 2 | 倫敦 London | dusk | Thames river boat | gothic clock tower | umbrellas, tickets, flowers, tea |
| 4 | 法爾茂斯 Falmouth | sunny afternoon | tender | headland lighthouse | shells, pasties, notices, rope |
| 5 | 科克（科夫）Cork / Cobh | dusk, rain | the liner | three spires | bells, fish, notices, tweed |
| 6 | 都柏林（鄧萊里）Dublin | night | tender | round castle tower | tin whistles, maps, books, rope |
| 7 | 貝爾法斯特 Belfast | dusk | the liner | green dome, two gantry cranes | keys, tools, paints, notices |
| 8 | 利物浦 Liverpool | dusk | the liner | twin clock towers | fish, records, notices, maps |

These are the 7622 days whose stop has a 360 scene with hotspots. One `LEVELS` table at the top of `game.js` drives each port: facade styles (pastel terraces with mixed roofs for Falmouth and Cobh, Georgian brick with painted doors for Dublin, murals for Belfast), time of day (light-map base, lamp strength, how many windows are lit, a sunlit wash by day with the lamps switched off), rain (streaks, rings in the puddles, wet stones), water colour, the vessel and the landmark. The map layout is shared; the seed is `dailySeed() + day × 7919`, so each port has its own street and everyone gets the same one that day. The intro lists the six ports; the end card links to the next.

Landmarks and vessels are generic silhouettes in each port's style, drawn in code, not drawings of the real buildings.

## How to play
- Serve `ai360/` over http and open `games/street-walk/index.html` (fetch of the tour JSON fails on `file://`).
- Press 「開始 Start」. Move with arrow keys / WASD, the on-screen D-pad, or tap a tile on the map to auto-walk there (BFS path).
- Walk into each of the four stalls (the bouncing `!` bubble): a dialogue box opens with the vendor's portrait, tap / Enter / 「確定 OK」 to advance; the last tap takes the token.
- With all four tokens, walk onto the ship's gangway (right edge). Fewer than four: the ship tells you how many are missing.
- Score = 5 × 500 (four stalls + boarding, via `createScore().reachStop()`) + time bonus `max(0, 2000 − seconds × 10)`. The clock pauses while a dialogue is open.
- End screen: points, best on this device for this port, and the port's stop card (stop name, day title, `day_N.jpg`, tour name, `dateFull`, `prices[0]`), with 「再玩一次」, 「下一站 Next port」 and 「看這個行程」.
- 「減少動態 Reduce motion」 (intro and HUD): townspeople stand still, no water ripples, gulls, ship sway, lamp flicker, player bob, marker bounce or typewriter. Stored in `localStorage['xo-reduce-motion']`; defaults to `prefers-reduced-motion`.

## The drawn-in pass (the "after" of the before/after)
The first build drew every tile as one flat colour. This pass keeps the map and the game loop and replaces the renderer:
- **Static layer, painted once per round.** Cobbles stone by stone with highlights, grass tufts and puddles; facades in five seeded styles (red brick, stucco, stone, timber-framed) with eaves, lit or dark windows, flower boxes, doors, hanging signs; slate roofs with a ridge, a dark back slope and a lit front slope per block, chimneys on the ridge, dormers below it, a shadow gap between houses; the quay as stone slabs with bollards, a sagging mooring rope, crates and barrels; shadows cast by buildings onto the ground beside them. All variation comes from a position hash of the daily seed, so the same day draws the same street.
- **Sprites each frame, sorted by their feet**, so a walker passes in front of a lamp post and behind a stall: the player, five wandering townspeople (seeded spawn and random walk, never onto the player's tile; they pause and show a 「…」 bubble), one vendor behind each stall counter, lamp posts, the ship, three gulls circling over the Mersey.
- **Lighting.** A light map (cool dusk base, warm pools under each lamp, each stall and each lit window, a pale pool around the ship) is multiplied over the frame, then a flickering warm bloom is added at every lamp head. Done with `globalCompositeOperation`, no shaders.
- **Depth of field.** A second canvas holds a copy of the frame with a CSS `filter: blur()` and a `mask-image` that reveals only the top and bottom bands (tilt-shift). CSS filters on a canvas element work in Safari; `ctx.filter` does not. A vignette is a CSS gradient on `#stage::after`.
- **Camera.** On stages narrower than 600 px the view is 2× and follows the player with easing (`S.cam`, `S.zoom`); on desktop the whole street is visible. Tap-to-walk maps through the camera.
- **AI images.** Four vendor portraits per port, the player's HUD avatar and one key art per port were generated with Workers AI `@cf/black-forest-labs/flux-1-schnell` (the same account pool as `tour/functions/api/_ai-image.js`) and saved as WebP in `assets/dayN/` (portraits 256², 7–12 KB each; key art 960², about 110 KB). Portrait N belongs to vendor N: the day's hotspots in order, then the description sentences. All assets together are about 820 KB; a page loads only its own port's five. A seamless cobble texture was tried and rejected: the model paints a scene, not a tile, so ground and walls stay procedural. The portraits are generic characters (dock worker, 1960s musician, harbour master, guide), not likenesses.
- Fixed in passing: `.overlay[hidden]` and `#dialog[hidden]` now beat their `display:flex`, so the end screen no longer sits on top of the intro at boot.

## What is real
- Map generated in `map.js` from `dailySeed()` via `rng()`: main street, quay, ship, four alleys with seeded columns, depth (0–4) and side, seeded vendor-to-stall assignment. `validateMap()` runs in-game and retries nearby seeds if a map is ever invalid. `map.js` now also exports `LAYOUT` (the fixed rows and columns) for the renderer.
- All dialogue text is derived at load time: the port's hotspots (`aiScene.hotspots[].title/text`, up to three) become stalls; the day's `description`, split on 。！？, fills the rest in order. Stall labels 「港口公告 Port notice」 / 「城市導覽 City guide」 are UI labels, not facts.
- The ship's name under the liner is the day's `hotel` (盛世公主號（陽台艙）) as the JSON has it; tenders and the river boat carry no label.
- Runs saved with `saveRun({ game: 'street-walk', day, ... })`; best is the max over `loadRuns()` for this game and port (old runs without `day` count as Liverpool).

## What is stubbed / not done
- No gyro, shake or compass: the brief for this game asks for D-pad / keys only, so `shared/input.js` is not used.
- `resolveLook()` is still called but its colours are no longer used: this renderer has its own palette. The `britain-poster` preset would need a per-game mapping to matter.
- No music, no sound.
- Townspeople do not block the player (the player can walk through them); they only avoid walking onto the player.
- The price line shows `prices[0].optionName` and the bare number; the JSON carries no currency field, so none is shown.
- The DOF overlay is one extra full-frame `drawImage` plus a CSS blur per frame; not measured on a low-end phone yet. If it costs too much, drop `#dof` from the HTML and nothing else changes.

## Asks for shared/
1. `level.js`: expose `prices[]` (or `price` + `prices[0]`) on the level. Every stop card needs `prices[0]`; today each game must refetch `tour_<id>.json` for it (`loadPrice()` in `game.js`).
2. `reward.js`: `createScore()` is road-shaped (distance, crashes). A generic `addPoints(n, reason)` or a `timeBonus()` would let non-driving games score inside the module instead of adding a local bonus on top of `points`.
3. A shared reduce-motion helper (`getReduceMotion()/setReduceMotion()`) with one agreed `localStorage` key so all twelve games honour the same toggle. This game uses `xo-reduce-motion`.
4. `look.js`: a way to register per-game palettes (ground, wall, roof, water) under a preset, so the regional presets can restyle this street for a Taiwan night market without touching the renderer.

## Next steps
1. Door tiles on the facades that open one-line "shop" dialogues from other days' text, so a street has more than four things to touch.
2. A second map template (a night-market street with no quay) driven by the same renderer and `LEVELS` table, for the Taiwan and Japan tours the plan lists for this game.
3. Stingers and a walking loop through `js/tour-bgm.js` once assets exist, muted under reduce motion.
