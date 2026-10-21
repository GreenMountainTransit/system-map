// Turns GMT's GTFS schedule into the files the map uses, adding stop amenities,
// route descriptions and nearby places (food, shopping, restrooms) from OpenStreetMap.
//
//   node scripts/build-data.mjs <unzipped-gtfs-folder> [amenities.csv]
//
// Also reads route-info.json (descriptions and legend groups) from the repo root.
// Writes to public/data/. The GitHub workflow runs this nightly and on every change.

import fs from "node:fs";
import path from "node:path";

const [gtfsDir, amenitiesFile] = process.argv.slice(2);
if (!gtfsDir) { console.error("Usage: node scripts/build-data.mjs <gtfs-folder> [amenities.csv]"); process.exit(1); }
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(ROOT, "public", "data");
fs.rmSync(path.join(OUT, "sched"), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "sched"), { recursive: true });

// ---------- CSV ----------
function parseCsv(text) {
  text = text.replace(/^\uFEFF/, "");
  const rows = []; let row = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const keys = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}
const read = (file, optional = false) => {
  const p = path.join(gtfsDir, file);
  if (!fs.existsSync(p)) { if (optional) return []; throw new Error(`Missing ${file}`); }
  return parseCsv(fs.readFileSync(p, "utf8"));
};
const toSecs = (t) => { if (!t) return null; const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
const mostCommon = (arr) => { const m = new Map(); arr.forEach((x) => m.set(x, (m.get(x) || 0) + 1)); return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]; };
const write = (f, obj) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(obj));

const routes = read("routes.txt");
const trips = read("trips.txt");
const stops = read("stops.txt");
const stopTimes = read("stop_times.txt");
const shapes = read("shapes.txt", true);
const calendar = read("calendar.txt", true);
const calendarDates = read("calendar_dates.txt", true);
const routeInfo = fs.existsSync(path.join(ROOT, "route-info.json")) ? JSON.parse(fs.readFileSync(path.join(ROOT, "route-info.json"), "utf8")) : { groups: [], routes: {} };

// ---------- stop times per trip, with timepoints and interpolation ----------
const hasTimepointColumn = stopTimes.length > 0 && "timepoint" in stopTimes[0];
const timepointStops = new Set();
const byTrip = new Map();
for (const st of stopTimes) {
  const t = toSecs(st.departure_time || st.arrival_time);
  const isTimepoint = hasTimepointColumn ? st.timepoint === "1" : t != null;
  if (isTimepoint) timepointStops.add(st.stop_id);
  if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
  byTrip.get(st.trip_id).push([st.stop_id, t, +st.stop_sequence]);
}
for (const list of byTrip.values()) {
  list.sort((a, b) => a[2] - b[2]);
  let last = -1;
  for (let i = 0; i < list.length; i++) {
    if (list[i][1] == null) continue;
    if (last >= 0 && i - last > 1) {
      const step = (list[i][1] - list[last][1]) / (i - last);
      for (let j = last + 1; j < i; j++) list[j][1] = Math.round(list[last][1] + step * (j - last));
    }
    last = i;
  }
  for (let i = list.length - 1; i >= 0; i--) if (list[i][1] == null) list.splice(i, 1);
}

