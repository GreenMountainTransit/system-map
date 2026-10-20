// Turns GMT's GTFS schedule (and optional stop amenity sheet) into the files the map uses.
//
//   node scripts/build-data.mjs <unzipped-gtfs-folder> [amenities.csv]
//
// Writes to public/data/. Re-run whenever GMT publishes a new GTFS or the amenity
// sheet changes, then redeploy (npx wrangler deploy).

import fs from "node:fs";
import path from "node:path";

const [gtfsDir, amenitiesFile] = process.argv.slice(2);
if (!gtfsDir) { console.error("Usage: node scripts/build-data.mjs <gtfs-folder> [amenities.csv]"); process.exit(1); }
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "public", "data");
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

const routes = read("routes.txt");
const trips = read("trips.txt");
const stops = read("stops.txt");
const stopTimes = read("stop_times.txt");
const shapes = read("shapes.txt", true);
const calendar = read("calendar.txt", true);
const calendarDates = read("calendar_dates.txt", true);

// ---------- stop times per trip (with interpolation for blank non-timepoint times) ----------
const byTrip = new Map();
for (const st of stopTimes) {
  if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
  byTrip.get(st.trip_id).push([st.stop_id, toSecs(st.departure_time || st.arrival_time), +st.stop_sequence]);
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
  // drop anything still untimed at the ends
  for (let i = list.length - 1; i >= 0; i--) if (list[i][1] == null) list.splice(i, 1);
}

// ---------- per-route schedules and stop order ----------
const routeById = Object.fromEntries(routes.map((r) => [r.route_id, r]));
const routeStops = {};      // route_id -> { "0": {headsign, stops:[...]}, "1": ... }
const stopRoutes = new Map(); // stop_id -> Set(route_id)
const headsigns = {};        // trip_id -> headsign (used to label live buses)

const tripsByRoute = new Map();
for (const t of trips) {
  if (!byTrip.has(t.trip_id) || !routeById[t.route_id]) continue;
  if (!tripsByRoute.has(t.route_id)) tripsByRoute.set(t.route_id, []);
  tripsByRoute.get(t.route_id).push(t);
  headsigns[t.trip_id] = t.trip_headsign || "";
}

for (const [routeId, list] of tripsByRoute) {
  const sched = list.map((t) => ({
    t: t.trip_id, s: t.service_id, h: t.trip_headsign || "", d: t.direction_id || "0",
    st: byTrip.get(t.trip_id),
  }));
  fs.writeFileSync(path.join(OUT, "sched", `${encodeURIComponent(routeId)}.json`), JSON.stringify(sched));

  routeStops[routeId] = {};
  const dirs = [...new Set(sched.map((x) => x.d))].sort();
  for (const d of dirs) {
    const inDir = sched.filter((x) => x.d === d);
    const pattern = mostCommon(inDir.map((x) => x.st.map((s) => s[0]).join("|")));
    const matching = inDir.filter((x) => x.st.map((s) => s[0]).join("|") === pattern);
    routeStops[routeId][d] = { headsign: mostCommon(matching.map((x) => x.h)) || "", stops: pattern.split("|") };
  }
  for (const x of sched) for (const [sid] of x.st) {
    if (!stopRoutes.has(sid)) stopRoutes.set(sid, new Set());
    stopRoutes.get(sid).add(routeId);
  }
}

