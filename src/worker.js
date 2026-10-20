// GMT system map backend (Cloudflare Worker).
// Two small APIs (and, if deployed with assets, the map files in /public):
//   GET /api/vehicles                 -> live bus positions (GeoJSON)
//   GET /api/arrivals?stop=STOP_ID    -> next 3 arrivals at one stop, all routes
//   GET /api/arrivals?route=ROUTE_ID  -> next 3 arrivals per direction for every stop on one route
// Swiftly GTFS-realtime is fetched at most once per CACHE_SECONDS no matter how
// many people have the map open. The API key lives in the SWIFTLY_KEY secret.
// When the map is hosted elsewhere (e.g. GitHub Pages), set DATA_BASE in wrangler.toml
// to that site's data folder so the Worker and the page always use the same schedule.

import GtfsRealtimeBindings from "gtfs-realtime-bindings";
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

const AGENCY = "green-mountain";
const TZ = "America/New_York";
const CACHE_SECONDS = 15;
const COUNT = 3;
const STALE_VEHICLE_SECONDS = 180;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/vehicles") return json(await cached(ctx, url, () => vehicles(env, ctx, url)));
      if (url.pathname === "/api/arrivals") {
        const stop = url.searchParams.get("stop"), route = url.searchParams.get("route");
        if (!stop && !route) return json({ error: "Pass ?stop= or ?route=" }, 400);
        return json(await cached(ctx, url, () => arrivals(env, ctx, url, { stop, route })));
      }
    } catch (err) {
      return json({ error: String(err.message || err) }, 502);
    }
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  },
};

// ---------- helpers ----------
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}`, "Access-Control-Allow-Origin": "*" },
  });
}

// Edge cache for computed API responses, keyed by full URL.
async function cached(ctx, url, make) {
  const cache = globalThis.caches?.default;
  const key = new Request(url.toString());
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit.json();
  }
  const body = await make();
  if (cache) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), { headers: { "Cache-Control": `public, max-age=${CACHE_SECONDS}` } })));
  return body;
}

// Schedule data files, from DATA_BASE (e.g. GitHub Pages) or this Worker's own assets.
// Kept in memory for DATA_TTL so a rebuilt schedule is picked up within the hour.
const memo = new Map();
const DATA_TTL = 3600 * 1000;
async function data(env, url, file) {
  const hit = memo.get(file);
  if (hit && Date.now() - hit.at < DATA_TTL) return hit.body;
  const res = env.DATA_BASE
    ? await fetch(env.DATA_BASE.replace(/\/?$/, "/") + file, { cf: { cacheTtl: 600 } })
    : await env.ASSETS.fetch(new Request(new URL(`/data/${file}`, url.origin)));
  if (!res.ok) throw new Error(`Missing data file ${file}. Run scripts/build-data.mjs and publish.`);
  const body = await res.json();
  memo.set(file, { at: Date.now(), body });
  return body;
}

// Swiftly GTFS-realtime feed, decoded and shared through the edge cache.
async function feed(env, ctx, url, kind) {
  const key = new URL(`/__feed/${kind}`, url.origin).toString();
  return cached(ctx, new URL(key), async () => {
    let res;
    try {
      res = await fetch(`https://api.goswift.ly/real-time/${AGENCY}/gtfs-rt-${kind}`, { headers: { Authorization: env.SWIFTLY_KEY } });
    } catch {
      throw new Error(`Could not reach Swiftly for ${kind}`);
    }
    if (!res.ok) throw new Error(`Swiftly ${kind} returned ${res.status}`);
    const msg = FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
    return FeedMessage.toObject(msg, { longs: Number, enums: String, defaults: false });
  });
}

// ---------- vehicles ----------
async function vehicles(env, ctx, url) {
  const [rt, headsigns] = await Promise.all([feed(env, ctx, url, "vehicle-positions"), data(env, url, "headsigns.json")]);
  const now = Date.now() / 1000;
  const features = [];
  for (const e of rt.entity || []) {
    const v = e.vehicle;
    if (!v?.position || !v.trip?.routeId) continue;
    if (v.timestamp && now - v.timestamp > STALE_VEHICLE_SECONDS) continue;
    features.push({
      type: "Feature",
      properties: {
        id: v.vehicle?.id || e.id, label: v.vehicle?.label || "",
        route_id: v.trip.routeId, headsign: headsigns[v.trip.tripId] || "",
        heading: v.position.bearing ?? null, time: (v.timestamp || now) * 1000,
      },
      geometry: { type: "Point", coordinates: [v.position.longitude, v.position.latitude] },
    });
  }
  return { type: "FeatureCollection", features };
}

// ---------- arrivals ----------
function localClock() {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const secs = +p.hour * 3600 + +p.minute * 60 + +p.second;
  const now = Math.floor(Date.now() / 1000);
  return { now, midnight: now - secs, ymd: `${p.year}${p.month}${p.day}` };
}
function shiftYmd(ymd, days) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8) + days, 12));
  return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ""), dow: (d.getUTCDay() + 6) % 7 }; // Monday = 0
}
function servicesOn(cal, ymd, dow) {
  const on = new Set(cal.cal.filter((c) => c.a <= ymd && ymd <= c.b && c.d[dow]).map((c) => c.s));
  const ex = cal.ex[ymd];
  if (ex) { ex.add.forEach((s) => on.add(s)); ex.rm.forEach((s) => on.delete(s)); }
  return on;
}

