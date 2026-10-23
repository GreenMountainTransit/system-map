// GMT live map relay (Cloudflare Worker). Paste this whole file into the Worker's code editor.
//
// It fetches GMT's real-time data from Swiftly on a fixed schedule and shares it with every map visitor,
// so the Swiftly key stays private and Swiftly sees the same small number of requests however busy the
// site gets.
//
//   GET /v1/vehicles      bus locations (Swiftly's JSON, refreshed every 15 s)
//   GET /v1/trip-updates  predicted times for every trip, plus active detours (every 15 s)
//   GET /v1/alerts        service alerts (every 60 s)
//
// Settings (Worker → Settings → Variables and Secrets):
//   SWIFTLY_KEY      (Secret, required)  GMT's Swiftly API key
//   ALLOWED_ORIGINS  (Text, optional)    sites allowed to read the relay, comma-separated.
//                                        Default: https://greenmountaintransit.github.io
//   AGENCY           (Text, optional)    Swiftly agency key. Default: green-mountain
//   VEHICLES_TTL     (Text, optional)    seconds between bus-location refreshes. Default 15. Set to 5 for
//                                        smoother "follow a bus" once Swiftly's limit allows (~255 requests
//                                        per 15 minutes per Cloudflare location at 5).

const FEEDS = {
  vehicles: { path: "/vehicles", ttl: 15, kind: "json" },
  "trip-updates": { path: "/gtfs-rt-trip-updates?enable-feature=duplicated-trips&enable-feature=trip-modifications", ttl: 15, kind: "tripUpdates" },
  alerts: { path: "/gtfs-rt-alerts", ttl: 60, kind: "alerts" },
};
const STALE_OK = 600; // if Swiftly is briefly unreachable, keep serving the last data for up to 10 minutes

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "https://greenmountaintransit.github.io").split(",").map((s) => s.trim());
    const cors = { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Vary": "Origin" };
    if (request.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    if (url.pathname === "/" || url.pathname === "/health") return new Response("GMT live map relay is running.", { headers: { "Content-Type": "text/plain", ...cors } });
    const name = url.pathname.replace(/^\/v1\//, "");
    const feed = name === "vehicles" && Number(env.VEHICLES_TTL) >= 3 ? { ...FEEDS.vehicles, ttl: Number(env.VEHICLES_TTL) } : FEEDS[name];
    if (!feed) return json({ error: "Not found" }, 404, cors);
    if (!env.SWIFTLY_KEY) return json({ error: "The relay's SWIFTLY_KEY secret isn't set." }, 500, cors);
    try {
      const { body, age, stale } = await getFeed(name, feed, env, ctx);
      return json(body, 200, { ...cors, "Cache-Control": `public, max-age=${Math.max(1, feed.ttl - age)}`, ...(stale ? { "X-Relay-Stale": "1" } : {}) });
    } catch (e) {
      return json({ error: String(e.message || e) }, 502, cors);
    }
  },
};

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// One Swiftly request per feed per refresh interval: shared in memory, then through Cloudflare's cache.
const memory = new Map();
async function getFeed(name, feed, env, ctx) {
  const now = Date.now() / 1000, hit = memory.get(name);
  if (hit && now - hit.at < feed.ttl) return { body: hit.body, age: Math.floor(now - hit.at) };
  if (hit?.pending) return hit.pending;
  const cache = caches.default, key = new Request(`https://relay.cache/${name}`);
  const pending = (async () => {
    const cached = await cache.match(key);
    if (cached) {
      const at = Number(cached.headers.get("X-At")), body = await cached.json();
      if (now - at < feed.ttl) { memory.set(name, { at, body }); return { body, age: Math.floor(now - at) }; }
      try { return await refresh(name, feed, env, ctx, cache, key); }
      catch (e) { if (now - at < STALE_OK) return { body, age: feed.ttl, stale: true }; throw e; }
    }
    return refresh(name, feed, env, ctx, cache, key);
  })();
  memory.set(name, { ...(hit || {}), pending });
  try { return await pending; } finally { const m = memory.get(name); if (m?.pending === pending) delete m.pending; }
}
async function refresh(name, feed, env, ctx, cache, key) {
  const agency = env.AGENCY || "green-mountain";
  const base = env.SWIFTLY_BASE || "https://api.goswift.ly/real-time"; // SWIFTLY_BASE is only for testing
  const res = await fetch(`${base}/${agency}${feed.path}`, { headers: { Authorization: env.SWIFTLY_KEY } });
  if (!res.ok) throw new Error(`Swiftly ${name} returned ${res.status}`);
  const body = feed.kind === "json" ? await res.json()
    : feed.kind === "tripUpdates" ? decodeTripUpdates(new Uint8Array(await res.arrayBuffer()))
    : decodeAlerts(new Uint8Array(await res.arrayBuffer()));
  const at = Date.now() / 1000;
  memory.set(name, { at, body });
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "X-At": String(at), "Cache-Control": `public, max-age=${STALE_OK}` } })));
  return { body, age: 0 };
}

