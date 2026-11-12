# 老街漫步 RPG Street Walk

A top-down RPG street walk through the Liverpool dock street on day 8 of XO Tours cruise 7622. Visit four stalls, collect four tokens, board the ship, land on the real tour card.

Plain HTML, ES modules, one 2D canvas. No build step, no framework.

**Live:** https://ryx168.github.io/tide-market-6b6c/

## What is in the picture

- A painted static layer: cobbles stone by stone, five facade styles, slate roofs with ridges, dormers and chimneys, a quay with bollards and rope.
- Sprites sorted by their feet: the player, five wandering townspeople, a vendor at each stall, lamp posts, a cruise liner, gulls.
- A light map multiplied over the frame with warm pools under the lamps, flickering bloom, a tilt-shift depth of field done with a CSS blur on a second canvas, and a 2x camera that follows the player on phones.
- Four vendor portraits, the player avatar and the key art are AI-generated (Workers AI flux-1-schnell). Everything on the ground is procedural.

All dialogue text comes from the tour JSON in `site/kv_json_exports/`; nothing is invented.

## Layout

| Path | What |
| --- | --- |
| `site/games/street-walk/` | the game: `index.html`, `game.js`, `map.js`, `style.css`, `assets/` |
| `site/shared/` | level loader, look presets, seed and score helpers |
| `site/kv_json_exports/` | tour 7622 and its road polylines |
| `scripts/smoke.mjs` | CI: plays one full round in headless Chrome, saves stills, fails on errors |
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