// Index realtime trip updates by trip_id.
function indexTripUpdates(rt) {
  const out = new Map();
  for (const e of rt.entity || []) {
    const tu = e.tripUpdate;
    if (!tu?.trip?.tripId) continue;
    out.set(tu.trip.tripId, {
      startDate: tu.trip.startDate || null,
      canceled: tu.trip.scheduleRelationship === "CANCELED",
      updates: (tu.stopTimeUpdate || []).map((u) => ({
        seq: u.stopSequence, stop: u.stopId,
        time: u.arrival?.time ?? u.departure?.time ?? null,
        delay: u.arrival?.delay ?? u.departure?.delay ?? null,
        skipped: u.scheduleRelationship === "SKIPPED",
      })).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    });
  }
  return out;
}

// Apply a trip's realtime update to its scheduled time at one stop.
// Returns {epoch, live} or null when the stop is skipped / trip canceled.
function applyRealtime(tu, trip, idx, scheduledEpoch, dayMidnight) {
  if (!tu) return { epoch: scheduledEpoch, live: false };
  if (tu.canceled) return null;
  const [stopId, , seq] = trip.st[idx];
  const exact = tu.updates.find((u) => (u.seq != null ? u.seq === seq : u.stop === stopId));
  if (exact) {
    if (exact.skipped) return null;
    if (exact.time) return { epoch: exact.time, live: true };
    if (exact.delay != null) return { epoch: scheduledEpoch + exact.delay, live: true };
  }
  // Otherwise carry forward the delay from the nearest earlier update on this trip.
  let delay = null;
  for (const u of tu.updates) {
    if ((u.seq ?? Infinity) >= seq) break;
    if (u.delay != null) delay = u.delay;
    else if (u.time) {
      const s = trip.st.find((x) => x[2] === u.seq);
      if (s) delay = u.time - (dayMidnight + s[1]);
    }
  }
  return delay != null ? { epoch: scheduledEpoch + delay, live: true } : { epoch: scheduledEpoch, live: false };
}

// A trip_id repeats every service day, so only one day's instance gets the live update:
// the one named by the feed's start_date, or else the instance running closest to now.
function realtimeFor(tu, trip, day, days, now) {
  if (!tu) return null;
  if (tu.startDate) return tu.startDate === day.ymd ? tu : null;
  const mid = (d) => d.midnight + (trip.st[0][1] + trip.st[trip.st.length - 1][1]) / 2;
  const best = days.filter((d) => d.services.has(trip.s)).sort((a, b) => Math.abs(mid(a) - now) - Math.abs(mid(b) - now))[0];
  return best === day ? tu : null;
}

async function arrivals(env, ctx, url, { stop, route }) {
  const [meta, cal, stops, rt] = await Promise.all([
    data(env, url, "routes.json"), data(env, url, "calendar.json"),
    data(env, url, "stops.geojson"), feed(env, ctx, url, "trip-updates"),
  ]);
  let routeIds;
  if (route) {
    if (!meta.stops[route]) throw new Error(`Unknown route ${route}`);
    routeIds = [route];
  } else {
    const f = stops.features.find((x) => x.properties.stop_id === stop);
    if (!f) throw new Error(`Unknown stop ${stop}`);
    routeIds = f.properties.routes;
  }

  const clock = localClock();
  const days = [-1, 0, 1].map((offset) => {
    const { ymd, dow } = shiftYmd(clock.ymd, offset);
    return { ymd, midnight: clock.midnight + offset * 86400, services: servicesOn(cal, ymd, dow) };
  });
  const tus = indexTripUpdates(rt);
  const routeById = Object.fromEntries(meta.routes.map((r) => [r.route_id, r]));
  const result = {}; // stop_id -> [arrival]

  for (const rid of routeIds) {
    const sched = await data(env, url, `sched/${encodeURIComponent(rid)}.json`);
    for (const day of days) {
      for (const trip of sched) {
        if (!day.services.has(trip.s)) continue;
        const tu = realtimeFor(tus.get(trip.t), trip, day, days, clock.now);
        for (let i = 0; i < trip.st.length - 1; i++) { // skip the final stop: buses don't depart from it
          const sid = trip.st[i][0];
          if (stop && sid !== stop) continue;
          const scheduled = day.midnight + trip.st[i][1];
          if (scheduled < clock.now - 3 * 3600 || scheduled > clock.now + 30 * 3600) continue;
          const r = applyRealtime(tu, trip, i, scheduled, day.midnight);
          if (!r || r.epoch < clock.now - 30) continue;
          (result[sid] ??= []).push({
            route_id: rid, short_name: routeById[rid]?.short_name || rid, color: routeById[rid]?.color,
            headsign: trip.h, direction: trip.d, time: r.epoch, live: r.live,
          });
        }
      }
    }
  }
  const next = (list) => list.sort((a, b) => a.time - b.time).slice(0, COUNT);
  for (const sid in result) {
    if (stop) { result[sid] = next(result[sid]); continue; }
    // Route view: next 3 per direction, so each direction's stop list gets its own times.
    const byDir = {};
    for (const a of result[sid]) (byDir[a.direction] ??= []).push(a);
    for (const d in byDir) byDir[d] = next(byDir[d]);
    result[sid] = byDir;
  }
  return { generated: clock.now, arrivals: result };
}