// ---------- minimal GTFS-realtime (protobuf) reader ----------
const utf8 = new TextDecoder(); // one shared text decoder (making a new one per string is slow)
function reader(buf) {
  let pos = 0;
  // Varints read with plain numbers (fast); 64-bit values are combined from two 32-bit halves.
  const varint = () => {
    let lo = 0, hi = 0, shift = 0, b;
    do { b = buf[pos++]; if (shift < 28) lo |= (b & 0x7f) << shift; else if (shift === 28) { lo |= (b & 0x0f) << 28; hi |= (b & 0x7f) >> 4; } else hi |= (b & 0x7f) << (shift - 32); shift += 7; } while (b & 0x80);
    return [lo >>> 0, hi >>> 0];
  };
  const uint = () => { const [lo, hi] = varint(); return hi * 4294967296 + lo; };
  const skip = (w) => { if (w === 0) varint(); else if (w === 1) pos += 8; else if (w === 2) { const n = uint(); pos += n; } else if (w === 5) pos += 4; else throw new Error("bad wire type " + w); };
  const message = (end, on) => { while (pos < end) { const tag = uint(), f = tag >>> 3, w = tag & 7; if (!on(f, w)) skip(w); } };
  const sub = (fn) => { const n = uint(), end = pos + n, out = fn(end); pos = end; return out; };
  const str = () => { const n = uint(), s = utf8.decode(buf.subarray(pos, pos + n)); pos += n; return s; };
  const int = () => { const [lo, hi] = varint(); return hi >= 0x80000000 ? (hi - 4294967296) * 4294967296 + lo : hi * 4294967296 + lo; }; // signed (negative delays)
  const float = () => { const v = new DataView(buf.buffer, buf.byteOffset + pos, 4).getFloat32(0, true); pos += 4; return v; };
  return { message, sub, str, int, float, get length() { return buf.length; } };
}
// English text from a TranslatedString (falls back to the first translation).
function translated(r) {
  return (end) => {
    const t = [];
    r.message(end, (f, w) => {
      if (f === 1 && w === 2) { const tr = {}; r.sub((e) => r.message(e, (g, x) => { if (g === 1 && x === 2) { tr.text = r.str(); return true; } if (g === 2 && x === 2) { tr.lang = r.str(); return true; } return false; })); t.push(tr); return true; }
      return false;
    });
    return (t.find((x) => !x.lang || /^en/i.test(x.lang)) || t[0] || {}).text || "";
  };
}
function decodePolyline(s) {
  const out = []; let i = 0, lat = 0, lon = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, result = 0;
      do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    out.push([Math.round(lon * 1e-5 * 1e6) / 1e6, Math.round(lat * 1e-5 * 1e6) / 1e6]);
  }
  return out;
}

