// Live data for the GMT system map, fetched straight from Swiftly in the browser.
//   GMTLive.vehicles()            -> GeoJSON of live buses
//   GMTLive.arrivals({ stop })    -> { stopId: [next 3 arrivals, all routes] }
//   GMTLive.arrivals({ route })   -> { stopId: { directionId: [next 3 arrivals] } }
//   GMTLive.arrivals({ stop, all: true }) -> { stopId: [every departure today, past ones marked] }
//   Add only: [routeId] to limit a stop's departures to certain routes (used on single-route pages).
// Arrivals combine the published schedule (data/ folder) with Swiftly's live predictions for the stop
// (its JSON predictions API, which browsers are allowed to call; the GTFS-realtime feed is not).
// Live predictions replace scheduled times trip by trip; everything else stays scheduled.
(function () {
  const AGENCY = "green-mountain";
  const API = `https://api.goswift.ly/real-time/${AGENCY}`;
  const TZ = "America/New_York";
  const COUNT = 3;
  const FEED_MAX_AGE = 10000;          // reuse a fetched feed for 10 s (shared by the bus layer, stop list and popups)
  const STALE_VEHICLE_SECONDS = 90;
  const LEAVING_SOON_SECONDS = 300; // five minutes before scheduled departure
  const LEAVING_SOON_GRACE = 45; // avoid showing an overdue layover indefinitely   // hide buses whose GPS hasn't reported in 3 min

  let KEY = "", DATA = "data/", RELAY = ""; // RELAY: the GMT relay (Cloudflare Worker); when set, the Swiftly key isn't used in the page
  const memo = new Map();
  const feedState = new Map();
  function status(path) {
    const s = feedState.get(path);
    if (!s) return { state: "unknown", ageSeconds: null, lastSuccess: null };
    const ageSeconds = s.fetchedAt ? Math.max(0, Math.round((Date.now() - s.fetchedAt) / 1000 + (s.serverAge || 0))) : null;
    return { state: s.error ? "unavailable" : s.stale || (ageSeconds != null && ageSeconds > (path === "/v1/alerts" ? 180 : 90)) ? "delayed" : "fresh", ageSeconds, lastSuccess: s.fetchedAt ? new Date(s.fetchedAt - (s.serverAge || 0) * 1000).toISOString() : null };
  }
  function liveStatus() { return { vehicles: status("/v1/vehicles"), tripUpdates: status("/v1/trip-updates"), alerts: status("/v1/alerts") }; }

  async function data(file) {
    if (!memo.has(file)) memo.set(file, fetch(DATA + file).then((r) => {
      if (!r.ok) throw new Error(`Missing ${file}`);
      return r.json();
    }).catch((e) => { memo.delete(file); throw e; }));
    return memo.get(file);
  }

  // ---------- Swiftly requests ----------
  // Every open map shares the key's rate limit, so: reuse a fetched feed for FEED_MAX_AGE, and if Swiftly
  // says "too many requests" (429), pause all live requests and back off (1 min, doubling up to 10 min).
  // While paused the map shows scheduled times, then picks live data back up on its own.
  const feeds = new Map(); // url -> { at, promise }
  let pausedUntil = 0, backoff = 60000;
  function swiftly(path, as) {
    if (Date.now() < pausedUntil) return Promise.reject(new Error("Swiftly rate limit: paused"));
    const hit = feeds.get(path);
    if (hit && Date.now() - hit.at < FEED_MAX_AGE) return hit.promise;
    const promise = fetch(API + path, { headers: { Authorization: KEY } }).then((r) => {
      if (r.status === 429) {
        pausedUntil = Date.now() + backoff; backoff = Math.min(backoff * 2, 600000);
        throw new Error("Swiftly rate limit");
      }
      if (!r.ok) throw new Error(`Swiftly ${r.status}`);
      backoff = 60000;
      return as === "json" ? r.json() : r.arrayBuffer();
    });
    promise.catch(() => feeds.delete(path));
    feeds.set(path, { at: Date.now(), promise });
    return promise;
  }

  // Relay requests: the relay already shares one Swiftly request among all visitors; this just avoids
  // asking the relay twice for the same thing within a few seconds.
  const relayCache = new Map();
  const RELAY_TIMEOUT_MS = 8000;
  function relay(path, maxAge = FEED_MAX_AGE) {
    const hit = relayCache.get(path);
    if (hit && Date.now() - hit.at < maxAge) return hit.promise;
    // Give up after 8 seconds: a request that never finishes would otherwise leave "Loading arrivals..." up forever
    // (and be reused by every later request). On a timeout the map falls back to scheduled times and retries next update.
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl && setTimeout(() => ctl.abort(), RELAY_TIMEOUT_MS);
    const promise = fetch(RELAY + path, { ...(ctl ? { signal: ctl.signal } : {}), cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Relay ${r.status}`);
        const body = await r.json();
        const ageHeader = Number(r.headers.get("X-Relay-Age"));
        const atHeader = Number(r.headers.get("X-Relay-Fetched-At"));
        const serverAge = Number.isFinite(ageHeader) && ageHeader >= 0 ? ageHeader
          : Number.isFinite(atHeader) && atHeader > 0 ? Math.max(0, Date.now() / 1000 - atHeader)
          : 0;
        feedState.set(path, { fetchedAt: Date.now(), serverAge, stale: r.headers.get("X-Relay-Stale") === "1", error: false });
        return body;
      })
      .catch((e) => {
        const previous = feedState.get(path) || {};
        feedState.set(path, { ...previous, error: true });
        throw e?.name === "AbortError" ? new Error("Relay timed out") : e;
      })
      .finally(() => timer && clearTimeout(timer));
    promise.catch(() => relayCache.delete(path));
    relayCache.set(path, { at: Date.now(), promise });
    return promise;
  }
  // Relay trip updates -> the same shape decodeTripUpdates() produces.
  async function relayTripUpdates() {
    const body = await relay("/v1/trip-updates");
    const out = new Map();
    for (const [id, [startDate, canceled, ups]] of Object.entries(body.trips || {}))
      out.set(id, { startDate, canceled: !!canceled, updates: ups.map(([seq, stop, time, delay, skipped]) => ({ seq, stop, time, delay, skipped: !!skipped })).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)) });
    return out;
  }

  // ---------- live buses ----------
  // The Swiftly vehicles endpoint includes layover:true but not the scheduled next
  // departure timestamp. Use the already-published GTFS files, not a new API call.
  // A layover is eligible only when its reported trip ID matches an active trip
  // beginning at its first stop within the next five minutes.
  const upcomingIndex = new Map();
  async function upcomingStarts(routeIds) {
    const clock = localClock();
    const dayKey = clock.ymd;
    const missing = routeIds.filter(id => !upcomingIndex.has(`${dayKey}|${id}`));
    if (missing.length) {
      const cal = await data("calendar.json");
      const dates = [-1, 0, 1].map(offset => {
        const date = shiftYmd(dayKey, offset);
        return { offset, ymd: date.ymd,
          active: servicesOn(cal, date.ymd, date.dow) };
      });
      await Promise.all(missing.map(async rid => {
        const result = new Map();
        try {
          const sched = await data(`sched/${encodeURIComponent(rid)}.json`);
          for (const day of dates) for (const trip of sched) {
            if (!day.active.has(trip.s) || !trip.st?.length) continue;
            const start = clock.midnight + day.offset * 86400 + Number(trip.st[0][1]);
            const key = String(trip.t);
            if (!result.has(key)) result.set(key, []);
            result.get(key).push(start);
          }
        } catch (err) {
          console.warn("Unable to check leaving-soon schedule for route", rid, err);
        }
        upcomingIndex.set(`${dayKey}|${rid}`, result);
      }));
    }
    // Avoid retaining old service-day indexes.
    for (const key of upcomingIndex.keys())
      if (!key.startsWith(`${dayKey}|`)) upcomingIndex.delete(key);
    return { clock, dayKey };
  }

  async function vehicles() {
    const body = RELAY ? await relay("/v1/vehicles") : await swiftly("/vehicles", "json");
    const now = Date.now() / 1000;
    const source = body?.data?.vehicles || [];
    const withValidGps = source.filter(v => {
      if (!v.loc || !v.routeId || !v.tripId) return false;
      const t = Number(v.loc.time), lat = Number(v.loc.lat), lon = Number(v.loc.lon);
      return Number.isFinite(t) && t > 0 && now - t >= -30 && now - t <= STALE_VEHICLE_SECONDS &&
        Number.isFinite(lat) && Math.abs(lat) <= 90 && Number.isFinite(lon) && Math.abs(lon) <= 180;
    });

    const layoverRoutes = [...new Set(withValidGps.filter(v => v.layover === true).map(v => String(v.routeId)))];
    const { dayKey } = layoverRoutes.length ? await upcomingStarts(layoverRoutes) : { dayKey: null };
    const visible = [];
    let leavingSoon = 0;
    for (const v of withValidGps) {
      let departure = null;
      if (v.layover === true) {
        const times = upcomingIndex.get(`${dayKey}|${v.routeId}`)?.get(String(v.tripId)) || [];
        departure = times.find(t => t - now >= -LEAVING_SOON_GRACE && t - now <= LEAVING_SOON_SECONDS);
        if (departure == null) continue;
        leavingSoon++;
      }
      visible.push({ v, departure });
    }
    const newest = visible.reduce((a, x) => Math.max(a, Number(x.v.loc.time)), 0);
    return {
      type: "FeatureCollection",
      features: visible.map(({ v, departure }) => ({
        type: "Feature",
        properties: {
          id: v.id, label: v.id, route_id: v.routeId, trip_id: v.tripId,
          headsign: v.headsign || "", heading: v.loc.heading ?? null,
          time: Number(v.loc.time) * 1000, speed: v.loc.speed ?? null,
          layover: v.layover === true,
          service_status: departure != null ? "leaving_soon" : "operating_candidate",
          departure_time: departure != null ? departure * 1000 : null
        },
        geometry: { type: "Point", coordinates: [Number(v.loc.lon), Number(v.loc.lat)] }
      })),
      meta: {
        reported: source.length, hiddenLayovers: source.filter(v => v.layover === true).length - leavingSoon,
        leavingSoon, shown: visible.length,
        newestObservation: newest ? newest * 1000 : null,
        feed: RELAY ? status("/v1/vehicles") : { state: "unknown", ageSeconds: null }
      }
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

  // Swiftly predictions JSON -> [{ route, short, headsign, dir, trip, time }]. Read defensively, since
  // fields vary a little between API versions.
  function parsePredictions(body) {
    const now = Date.now() / 1000, out = [];
    const groups = body?.data?.predictionsData || body?.data?.predictions || [];
    for (const g of groups) for (const dest of g.destinations || [g]) for (const p of dest.predictions || []) {
      let t = p.time ?? p.predictionTime ?? (p.sec != null ? now + p.sec : p.min != null ? now + p.min * 60 : null);
      if (t == null) continue;
      if (t > 1e12) t /= 1000; // milliseconds
      out.push({ route: String(g.routeId ?? dest.routeId ?? ""), short: g.routeShortName || "", headsign: dest.headsign || g.headsign || "",
        dir: String(dest.directionId ?? ""), trip: p.tripId ? String(p.tripId) : null, time: Math.round(t) });
    }
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
  // Where each realtime update falls in the scheduled trip. Matched by stop ID first (Swiftly's
  // stop_sequence numbering can differ from the published GTFS), using the sequence number only to tell
  // apart a stop a loop visits twice, or when the feed leaves out stop IDs.
  function positions(tu, trip) {
    tu._pos ??= new Map();
    if (!tu._pos.has(trip.t)) tu._pos.set(trip.t, tu.updates.map((u) => {
      if (u.stop) {
        const hits = trip.st.map((x, i) => (x[0] === u.stop ? i : -1)).filter((i) => i >= 0);
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) return hits.find((i) => trip.st[i][2] === u.seq) ?? hits[0];
      }
      return u.seq != null ? trip.st.findIndex((x) => x[2] === u.seq) : -1;
    }));
    return tu._pos.get(trip.t);
  }
  function applyRealtime(tu, trip, idx, scheduledEpoch, dayMidnight) {
    if (!tu) return { epoch: scheduledEpoch, live: false };
    if (tu.canceled) return null;
    const pos = positions(tu, trip);
    const k = pos.indexOf(idx), exact = k >= 0 ? tu.updates[k] : null;
    if (exact) {
      if (exact.skipped) return null;
      if (exact.time) return { epoch: exact.time, live: true };
      if (exact.delay != null) return { epoch: scheduledEpoch + exact.delay, live: true };
    }
    // Otherwise carry forward the delay from the nearest earlier update on this trip.
    let delay = null, at = -1;
    tu.updates.forEach((u, j) => {
      const p = pos[j];
      if (p < 0 || p >= idx || p < at) return;
      const d = u.delay != null ? u.delay : u.time ? u.time - (dayMidnight + trip.st[p][1]) : null;
      if (d != null) { delay = d; at = p; }
    });
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

  async function arrivals({ stop, route, all, only }) {
    const [meta, cal, stops] = await Promise.all([data("routes.json"), data("calendar.json"), data("stops.geojson")]);
    // Live predictions (one stop at a time) are optional: if Swiftly can't be reached, scheduled times still show.
    let live = false, preds = [], tus = new Map();
    if (RELAY) {
      // Never label stale relay predictions as live.
      try { tus = await relayTripUpdates(); live = status("/v1/trip-updates").state === "fresh";
        if (!live) tus = new Map(); } catch {}
    } else if (KEY && stop) {
      try { preds = parsePredictions(await swiftly(`/predictions?stop=${encodeURIComponent(stop)}`, "json")); live = true; } catch {}
    }

    let routeIds;
    if (route) routeIds = meta.stops[route] ? [route] : [];
    else routeIds = stops.features.find((x) => x.properties.stop_id === stop)?.properties.routes || [];
    if (only) routeIds = routeIds.filter((id) => only.includes(id));

    const clock = localClock();
    const days = [-1, 0, 1].map((offset) => {
      const { ymd, dow } = shiftYmd(clock.ymd, offset);
      return { ymd, midnight: clock.midnight + offset * 86400, services: servicesOn(cal, ymd, dow) };
    });
    const routeById = Object.fromEntries(meta.routes.map((r) => [r.route_id, r]));
    const result = {};
    const scheds = (await Promise.all(routeIds.map(async (rid) => {
      try {
        return [rid, await data(`sched/${encodeURIComponent(rid)}.json`)];
      } catch (err) {
        console.warn(`[GMT] Schedule unavailable for route ${rid}; continuing with other routes`, err);
        return null;
      }
    }))).filter(Boolean);
    for (const [rid, sched] of scheds) {
      for (const day of days) for (const trip of sched) {
        if (all && day.midnight > clock.midnight) continue; // "all times today" doesn't need tomorrow
        if (!day.services.has(trip.s)) continue;
        const tu = realtimeFor(tus.get(trip.t), trip, day, days, clock.now);
        for (let i = 0; i < trip.st.length - 1; i++) { // buses aren't boardable at their final stop
          const sid = trip.st[i][0];
          if (stop && sid !== stop) continue;
          const scheduled = day.midnight + trip.st[i][1];
          if (all) { if (scheduled < clock.midnight || scheduled >= clock.midnight + 86400 + 3 * 3600) continue; }
          else if (scheduled < clock.now - 3 * 3600 || scheduled > clock.now + 30 * 3600) continue;
          const r = applyRealtime(tu, trip, i, scheduled, day.midnight);
          if (!r || (!all && r.epoch < clock.now - 30)) continue;
          (result[sid] ??= []).push({ route_id: rid, short_name: routeById[rid]?.short_name || rid, color: routeById[rid]?.color,
            headsign: trip.h, direction: trip.d, time: r.epoch, live: r.live, past: r.epoch < clock.now - 30, trip: trip.t });
        }
      }
    }
    // Swap in Swiftly's predicted times, matched by trip. Predictions for trips not in today's schedule
    // (added or changed service) are kept too, as long as they're for a route we're showing.
    if (stop && preds.length) {
      const list = result[stop] || [];
      for (const pr of preds) {
        // The same trip ID runs every day: use the scheduled instance closest to the predicted time.
        const a = pr.trip && list.filter((x) => x.trip === pr.trip && !x.live && Math.abs(x.time - pr.time) < 3 * 3600)
          .sort((x, y) => Math.abs(x.time - pr.time) - Math.abs(y.time - pr.time))[0];
        if (a) { a.time = pr.time; a.live = true; a.past = pr.time < clock.now - 30; continue; }
        if (!routeIds.includes(pr.route)) continue;
        list.push({ route_id: pr.route, short_name: routeById[pr.route]?.short_name || pr.short, color: routeById[pr.route]?.color,
          headsign: pr.headsign, direction: pr.dir, time: pr.time, live: true, past: false, trip: pr.trip });
      }
      result[stop] = list;
    }
    const next = (list) => list.filter((a) => all || a.time >= clock.now - 30).sort((a, b) => a.time - b.time).slice(0, COUNT);
    for (const sid in result) {
      if (all) { result[sid].sort((a, b) => a.time - b.time); continue; }
      if (stop) { result[sid] = next(result[sid]); continue; }
      const byDir = {};
      for (const a of result[sid]) (byDir[a.direction] ??= []).push(a);
      for (const d in byDir) byDir[d] = next(byDir[d]);
      result[sid] = byDir;
    }
    return { live, arrivals: result, freshness: RELAY ? status("/v1/trip-updates") : null };
  }

  // Detours (Swiftly Service Adjustments, via the relay's trip-modifications) and service alerts.
  async function detours() { if (!RELAY) return null; const b = await relay("/v1/trip-updates"); return { detours: b.detours || [], stops: b.stops || {} }; }
  async function alerts() {
    if (!RELAY) return null;
    const b = await relay("/v1/alerts", 60000), now = Date.now() / 1000;
    return (b.alerts || []).filter((a) => !a.periods.length || a.periods.some(([s, e]) => (!s || s <= now) && (!e || e >= now)));
  }

  // Predicted times Swiftly gives for a detour's temporary stop (via the relay's trip updates).
  async function tempStopTimes(stopId) {
    if (!RELAY) return [];
    const tus = await relayTripUpdates(), out = [];
    for (const [trip, tu] of tus) for (const u of tu.updates) if (u.stop === stopId && u.time) out.push({ trip, time: u.time });
    return out;
  }

  globalThis.GMTLive = {
    tempStopTimes,
    configure({ key, dataDir, relay: r }) { KEY = key; if (dataDir) DATA = dataDir; RELAY = (r || "").replace(/\/$/, ""); },
    detours, alerts,
    vehicles, arrivals, decodeTripUpdates, liveStatus,
    // shared with the trip planner (planner.js): live predictions for EVERY trip and stop, via the relay
    data, localClock, shiftYmd, servicesOn, applyRealtime,
    liveTrips: () => (RELAY ? relayTripUpdates() : Promise.resolve(null)),
  };
})();
