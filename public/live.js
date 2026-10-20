// Live data for the GMT system map, fetched straight from Swiftly in the browser.
//   GMTLive.vehicles()            -> GeoJSON of live buses
//   GMTLive.arrivals({ stop })    -> { stopId: [next 3 arrivals, all routes] }
//   GMTLive.arrivals({ route })   -> { stopId: { directionId: [next 3 arrivals] } }
// Arrivals combine the published schedule (data/ folder) with Swiftly's GTFS-realtime
// trip updates: live predictions where Swiftly has them, scheduled times otherwise.
(function () {
  const AGENCY = "green-mountain";
  const API = `https://api.goswift.ly/real-time/${AGENCY}`;
  const TZ = "America/New_York";
  const COUNT = 3;
  const FEED_MAX_AGE = 10000;          // reuse a fetched feed for 10 s (shared by the bus layer, stop list and popups)
  const STALE_VEHICLE_SECONDS = 180;   // hide buses whose GPS hasn't reported in 3 min

  let KEY = "", DATA = "data/";
  const memo = new Map();

  async function data(file) {
    if (!memo.has(file)) memo.set(file, fetch(DATA + file).then((r) => {
      if (!r.ok) throw new Error(`Missing ${file}`);
      return r.json();
    }).catch((e) => { memo.delete(file); throw e; }));
    return memo.get(file);
  }

  // ---------- Swiftly requests ----------
  const feeds = new Map(); // url -> { at, promise }
  function swiftly(path, as) {
    const hit = feeds.get(path);
    if (hit && Date.now() - hit.at < FEED_MAX_AGE) return hit.promise;
    const promise = fetch(API + path, { headers: { Authorization: KEY } }).then((r) => {
      if (!r.ok) throw new Error(`Swiftly ${r.status}`);
      return as === "json" ? r.json() : r.arrayBuffer();
    });
    promise.catch(() => feeds.delete(path));
    feeds.set(path, { at: Date.now(), promise });
    return promise;
  }

  // ---------- live buses ----------
  async function vehicles() {
    const body = await swiftly("/vehicles", "json");
    const now = Date.now() / 1000;
    return {
      type: "FeatureCollection",
      features: (body?.data?.vehicles || [])
        .filter((v) => v.loc && v.routeId && !(v.loc.time && now - v.loc.time > STALE_VEHICLE_SECONDS))
        .map((v) => ({
          type: "Feature",
          properties: {
            id: v.id, label: v.id, route_id: v.routeId, headsign: v.headsign || "",
            heading: v.loc.heading ?? null, time: (v.loc.time || now) * 1000,
          },
          geometry: { type: "Point", coordinates: [v.loc.lon, v.loc.lat] },
        })),
    };
  }

  // ---------- minimal GTFS-realtime (protobuf) reader: only the trip-update fields we use ----------
  function reader(buf) {
    let pos = 0;
    const varint = () => {
      let result = 0n, shift = 0n, b;
      do { b = buf[pos++]; result |= BigInt(b & 0x7f) << shift; shift += 7n; } while (b & 0x80);
      return result;
    };
    const skip = (wire) => {
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) { const len = Number(varint()); pos += len; } // read length first: `pos += varint()` would use the old pos
      else if (wire === 5) pos += 4;
      else throw new Error("Unsupported protobuf wire type " + wire);
    };
    const message = (end, onField) => {
      while (pos < end) {
        const tag = Number(varint()), field = tag >> 3, wire = tag & 7;
        if (!onField(field, wire)) skip(wire);
      }
    };
    const sub = (fn) => { const len = Number(varint()), end = pos + len; const out = fn(end); pos = end; return out; };
    const str = () => { const len = Number(varint()); const s = new TextDecoder().decode(buf.subarray(pos, pos + len)); pos += len; return s; };
    const int = () => Number(BigInt.asIntN(64, varint()));
    return { varint, message, sub, str, int, get pos() { return pos; } };
  }

  function decodeTripUpdates(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer), r = reader(buf), out = new Map();
    const stopTimeEvent = (end) => { const e = {}; r.message(end, (f, w) => {
      if (f === 1 && w === 0) { e.delay = r.int(); return true; }
      if (f === 2 && w === 0) { e.time = r.int(); return true; }
      return false; }); return e; };
    const stopTimeUpdate = (end) => { const u = { seq: null, stop: null, time: null, delay: null, skipped: false }; r.message(end, (f, w) => {
      if (f === 1 && w === 0) { u.seq = r.int(); return true; }
      if ((f === 2 || f === 3) && w === 2) { const e = r.sub(stopTimeEvent);
        if (u.time == null && e.time != null) u.time = e.time;
        if (u.delay == null && e.delay != null) u.delay = e.delay; return true; }
      if (f === 4 && w === 2) { u.stop = r.str(); return true; }
      if (f === 5 && w === 0) { u.skipped = r.int() === 1; return true; }
      return false; }); return u; };
    const trip = (end) => { const t = {}; r.message(end, (f, w) => {
      if (f === 1 && w === 2) { t.tripId = r.str(); return true; }
      if (f === 3 && w === 2) { t.startDate = r.str(); return true; }
      if (f === 4 && w === 0) { t.rel = r.int(); return true; }
      return false; }); return t; };
    const tripUpdate = (end) => { const tu = { trip: {}, updates: [] }; r.message(end, (f, w) => {
      if (f === 1 && w === 2) { tu.trip = r.sub(trip); return true; }
      if (f === 2 && w === 2) { tu.updates.push(r.sub(stopTimeUpdate)); return true; }
      return false; }); return tu; };
    const entity = (end) => { let tu = null; r.message(end, (f, w) => {
      if (f === 3 && w === 2) { tu = r.sub(tripUpdate); return true; }
      return false; }); return tu; };
    r.message(buf.length, (f, w) => {
      if (f === 2 && w === 2) {
        const tu = r.sub(entity);
        if (tu && tu.trip.tripId) out.set(tu.trip.tripId, {
          startDate: tu.trip.startDate || null,
          canceled: tu.trip.rel === 3,
          updates: tu.updates.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
        });
        return true;
      }
      return false;
    });
    return out;
  }

  // ---------- schedule + realtime arrivals ----------
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
    let delay = null;
    for (const u of tu.updates) {
      if ((u.seq ?? Infinity) >= seq) break;
      if (u.delay != null) delay = u.delay;
      else if (u.time) { const s = trip.st.find((x) => x[2] === u.seq); if (s) delay = u.time - (dayMidnight + s[1]); }
    }
    return delay != null ? { epoch: scheduledEpoch + delay, live: true } : { epoch: scheduledEpoch, live: false };
  }
  // A trip_id repeats every service day; only one day's instance gets the live update.
  function realtimeFor(tu, trip, day, days, now) {
    if (!tu) return null;
    if (tu.startDate) return tu.startDate === day.ymd ? tu : null;
    const mid = (d) => d.midnight + (trip.st[0][1] + trip.st[trip.st.length - 1][1]) / 2;
    const best = days.filter((d) => d.services.has(trip.s)).sort((a, b) => Math.abs(mid(a) - now) - Math.abs(mid(b) - now))[0];
    return best === day ? tu : null;
  }

  async function arrivals({ stop, route }) {
    const [meta, cal, stops] = await Promise.all([data("routes.json"), data("calendar.json"), data("stops.geojson")]);
    // Live predictions are optional: if Swiftly can't be reached, scheduled times still show.
    let tus = new Map(), live = true;
    if (!KEY) live = false;
    else try { tus = decodeTripUpdates(await swiftly("/gtfs-rt-trip-updates", "bytes")); } catch { live = false; }

    let routeIds;
    if (route) routeIds = meta.stops[route] ? [route] : [];
    else routeIds = stops.features.find((x) => x.properties.stop_id === stop)?.properties.routes || [];

    const clock = localClock();
    const days = [-1, 0, 1].map((offset) => {
      const { ymd, dow } = shiftYmd(clock.ymd, offset);
      return { ymd, midnight: clock.midnight + offset * 86400, services: servicesOn(cal, ymd, dow) };
    });
    const routeById = Object.fromEntries(meta.routes.map((r) => [r.route_id, r]));
    const result = {};
    const scheds = await Promise.all(routeIds.map((rid) => data(`sched/${encodeURIComponent(rid)}.json`).then((s) => [rid, s])));
    for (const [rid, sched] of scheds) {
      for (const day of days) for (const trip of sched) {
        if (!day.services.has(trip.s)) continue;
        const tu = realtimeFor(tus.get(trip.t), trip, day, days, clock.now);
        for (let i = 0; i < trip.st.length - 1; i++) { // buses aren't boardable at their final stop
          const sid = trip.st[i][0];
          if (stop && sid !== stop) continue;
          const scheduled = day.midnight + trip.st[i][1];
          if (scheduled < clock.now - 3 * 3600 || scheduled > clock.now + 30 * 3600) continue;
          const r = applyRealtime(tu, trip, i, scheduled, day.midnight);
          if (!r || r.epoch < clock.now - 30) continue;
          (result[sid] ??= []).push({ route_id: rid, short_name: routeById[rid]?.short_name || rid, color: routeById[rid]?.color,
            headsign: trip.h, direction: trip.d, time: r.epoch, live: r.live });
        }
      }
    }
    const next = (list) => list.sort((a, b) => a.time - b.time).slice(0, COUNT);
    for (const sid in result) {
      if (stop) { result[sid] = next(result[sid]); continue; }
      const byDir = {};
      for (const a of result[sid]) (byDir[a.direction] ??= []).push(a);
      for (const d in byDir) byDir[d] = next(byDir[d]);
      result[sid] = byDir;
    }
    return { live, arrivals: result };
  }

  globalThis.GMTLive = {
    configure({ key, dataDir }) { KEY = key; if (dataDir) DATA = dataDir; },
    vehicles, arrivals, decodeTripUpdates,
  };
})();
