/*
 * shared/level.js -- turn a tour's JSON plus its route polylines into a
 * level description every game can read.
 *
 * Inputs are the two files the tour pages already use, unchanged:
 *   kv_json_exports/tour_<id>.json         the tour (itinerary[].stops[] with lat/lng, aiScene)
 *   kv_json_exports/tour_<id>_routes.json  { "<day>": [[lng, lat], ...] } -- same shape as
 *                                          the tourroute:<id> KV entry on the live site
 *
 * Output (buildLevel) is plain data, no DOM, no three.js, so the same module
 * runs in the browser (fetch) and in Node (scripts/level-check.mjs reads the
 * files and calls the same functions). Distances are metres along the
 * polyline, so a game only ever asks "what is at 4,200 m?" and never touches
 * coordinates itself.
 *
 * Phase 0 scope: one tour (7622), one coach day (day 3, London -> Southampton).
 * Nothing here is 7622-specific: a tour with no routes file still loads, its
 * days just carry route: null.
 */

const EARTH_R = 6371000;

function haversine(a, b) {
    // a, b are [lng, lat]
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLng = toRad(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_R * Math.asin(Math.sqrt(s));
}

function bearing(a, b) {
    // degrees clockwise from north, a -> b, both [lng, lat]
    const toRad = (d) => d * Math.PI / 180;
    const y = Math.sin(toRad(b[0] - a[0])) * Math.cos(toRad(b[1]));
    const x = Math.cos(toRad(a[1])) * Math.sin(toRad(b[1])) -
        Math.sin(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.cos(toRad(b[0] - a[0]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** Cumulative metres at every vertex of a [lng, lat] polyline. */
export function cumulative(points) {
    const out = [0];
    for (let i = 1; i < points.length; i++) out.push(out[i - 1] + haversine(points[i - 1], points[i]));
    return out;
}

/**
 * Resample a polyline to evenly spaced samples. Each sample carries the
 * heading and the signed turn rate (degrees per metre, + = right), which is
 * what the pseudo-3D road reads to bend the road. Keeps the start and end.
 */
export function resample(points, stepM = 20) {
    if (!points || points.length < 2) return [];
    const cum = cumulative(points);
    const total = cum[cum.length - 1];
    const samples = [];
    let seg = 0;
    for (let d = 0; d <= total; d += stepM) {
        while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
        const a = points[seg], b = points[seg + 1];
        const span = cum[seg + 1] - cum[seg] || 1;
        const t = Math.min(1, Math.max(0, (d - cum[seg]) / span));
        samples.push({
            d,
            lng: a[0] + (b[0] - a[0]) * t,
            lat: a[1] + (b[1] - a[1]) * t,
            heading: bearing(a, b),
            turn: 0,
        });
    }
    for (let i = 1; i < samples.length; i++) {
        let dh = samples[i].heading - samples[i - 1].heading;
        if (dh > 180) dh -= 360;
        if (dh < -180) dh += 360;
        samples[i].turn = dh / stepM;
    }
    return samples;
}

/** Index of the polyline vertex nearest to [lng, lat], plus its distance in metres. */
export function nearestVertex(points, lngLat) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
        const d = haversine(points[i], lngLat);
        if (d < bestD) { bestD = d; best = i; }
    }
    return { index: best, offM: bestD };
}

function stopRecord(stop, dayNo, idx) {
    return {
        id: `${dayNo}-${idx}`,
        day: dayNo,
        name: stop.name || stop.title || '',
        lat: stop.lat,
        lng: stop.lng ?? stop.lon,
        arrivalMode: stop.arrivalMode || null,
        aiScene: stop.aiScene || null,
        image: stop.image || null,
    };
}

/**
 * Build the level description for one tour.
 *
 * @param {object} tour    parsed tour_<id>.json
 * @param {object|null} routes parsed tour_<id>_routes.json, or null
 * @param {object} [opts]  { stepM: 20 }
 */
export function buildLevel(tour, routes, opts = {}) {
    const stepM = opts.stepM || 20;
    const itinerary = Array.isArray(tour.itinerary) ? tour.itinerary : [];
    const days = itinerary.map((day, i) => {
        const dayNo = Number(day.day) || i + 1;
        const stops = (day.stops || []).map((s, j) => stopRecord(s, dayNo, j));
        const pts = routes && Array.isArray(routes[String(dayNo)]) ? routes[String(dayNo)] : null;
        let route = null;
        if (pts && pts.length >= 2) {
            const cum = cumulative(pts);
            route = {
                points: pts,
                lengthM: cum[cum.length - 1],
                samples: resample(pts, stepM),
            };
            // Place each located stop at its distance along the route.
            for (const s of stops) {
                if (typeof s.lat !== 'number' || typeof s.lng !== 'number') continue;
                const near = nearestVertex(pts, [s.lng, s.lat]);
                s.alongM = cum[near.index];
                s.offRouteM = near.offM;
            }
        }
        return {
            day: dayNo,
            title: day.title || '',
            description: day.description || '',
            hotel: day.hotel || '',
            image: day.image || null,
            stops,
            route,
        };
    });
    const aiStops = days.flatMap((d) => d.stops.filter((s) => s.aiScene && s.aiScene.panoramaUrl));
    // tourCode is the booking code (e.g. "SOT#2094010-40"), not the id; the
    // numeric id comes from the caller, who knows which file it loaded.
    return {
        tourId: opts.tourId != null ? String(opts.tourId) : (tour.id != null ? String(tour.id) : null),
        name: tour.eventNameFull || tour.eventNameShort || '',
        dateFull: tour.dateFull || '',
        durationDays: tour.durationDays || days.length,
        tourUrl: tour.products_url || null,
        days,
        aiStops,
        drivableDays: days.filter((d) => d.route).map((d) => d.day),
    };
}

/** Browser loader. base is the folder that holds kv_json_exports/. */
export async function loadLevel(tourId, base = '.', opts = {}) {
    const get = async (path, optional) => {
        const res = await fetch(`${base}/kv_json_exports/${path}`);
        if (!res.ok) {
            if (optional) return null;
            throw new Error(`${path}: HTTP ${res.status}`);
        }
        return res.json();
    };
    const [tour, routes] = await Promise.all([
        get(`tour_${tourId}.json`, false),
        get(`tour_${tourId}_routes.json`, true),
    ]);
    return buildLevel(tour, routes, { ...opts, tourId });
}

/** One-screen summary used by the Day 1 check page and the Node script. */
export function describe(level) {
    const lines = [];
    lines.push(`Tour ${level.tourId}: ${level.name} (${level.durationDays} days)`);
    lines.push(`Days with a road polyline: ${level.drivableDays.join(', ') || 'none'}`);
    for (const d of level.days) {
        const r = d.route ? ` | route ${(d.route.lengthM / 1000).toFixed(1)} km, ${d.route.points.length} pts, ${d.route.samples.length} samples` : '';
        lines.push(`Day ${d.day}: ${d.title} | stops ${d.stops.length}${r}`);
        for (const s of d.stops) {
            const along = typeof s.alongM === 'number' ? ` @ ${(s.alongM / 1000).toFixed(1)} km (${Math.round(s.offRouteM)} m off route)` : '';
            lines.push(`    - ${s.name}${s.aiScene ? ' [AI 360]' : ''}${along}`);
        }
    }
    lines.push(`AI 360 stops: ${level.aiStops.length}`);
    for (const s of level.aiStops) lines.push(`    - day ${s.day}: ${s.name} -> ${s.aiScene.panoramaUrl}`);
    return lines.join('\n');
}