// Trip updates -> { generated, trips: { tripId: [startDate, canceled, [[seq, stopId, time, delay, skipped], ...]] },
//                   detours: [...], stops: { id: { name, c: [lon, lat] } } }
function decodeTripUpdates(buf) {
  const r = reader(buf), trips = {}, shapes = {}, stops = {}, mods = [];
  const stopSel = (end) => { const s = {}; r.message(end, (f, w) => { if (f === 1 && w === 0) { s.seq = r.int(); return true; } if (f === 2 && w === 2) { s.stop = r.str(); return true; } return false; }); return s; };
  r.message(r.length, (f, w) => {
    if (f !== 2 || w !== 2) return false;
    r.sub((eEnd) => {
      let id = "";
      r.message(eEnd, (ef, ew) => {
        if (ef === 1 && ew === 2) { id = r.str(); return true; }
        if (ef === 3 && ew === 2) { // trip update
          const t = { updates: [] };
          r.sub((end) => r.message(end, (g, x) => {
            if (g === 1 && x === 2) { r.sub((e2) => r.message(e2, (h, y) => {
              if (h === 1 && y === 2) { t.tripId = r.str(); return true; }
              if (h === 3 && y === 2) { t.startDate = r.str(); return true; }
              if (h === 4 && y === 0) { t.rel = r.int(); return true; }
              return false; })); return true; }
            if (g === 2 && x === 2) { const u = [null, null, null, null, 0]; r.sub((e2) => r.message(e2, (h, y) => {
              if (h === 1 && y === 0) { u[0] = r.int(); return true; }
              if ((h === 2 || h === 3) && y === 2) { r.sub((e3) => r.message(e3, (k, z) => {
                if (k === 1 && z === 0) { const d = r.int(); if (u[3] == null) u[3] = d; return true; }
                if (k === 2 && z === 0) { const tm = r.int(); if (u[2] == null && tm) u[2] = tm; return true; }
                return false; })); return true; }
              if (h === 4 && y === 2) { u[1] = r.str(); return true; }
              if (h === 5 && y === 0) { u[4] = r.int() === 1 ? 1 : 0; return true; }
              return false; })); t.updates.push(u); return true; }
            return false;
          }));
          if (t.tripId && t.rel !== 1 /* ADDED: not in the timetable */) trips[t.tripId] = [t.startDate || null, t.rel === 3 ? 1 : 0, t.updates];
          return true;
        }
        if (ef === 6 && ew === 2) { // shape (detour path)
          const sh = {}; r.sub((end) => r.message(end, (g, x) => { if (g === 1 && x === 2) { sh.id = r.str(); return true; } if (g === 2 && x === 2) { sh.line = r.str(); return true; } return false; }));
          if (sh.id && sh.line) shapes[sh.id] = decodePolyline(sh.line);
          return true;
        }
        if (ef === 7 && ew === 2) { // stop (temporary stop on a detour)
          const st = {}; r.sub((end) => r.message(end, (g, x) => {
            if (g === 1 && x === 2) { st.id = r.str(); return true; }
            if (g === 3 && x === 2) { st.name = r.sub(translated(r)); return true; }
            if (g === 6 && x === 5) { st.lat = r.float(); return true; }
            if (g === 7 && x === 5) { st.lon = r.float(); return true; }
            return false; }));
          if (st.id) stops[st.id] = { name: st.name || "Temporary stop", c: st.lat != null ? [+st.lon.toFixed(6), +st.lat.toFixed(6)] : null };
          return true;
        }
        if (ef === 8 && ew === 2) { // trip modifications (a detour)
          const m = { id, selected: [], startTimes: [], dates: [], changes: [] };
          r.sub((end) => r.message(end, (g, x) => {
            if (g === 1 && x === 2) { const s = { trips: [] }; r.sub((e2) => r.message(e2, (h, y) => { if (h === 1 && y === 2) { s.trips.push(r.str()); return true; } if (h === 2 && y === 2) { s.shape = r.str(); return true; } return false; })); m.selected.push(s); return true; }
            if (g === 2 && x === 2) { m.startTimes.push(r.str()); return true; }
            if (g === 3 && x === 2) { m.dates.push(r.str()); return true; }
            if (g === 4 && x === 2) { const c = { replacement: [] }; r.sub((e2) => r.message(e2, (h, y) => {
              if (h === 1 && y === 2) { c.start = r.sub(stopSel); return true; }
              if (h === 2 && y === 2) { c.end = r.sub(stopSel); return true; }
              if (h === 4 && y === 2) { const rs = {}; r.sub((e3) => r.message(e3, (k, z) => { if (k === 1 && z === 0) { rs.t = r.int(); return true; } if (k === 2 && z === 2) { rs.stop = r.str(); return true; } return false; })); c.replacement.push(rs); return true; }
              if (h === 5 && y === 2) { c.alert = r.str(); return true; }
              return false; })); m.changes.push(c); return true; }
            return false;
          }));
          mods.push(m);
          return true;
        }
        return false;
      });
    });
    return true;
  });
  const detours = mods.map((m) => ({
    id: m.id, dates: m.dates, startTimes: m.startTimes, changes: m.changes,
    selected: m.selected.map((s) => ({ trips: s.trips, path: shapes[s.shape] || null })),
  }));
  return { generated: Math.floor(Date.now() / 1000), trips, detours, stops };
}