// ---------- route lines (most-used shape per route + direction) ----------
const shapeCount = new Map();
for (const t of trips) if (t.shape_id && routeById[t.route_id]) {
  const k = `${t.route_id}|${t.direction_id || "0"}`;
  if (!shapeCount.has(k)) shapeCount.set(k, new Map());
  const m = shapeCount.get(k); m.set(t.shape_id, (m.get(t.shape_id) || 0) + 1);
}
const chosenShape = new Map();
for (const [k, m] of shapeCount) chosenShape.set([...m].sort((a, b) => b[1] - a[1])[0][0], k.split("|")[0]);
const shapePts = new Map();
for (const s of shapes) if (chosenShape.has(s.shape_id)) {
  if (!shapePts.has(s.shape_id)) shapePts.set(s.shape_id, []);
  shapePts.get(s.shape_id).push([+s.shape_pt_sequence, +(+s.shape_pt_lon).toFixed(5), +(+s.shape_pt_lat).toFixed(5)]);
}
const routeInfo = (r) => ({
  route_id: r.route_id,
  short_name: r.route_short_name || r.route_id,
  long_name: r.route_long_name || "",
  color: "#" + (r.route_color || "00703C"),
  text_color: "#" + (r.route_text_color || "FFFFFF"),
  sort: Number(r.route_sort_order) || 0,
});
const lineFeatures = [];
for (const [shapeId, pts] of shapePts) {
  pts.sort((a, b) => a[0] - b[0]);
  lineFeatures.push({ type: "Feature", properties: routeInfo(routeById[chosenShape.get(shapeId)]),
    geometry: { type: "LineString", coordinates: pts.map(([, lo, la]) => [lo, la]) } });
}
// Fallback for routes with no shapes.txt entries: connect their stops in order.
const stopById = Object.fromEntries(stops.map((s) => [s.stop_id, s]));
const drawn = new Set(lineFeatures.map((f) => f.properties.route_id));
for (const [routeId, dirs] of Object.entries(routeStops)) if (!drawn.has(routeId)) {
  for (const d of Object.values(dirs)) lineFeatures.push({ type: "Feature", properties: routeInfo(routeById[routeId]),
    geometry: { type: "LineString", coordinates: d.stops.map((id) => stopById[id]).filter(Boolean).map((s) => [+s.stop_lon, +s.stop_lat]) } });
}

// ---------- stops, with amenities ----------
const AMENITY_COLUMNS = { shelter: "Shelter", bench: "Bench", bike_rack: "Bike rack", trash_can: "Trash can", lighting: "Lighting", real_time_sign: "Arrival sign" };
const amenities = new Map();
if (amenitiesFile) {
  for (const row of parseCsv(fs.readFileSync(amenitiesFile, "utf8"))) {
    const have = Object.entries(AMENITY_COLUMNS).filter(([col]) => /^(y|yes|true|1|x)$/i.test(row[col] || "")).map(([, label]) => label);
    amenities.set(row.stop_id, { have, notes: row.notes || "" });
  }
}
const stopFeatures = [];
for (const [sid, rs] of stopRoutes) {
  const s = stopById[sid];
  if (!s) continue;
  const ids = [...rs].sort((a, b) => (routeById[a].route_short_name || a).localeCompare(routeById[b].route_short_name || b, undefined, { numeric: true }));
  const a = amenities.get(sid);
  stopFeatures.push({
    type: "Feature",
    properties: {
      stop_id: sid, name: s.stop_name, code: s.stop_code || "",
      routes: ids, routes_key: "|" + ids.join("|") + "|",
      wheelchair: s.wheelchair_boarding === "1" ? "yes" : s.wheelchair_boarding === "2" ? "no" : "",
      amenities: a ? a.have : [], amenity_notes: a ? a.notes : "",
    },
    geometry: { type: "Point", coordinates: [+(+s.stop_lon).toFixed(6), +(+s.stop_lat).toFixed(6)] },
  });
}

// ---------- service calendar ----------
const cal = {
  cal: calendar.map((c) => ({ s: c.service_id, a: c.start_date, b: c.end_date,
    d: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((k) => c[k] === "1") })),
  ex: {},
};
for (const x of calendarDates) {
  cal.ex[x.date] ??= { add: [], rm: [] };
  cal.ex[x.date][x.exception_type === "1" ? "add" : "rm"].push(x.service_id);
}

const routeList = Object.keys(routeStops).map((id) => routeInfo(routeById[id])).sort((a, b) =>
  (a.sort - b.sort) || a.short_name.localeCompare(b.short_name, undefined, { numeric: true }));

const write = (f, obj) => fs.writeFileSync(path.join(OUT, f), JSON.stringify(obj));
write("routes.geojson", { type: "FeatureCollection", features: lineFeatures });
write("stops.geojson", { type: "FeatureCollection", features: stopFeatures });
write("routes.json", { routes: routeList, stops: routeStops });
write("calendar.json", cal);
write("headsigns.json", headsigns);

console.log(`Built ${routeList.length} routes, ${stopFeatures.length} stops, ${Object.keys(headsigns).length} trips` +
  (amenitiesFile ? `, amenities for ${amenities.size} stops` : "") + ` -> public/data/`);
