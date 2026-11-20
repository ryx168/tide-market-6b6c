# 老街漫步 RPG Street Walk

A top-down RPG street walk through the six ports of XO Tours cruise 7622. In each port, visit four stalls, collect four tokens, board the boat, land on the real tour card.

Plain HTML, ES modules, one 2D canvas. No build step, no framework.

**Live:** https://ryx168.github.io/tide-market-6b6c/

| Port | Link | Look |
| --- | --- | --- |
| Day 2 倫敦 London | [?day=2](https://ryx168.github.io/tide-market-6b6c/games/street-walk/?day=2) | dusk, clock tower, Thames river boat |
| Day 4 法爾茂斯 Falmouth | [?day=4](https://ryx168.github.io/tide-market-6b6c/games/street-walk/?day=4) | sunny afternoon, pastel terraces, lighthouse, tender |
| Day 5 科克（科夫）Cork / Cobh | [?day=5](https://ryx168.github.io/tide-market-6b6c/games/street-walk/?day=5) | rain at dusk, three spires, the liner |
| Day 6 都柏林 Dublin | [?day=6](https://ryx168.github.io/tide-market-6b6c/games/street-walk/?day=6) | night, painted Georgian doors, castle tower, tender |
| Day 7 貝爾法斯特 Belfast | [?day=7](https://ryx168.github.io/tide-market-6b6c/games/street-walk/?day=7) | dusk, murals, green dome, gantry cranes, the liner |
| Day 8 利物浦 Liverpool | [?day=8](https://ryx168.github.io/tide-market-6b6c/games/street-walk/?day=8) | dusk, twin clock towers, the liner |

## What is in the picture

- A painted static layer: cobbles stone by stone, five facade styles, slate roofs with ridges, dormers and chimneys, a quay with bollards and rope.
- Sprites sorted by their feet: the player, five wandering townspeople, a vendor at each stall, lamp posts, a cruise liner, gulls.
- A light map multiplied over the frame with warm pools under the lamps, flickering bloom, a tilt-shift depth of field done with a CSS blur on a second canvas, and a 2x camera that follows the player on phones.
- Per port: facade styles, time of day, rain, water colour, the vessel and a landmark silhouette over the roofs, all from one `LEVELS` table in `game.js`.
- Four vendor portraits per port, the player avatar and one key art per port are AI-generated (Workers AI flux-1-schnell). Everything on the ground is procedural.

All dialogue text comes from the tour JSON in `site/kv_json_exports/`; nothing is invented.

## Layout

| Path | What |
| --- | --- |
| `site/games/street-walk/` | the game: `index.html`, `game.js`, `map.js`, `style.css`, `assets/` |
| `site/shared/` | level loader, look presets, seed and score helpers |
| `site/kv_json_exports/` | tour 7622 and its road polylines |
| `scripts/smoke.mjs` | CI: plays one full round in every port in headless Chrome, saves stills, fails on errors |
| `.github/workflows/deploy.yml` | smoke test, then GitHub Pages |

The source of truth for the game is `ai360/games/street-walk/` in the private workspace; this repo is the public copy that GitHub Actions tests and serves.

## Run locally

Serve `site/` over http (fetch of the tour JSON fails on `file://`) and open `games/street-walk/`:

```
npx serve site
```

Run the smoke test the way CI does:

```
npm install --no-save puppeteer@23
node scripts/smoke.mjs
```

Stills land in `stills/`.