// Alerts -> { generated, alerts: [{ id, cause, effect, header, description, url, periods: [[start, end]], informed: [{ route, stop, trip }] }] }
const CAUSES = [, "UNKNOWN_CAUSE", "OTHER_CAUSE", "TECHNICAL_PROBLEM", "STRIKE", "DEMONSTRATION", "ACCIDENT", "HOLIDAY", "WEATHER", "MAINTENANCE", "CONSTRUCTION", "POLICE_ACTIVITY", "MEDICAL_EMERGENCY", "SPECIAL_EVENT"];
const EFFECTS = [, "NO_SERVICE", "REDUCED_SERVICE", "SIGNIFICANT_DELAYS", "DETOUR", "ADDITIONAL_SERVICE", "MODIFIED_SERVICE", "OTHER_EFFECT", "UNKNOWN_EFFECT", "STOP_MOVED", "NO_EFFECT", "ACCESSIBILITY_ISSUE"];
function decodeAlerts(buf) {
  const r = reader(buf), alerts = [];
  r.message(r.length, (f, w) => {
    if (f !== 2 || w !== 2) return false;
    r.sub((eEnd) => {
      let id = "";
      r.message(eEnd, (ef, ew) => {
        if (ef === 1 && ew === 2) { id = r.str(); return true; }
        if (ef !== 5 || ew !== 2) return false;
        const a = { id, periods: [], informed: [] };
        r.sub((end) => r.message(end, (g, x) => {
          if (g === 1 && x === 2) { const p = [null, null]; r.sub((e2) => r.message(e2, (h, y) => { if (h === 1 && y === 0) { p[0] = r.int(); return true; } if (h === 2 && y === 0) { p[1] = r.int(); return true; } return false; })); a.periods.push(p); return true; }
          if (g === 5 && x === 2) { const s = {}; r.sub((e2) => r.message(e2, (h, y) => {
            if (h === 2 && y === 2) { s.route = r.str(); return true; }
            if (h === 5 && y === 2) { s.stop = r.str(); return true; }
            if (h === 4 && y === 2) { r.sub((e3) => r.message(e3, (k, z) => { if (k === 1 && z === 2) { s.trip = r.str(); return true; } if (k === 5 && z === 2) { s.route ??= r.str(); return true; } return false; })); return true; }
            return false; })); a.informed.push(s); return true; }
          if (g === 6 && x === 0) { a.cause = CAUSES[r.int()] || "UNKNOWN_CAUSE"; return true; }
          if (g === 7 && x === 0) { a.effect = EFFECTS[r.int()] || "UNKNOWN_EFFECT"; return true; }
          if (g === 8 && x === 2) { a.url = r.sub(translated(r)); return true; }
          if (g === 10 && x === 2) { a.header = r.sub(translated(r)); return true; }
          if (g === 11 && x === 2) { a.description = r.sub(translated(r)); return true; }
          return false;
        }));
        alerts.push(a);
        return true;
      });
    });
    return true;
  });
  return { generated: Math.floor(Date.now() / 1000), alerts };
}