// ---------- calendar helpers ----------
const cal = {
  cal: calendar.map((c) => ({ s: c.service_id, a: c.start_date, b: c.end_date,
    d: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((k) => c[k] === "1") })),
  ex: {},
};
for (const x of calendarDates) {
  cal.ex[x.date] ??= { add: [], rm: [] };
  cal.ex[x.date][x.exception_type === "1" ? "add" : "rm"].push(x.service_id);
}
function servicesOn(ymd, dow) {
  const on = new Set(cal.cal.filter((c) => c.a <= ymd && ymd <= c.b && c.d[dow]).map((c) => c.s));
  const ex = cal.ex[ymd];
  if (ex) { ex.add.forEach((s) => on.add(s)); ex.rm.forEach((s) => on.delete(s)); }
  return on;
}
// The next 14 days, starting today in Vermont.
const todayNY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()); // YYYY-MM-DD
const upcoming = Array.from({ length: 14 }, (_, i) => {
  const d = new Date(`${todayNY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
  return { ymd: d.toISOString().slice(0, 10).replace(/-/g, ""), dow: (d.getUTCDay() + 6) % 7 };
});

// ---------- per-route schedules, stop order, service summaries ----------
const routeById = Object.fromEntries(routes.map((r) => [r.route_id, r]));
const stopById = Object.fromEntries(stops.map((s) => [s.stop_id, s]));
const routeStops = {};
const stopRoutes = new Map();
const headsigns = {};
const tripsByRoute = new Map();
for (const t of trips) {
  if (!byTrip.has(t.trip_id) || !routeById[t.route_id]) continue;
  if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
  tripsByRoute.get(t.route_id).push(t);
  headsigns[t.trip_id] = t.trip_headsign || "";
}

// How often a route runs on a given day, by time of day, measured at its busiest stop in its busiest direction.
const PERIODS = { am: [6, 9], mid: [9, 15], pm: [15, 18], eve: [18, 30] }; // hours
function headwayIn(times, [h0, h1]) {
  const t = times.filter((x) => x >= h0 * 3600 && x < h1 * 3600);
  if (t.length < 3) return null;
  const gaps = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b);
  return Math.max(5, Math.round(gaps[Math.floor(gaps.length / 2)] / 60 / 5) * 5);
}
function daySummary(sched, ymd, dow) {
  const on = servicesOn(ymd, dow);
  const running = sched.filter((x) => on.has(x.s));
  if (!running.length) return null;
  const dir = mostCommon(running.map((x) => x.d));
  const inDir = running.filter((x) => x.d === dir);
  const refStop = mostCommon(inDir.flatMap((x) => x.st.slice(0, -1).map((s) => s[0])));
  const times = inDir.map((x) => x.st.find((s) => s[0] === refStop)?.[1]).filter((t) => t != null).sort((a, b) => a - b);
  const periods = Object.fromEntries(Object.entries(PERIODS).map(([k, w]) => [k, headwayIn(times, w)]));
  // Trip counts by part of day, for routes with only a few trips.
  const parts = { morning: 0, midday: 0, afternoon: 0, evening: 0 };
  for (const t of times) parts[t < 10 * 3600 ? "morning" : t < 15 * 3600 ? "midday" : t < 19 * 3600 ? "afternoon" : "evening"]++;
  // First and last departure from each direction's starting point (e.g. "from Downtown Transit Center").
  const dirs = [...new Set(running.map((x) => x.d))].sort().map((d) => {
    const ts = running.filter((x) => x.d === d);
    const origin = mostCommon(ts.map((x) => x.st[0][0]));
    const deps = ts.map((x) => x.st.slice(0, -1).find((s) => s[0] === origin)?.[1]).filter((t) => t != null).sort((a, b) => a - b);
    return deps.length ? { from: stopById[origin]?.stop_name || "", first: deps[0], last: deps[deps.length - 1], trips: deps.length } : null;
  }).filter(Boolean);
  return {
    trips: inDir.length, headway: headwayIn(times, [7, 19]), periods, parts, dirs,
    first: running.map((x) => x.st[0][1]).sort((a, b) => a - b)[0],
    last: running.map((x) => x.st[x.st.length - 1][1]).sort((a, b) => b - a)[0],
  };
}

const service = {};
const schedByRoute = new Map();
for (const [routeId, list] of tripsByRoute) {
  const sched = list.map((t) => ({ t: t.trip_id, s: t.service_id, h: t.trip_headsign || "", d: t.direction_id || "0", st: byTrip.get(t.trip_id) }));
  fs.writeFileSync(path.join(OUT, "sched", `${encodeURIComponent(routeId)}.json`), JSON.stringify(sched));

  routeStops[routeId] = {};
  for (const d of [...new Set(sched.map((x) => x.d))].sort()) {
    const inDir = sched.filter((x) => x.d === d);
    const pattern = mostCommon(inDir.map((x) => x.st.map((s) => s[0]).join("|")));
    const matching = inDir.filter((x) => x.st.map((s) => s[0]).join("|") === pattern);
    routeStops[routeId][d] = { headsign: mostCommon(matching.map((x) => x.h)) || "", stops: pattern.split("|") };
  }
  for (const x of sched) for (const [sid] of x.st) {
    if (!stopRoutes.has(sid)) stopRoutes.set(sid, new Set());
    stopRoutes.get(sid).add(routeId);
  }

  const days = [0, 1, 2, 3, 4, 5, 6].map((dow) => upcoming.filter((u) => u.dow === dow).some((u) => {
    const on = servicesOn(u.ymd, u.dow); return sched.some((x) => on.has(x.s));
  }));
  const pick = (dows) => { for (const u of upcoming) if (dows.includes(u.dow)) { const s = daySummary(sched, u.ymd, u.dow); if (s) return s; } return null; };
  service[routeId] = { days, weekday: pick([0, 1, 2, 3, 4]), saturday: pick([5]), sunday: pick([6]) };
  schedByRoute.set(routeId, sched);
}

// ---------- legend groups and descriptions ----------
function groupFor(short) {
  for (const g of routeInfo.groups || []) {
    if (g.routes?.includes(short)) return g.id;
    if (g.range && /^\d+$/.test(short) && +short >= g.range[0] && +short <= g.range[1]) return g.id;
  }
  return (routeInfo.groups || [])[0]?.id || "local";
}
const routeMeta = (r) => {
  const short = r.route_short_name || r.route_id;
  const group = groupFor(short);
  return {
    route_id: r.route_id, short_name: short, long_name: r.route_long_name || "",
    color: "#" + (r.route_color || "00703C"), text_color: "#" + (r.route_text_color || "FFFFFF"),
    sort: Number(r.route_sort_order) || 0, group,
    description: routeInfo.routes?.[short] || (group === "school" ? `School-day trips: ${r.route_long_name}.` : ""),
    service: service[r.route_id] || null,
  };
};

// ---------- route lines: every distinct shape the route uses ----------
const shapesByRoute = new Map(); // route_id -> Set(shape_id)
for (const t of trips) if (t.shape_id && routeById[t.route_id] && byTrip.has(t.trip_id)) {
  if (!shapesByRoute.has(t.route_id)) shapesByRoute.set(t.route_id, new Set());
  shapesByRoute.get(t.route_id).add(t.shape_id);
}
const shapePts = new Map();
for (const s of shapes) {
  if (!shapePts.has(s.shape_id)) shapePts.set(s.shape_id, []);
  shapePts.get(s.shape_id).push([+s.shape_pt_sequence, +(+s.shape_pt_lon).toFixed(5), +(+s.shape_pt_lat).toFixed(5)]);
}
const lineFeatures = [];
for (const routeId of tripsByRoute.keys()) {
  const props = (({ route_id, short_name, color, group }) => ({ route_id, short_name, color, group }))(routeMeta(routeById[routeId]));
  const seen = new Set();
  for (const shapeId of shapesByRoute.get(routeId) || []) {
    const pts = shapePts.get(shapeId); if (!pts) continue;
    const coords = pts.sort((a, b) => a[0] - b[0]).map(([, lo, la]) => [lo, la]);
    const key = coords.join(";"); if (seen.has(key)) continue; seen.add(key);
    lineFeatures.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } });
  }
  if (!seen.size) for (const d of Object.values(routeStops[routeId])) // no shapes.txt: connect stops in order
    lineFeatures.push({ type: "Feature", properties: props,
      geometry: { type: "LineString", coordinates: d.stops.map((id) => stopById[id]).filter(Boolean).map((s) => [+s.stop_lon, +s.stop_lat]) } });
}

// ---------- frequency map: combined frequency on every street segment between stops ----------
// Local routes only, weekdays only. Routes sharing a street add up, so corridors like Main Street
// show their real combined frequency.
const FREQ_WINDOWS = {
  peak: { day: "weekday", hours: [[7, 9], [16, 18]] },
  mid: { day: "weekday", hours: [[9, 15]] },
  eve: { day: "weekday", hours: [[19, 22]] },
};
const freqDays = { weekday: upcoming.find((u) => u.dow < 5 && servicesOn(u.ymd, u.dow).size) };
const freqFeatures = [];
{
  const tripShape = Object.fromEntries(trips.map((t) => [t.trip_id, t.shape_id]));
  const segs = new Map(); // "a>b" -> { coords, n: {peak, mid, ...}, routes:Set }
  const sliceCache = new Map();
  // Cut a shape into pieces between consecutive stops by projecting each stop onto it in order.
  function hops(shapeId, stopIds) {
    const key = shapeId + "|" + stopIds.join(",");
    if (sliceCache.has(key)) return sliceCache.get(key);
    const line = shapeId && shapePts.get(shapeId) ? shapePts.get(shapeId).slice().sort((a, b) => a[0] - b[0]).map(([, lo, la]) => [lo, la]) : null;
    const pts = stopIds.map((id) => stopById[id] && [+stopById[id].stop_lon, +stopById[id].stop_lat]);
    let out;
    if (!line || line.length < 2 || pts.some((p) => !p)) out = pts.slice(1).map((p, i) => [pts[i], p].filter(Boolean));
    else {
      const k = Math.cos((pts[0][1] * Math.PI) / 180);
      const proj = (p, from) => {
        let best = { d: Infinity, i: from, t: 0, pt: line[from] };
        for (let i = from; i < line.length - 1; i++) {
          const [ax, ay] = line[i], [bx, by] = line[i + 1];
          const dx = (bx - ax) * k, dy = by - ay, px = (p[0] - ax) * k, py = p[1] - ay;
          const L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, (px * dx + py * dy) / L)) : 0;
          const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
          if (d < best.d) best = { d, i, t, pt: [ax + (bx - ax) * t, ay + (by - ay) * t] };
          if (best.d < 1e-9 && i > best.i + 40) break;
        }
        return best;
      };
      let prev = proj(pts[0], 0);
      out = [];
      for (let j = 1; j < pts.length; j++) {
        const cur = proj(pts[j], prev.i);
        out.push([prev.pt, ...line.slice(prev.i + 1, cur.i + 1), cur.pt].map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)]));
        prev = cur;
      }
    }
    sliceCache.set(key, out);
    return out;
  }
  const windowsFor = Object.fromEntries(Object.keys(freqDays).map((day) => [day, Object.entries(FREQ_WINDOWS).filter(([, w]) => w.day === day)]));
  for (const [day, u] of Object.entries(freqDays)) {
    if (!u) continue;
    const on = servicesOn(u.ymd, u.dow);
    for (const [routeId, sched] of schedByRoute) {
      const g = groupFor(routeById[routeId].route_short_name || routeId);
      if (g !== "local") continue; // no commuter/express, school or shopping routes
      for (const trip of sched) {
        if (!on.has(trip.s)) continue;
        const ids = trip.st.map((x) => x[0]);
        const pieces = hops(tripShape[trip.t], ids);
        for (let i = 0; i < ids.length - 1; i++) {
          if (ids[i] === ids[i + 1]) continue;
          const key = ids[i] + ">" + ids[i + 1];
          if (!segs.has(key)) segs.set(key, { coords: pieces[i], times: [], routes: new Set() });
          const sg = segs.get(key);
          sg.routes.add(routeId); sg.times.push(trip.st[i][1]);
        }
      }
    }
  }
  // ---- Never overstate frequency ----
  // 1. Each direction's frequency is its LONGEST wait between buses in the time window, counting the
  //    gaps from the window's start to the first bus and from the last bus to the window's end.
  //    Two routes scheduled two minutes apart therefore count as one bus, not two.
  const maxGap = (times, def) => {
    let worst = 0;
    for (const [h0, h1] of def.hours) {
      const t = times.filter((x) => x >= h0 * 3600 && x < h1 * 3600).sort((a, b) => a - b);
      if (!t.length) return null; // no bus at all in part of the window
      const edges = [h0 * 3600, ...t, h1 * 3600];
      for (let i = 1; i < edges.length; i++) worst = Math.max(worst, edges[i] - edges[i - 1]);
    }
    return Math.ceil(worst / 60);
  };
  const directed = [];
  for (const [key, sg] of segs) {
    if (!sg.coords || sg.coords.length < 2) continue;
    const h = {};
    for (const [w, def] of Object.entries(FREQ_WINDOWS)) h[w] = maxGap(sg.times, def);
    directed.push({ key, coords: sg.coords, h, routes: sg.routes });
  }
  // 2. Both directions: find the service running the opposite way along the same street (it usually
  //    uses different stops on the other side), and show the worse of the two directions.
  const M = 111320, kx = Math.cos((44.5 * Math.PI) / 180);
  const xy = ([lon, lat]) => [lon * M * kx, lat * M];
  const grid = new Map(), CELL = 40; // meters
  const cellKey = (x, y) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;
  const samples = directed.map((d, idx) => {
    const out = [], pts = d.coords.map(xy);
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay);
      if (!L) continue;
      const ux = (bx - ax) / L, uy = (by - ay) / L;
      for (let t = 0; t < L; t += 25) out.push({ x: ax + ux * t, y: ay + uy * t, ux, uy, idx });
    }
    for (const sm of out) { const k = cellKey(sm.x, sm.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(sm); }
    return out;
  });
  for (const [idx, d] of directed.entries()) {
    const opp = new Map(); // opposite segment idx -> matched samples
    for (const sm of samples[idx]) {
      const cx = Math.floor(sm.x / CELL), cy = Math.floor(sm.y / CELL), seen = new Set();
      for (let i = cx - 1; i <= cx + 1; i++) for (let j = cy - 1; j <= cy + 1; j++) for (const o of grid.get(`${i}:${j}`) || []) {
        if (o.idx === idx || seen.has(o.idx)) continue;
        if (Math.hypot(o.x - sm.x, o.y - sm.y) > 30 || o.ux * sm.ux + o.uy * sm.uy > -0.7) continue; // within 30 m, heading the other way
        seen.add(o.idx); opp.set(o.idx, (opp.get(o.idx) || 0) + 1);
      }
    }
    const n = samples[idx].length || 1;
    d.opposite = [...opp].filter(([, c]) => c / n >= 0.3).map(([o]) => directed[o]);
  }
  for (const d of directed) {
    const props = { oneway: d.opposite.length === 0 };
    for (const w of Object.keys(FREQ_WINDOWS)) {
      let h = d.h[w];
      if (h != null && d.opposite.length) {
        const back = d.opposite.map((o) => o.h[w]);
        h = back.some((x) => x == null) ? null : Math.max(h, ...back); // worse direction; none if one direction has no bus then
      }
      props["h_" + w] = h;
    }
    if (Object.keys(FREQ_WINDOWS).every((w) => props["h_" + w] == null)) continue;
    const routesHere = [...new Set([...d.routes, ...d.opposite.flatMap((o) => [...o.routes])])];
    props.routes = routesHere.map((id) => routeById[id].route_short_name || id).sort((x, y) => x.localeCompare(y, undefined, { numeric: true })).join(", ");
    freqFeatures.push({ type: "Feature", properties: props, geometry: { type: "LineString", coordinates: d.coords } });
  }
}

// ---------- amenities (amenities.csv, made by scripts/prepare-amenities.mjs) ----------
const AMENITY_COLUMNS = { shelter: "Shelter", seating: "Seating", schedule_box: "Schedule box",
  bike_rack: "Bike rack", trash_can: "Trash can", lighting: "Lighting", real_time_sign: "Arrival sign" };
const amenities = new Map();
if (amenitiesFile) for (const row of parseCsv(fs.readFileSync(amenitiesFile, "utf8"))) {
  const yes = (v) => /^(y|yes|true|1|x)$/i.test(v || ""), no = (v) => /^(n|no|false|0)$/i.test(v || "");
  amenities.set(row.stop_id, {
    have: Object.keys(AMENITY_COLUMNS).filter((col) => yes(row[col])),
    ada_pad: yes(row.ada_pad) ? "yes" : no(row.ada_pad) ? "no" : "",
    notes: row.notes || "",
  });
}

// ---------- nearby places from OpenStreetMap (one Overpass query per build) ----------
const NEARBY_METERS = 200; // about a 2–3 minute walk
const usedStops = [...stopRoutes.keys()].map((id) => stopById[id]).filter(Boolean);
async function loadPlaces() {
  if (process.env.OVERPASS_FILE) return JSON.parse(fs.readFileSync(process.env.OVERPASS_FILE, "utf8")).elements; // for testing
  const lats = usedStops.map((s) => +s.stop_lat), lons = usedStops.map((s) => +s.stop_lon);
  const pad = 0.004, bbox = [Math.min(...lats) - pad, Math.min(...lons) - pad, Math.max(...lats) + pad, Math.max(...lons) + pad].join(",");
  const food = `["amenity"~"^(restaurant|cafe|fast_food|food_court|ice_cream)$"]`;
  const shop = `["shop"~"^(supermarket|convenience|grocery|greengrocer|mall|department_store|general|variety_store|bakery|deli|chemist)$"]`;
  const query = `[out:json][timeout:120];(nwr${food}(${bbox});nwr${shop}(${bbox});nwr["amenity"="pharmacy"](${bbox});nwr["amenity"="toilets"](${bbox}););out center tags;`;
  for (const url of [process.env.OVERPASS_URL, "https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"].filter(Boolean)) {
    try {
      const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "GMT system map build (github.com/GreenMountainTransit/system-map)" },
        signal: AbortSignal.timeout(150000) });
      if (res.ok) return (await res.json()).elements;
      console.warn(`Overpass ${url} returned ${res.status}`);
    } catch (e) { console.warn(`Overpass ${url} failed: ${e.message}`); }
  }
  console.warn("Nearby places unavailable this build; stops will show without them.");
  return null;
}
const places = await loadPlaces();
const nearby = new Map(); // stop_id -> {food, shopping, restroom}
if (places) {
  const kind = (t = {}) => {
    if (t.amenity === "toilets") return ["private", "no", "customers"].includes(t.access) ? null : "restroom";
    if (["restaurant", "cafe", "fast_food", "food_court", "ice_cream"].includes(t.amenity)) return "food";
    if (t.shop || t.amenity === "pharmacy") return "shopping";
    return null;
  };
  const cell = (lat, lon) => `${Math.floor(lat / 0.005)}:${Math.floor(lon / 0.005)}`;
  const grid = new Map();
  for (const p of places) {
    const k = kind(p.tags), lat = p.lat ?? p.center?.lat, lon = p.lon ?? p.center?.lon;
    if (!k || lat == null) continue;
    const c = cell(lat, lon); if (!grid.has(c)) grid.set(c, []); grid.get(c).push({ k, lat, lon });
  }
  const dist = (a, b, c, d) => { const R = 6371000, r = Math.PI / 180, x = (d - b) * r * Math.cos(((a + c) / 2) * r), y = (c - a) * r; return Math.hypot(x, y) * R; };
  for (const s of usedStops) {
    const lat = +s.stop_lat, lon = +s.stop_lon, counts = { food: 0, shopping: 0, restroom: 0 };
    const [ci, cj] = cell(lat, lon).split(":").map(Number);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const p of grid.get(`${i}:${j}`) || []) if (dist(lat, lon, p.lat, p.lon) <= NEARBY_METERS) counts[p.k]++;
    nearby.set(s.stop_id, counts);
  }
}

// ---------- stops ----------
const stopFeatures = [];
for (const [sid, rs] of stopRoutes) {
  const s = stopById[sid]; if (!s) continue;
  const ids = [...rs].sort((a, b) => (routeById[a].route_short_name || a).localeCompare(routeById[b].route_short_name || b, undefined, { numeric: true }));
  const a = amenities.get(sid);
  stopFeatures.push({
    type: "Feature",
    properties: {
      stop_id: sid, name: s.stop_name, code: s.stop_code || "",
      routes: ids, routes_key: "|" + ids.join("|") + "|",
      timepoint: timepointStops.has(sid),
      wheelchair: s.wheelchair_boarding === "1" ? "yes" : s.wheelchair_boarding === "2" ? "no" : "",
      ada_pad: a ? a.ada_pad : "",
      amenities: a ? a.have.map((c) => AMENITY_COLUMNS[c]) : [], amenity_notes: a ? a.notes : "",
      nearby: nearby.get(sid) || null,
    },
    geometry: { type: "Point", coordinates: [+(+s.stop_lon).toFixed(6), +(+s.stop_lat).toFixed(6)] },
  });
}

const routeList = [...tripsByRoute.keys()].map((id) => routeMeta(routeById[id])).sort((a, b) =>
  (a.sort - b.sort) || a.short_name.localeCompare(b.short_name, undefined, { numeric: true }));

write("routes.geojson", { type: "FeatureCollection", features: lineFeatures });
write("frequency.geojson", { type: "FeatureCollection", features: freqFeatures });
write("stops.geojson", { type: "FeatureCollection", features: stopFeatures });
write("routes.json", { built: todayNY, groups: (routeInfo.groups || []).map(({ id, name, default: d, collapsed }) => ({ id, name, default: d, collapsed })), routes: routeList, stops: routeStops });
write("calendar.json", cal);
write("headsigns.json", headsigns);

const withAmenities = stopFeatures.filter((f) => amenities.has(f.properties.stop_id)).length;
console.log(`Built ${routeList.length} routes (${lineFeatures.length} route patterns), ${stopFeatures.length} stops ` +
  `(${stopFeatures.filter((f) => f.properties.timepoint).length} timepoints), ${Object.keys(headsigns).length} trips`);
console.log(amenitiesFile ? `Amenities: ${withAmenities} of ${stopFeatures.length} stops matched a row in ${path.basename(amenitiesFile)}` : "Amenities: none (no amenities.csv)");
console.log(`Frequency map: ${freqFeatures.length} street segments, local routes on weekday ${freqDays.weekday?.ymd || "(none found)"}`);
console.log(places ? `Nearby places: ${places.length} from OpenStreetMap` : "Nearby places: skipped");
