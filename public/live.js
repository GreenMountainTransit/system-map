
(function () {
  "use strict";

  const AGENCY = "green-mountain";
  const API = `https://api.goswift.ly/real-time/${AGENCY}`;
  const TZ = "America/New_York";
  const COUNT = 3;
  const FEED_MAX_AGE = 10000;
  const GPS_MAX_AGE = 90;
  const RELAY_TIMEOUT_MS = 8000;

  let KEY = "", DATA = "data/", RELAY = "";
  const memo = new Map();
  const feeds = new Map();
  const relayCache = new Map();
  const feedState = new Map();
  let pausedUntil = 0, backoff = 60000;

  async function data(file) {
    if (!memo.has(file)) {
      memo.set(file, fetch(DATA + file).then(r => {
        if (!r.ok) throw new Error(`Missing ${file}`);
        return r.json();
      }).catch(e => {
        memo.delete(file);
        throw e;
      }));
    }
    return memo.get(file);
  }

  function feedStatus(path) {
    const s = feedState.get(path);
    if (!s) return {
      state: "unknown",
      ageSeconds: null,
      lastSuccess: null
    };

    const age = s.fetchedAt
      ? Math.max(0, Math.round(
          (Date.now() - s.fetchedAt) / 1000 +
          (s.serverAge || 0)
        ))
      : null;

    const limit = path === "/v1/alerts" ? 180 : 90;

    return {
      state: s.error ? "unavailable"
        : s.stale || (age != null && age > limit)
          ? "delayed" : "fresh",
      ageSeconds: age,
      lastSuccess: s.fetchedAt
        ? new Date(
            s.fetchedAt - (s.serverAge || 0) * 1000
          ).toISOString()
        : null
    };
  }

  function liveStatus() {
    return {
      vehicles: feedStatus("/v1/vehicles"),
      tripUpdates: feedStatus("/v1/trip-updates"),
      alerts: feedStatus("/v1/alerts")
    };
  }

  function swiftly(path, as) {
    if (Date.now() < pausedUntil) {
      return Promise.reject(
        new Error("Swiftly rate limit: paused")
      );
    }

    const hit = feeds.get(path);
    if (hit && Date.now() - hit.at < FEED_MAX_AGE)
      return hit.promise;

    const promise = fetch(API + path, {
      headers: { Authorization: KEY }
    }).then(r => {
      if (r.status === 429) {
        pausedUntil = Date.now() + backoff;
        backoff = Math.min(backoff * 2, 600000);
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

  function relay(path, maxAge = FEED_MAX_AGE) {
    const hit = relayCache.get(path);
    if (hit && Date.now() - hit.at < maxAge)
      return hit.promise;

    const ctl = typeof AbortController === "function"
      ? new AbortController() : null;
    const timer = ctl
      ? setTimeout(() => ctl.abort(), RELAY_TIMEOUT_MS)
      : null;

    const promise = fetch(
      RELAY + path,
      ctl ? { signal: ctl.signal } : undefined
    ).then(async r => {
      if (!r.ok) throw new Error(`Relay ${r.status}`);

      const body = await r.json();
      const ageHeader = r.headers.get("X-Relay-Age");
      const atHeader = r.headers.get("X-Relay-Fetched-At");
      const age = ageHeader === null ? NaN : Number(ageHeader);
      const at = atHeader === null ? NaN : Number(atHeader);

      const serverAge =
        Number.isFinite(age) && age >= 0 ? age :
        Number.isFinite(at) && at > 0
          ? Math.max(0, Date.now() / 1000 - at)
          : 0;

      feedState.set(path, {
        fetchedAt: Date.now(),
        serverAge,
        stale: r.headers.get("X-Relay-Stale") === "1",
        error: false
      });

      return body;
    }).catch(e => {
      const previous = feedState.get(path) || {};
      feedState.set(path, { ...previous, error: true });
      throw e?.name === "AbortError"
        ? new Error("Relay timed out") : e;
    }).finally(() => {
      if (timer) clearTimeout(timer);
    });

    promise.catch(() => relayCache.delete(path));
    relayCache.set(path, { at: Date.now(), promise });
    return promise;
  }

  async function relayTripUpdates() {
    const body = await relay("/v1/trip-updates");
    const out = new Map();

    for (const [id, entry] of Object.entries(body.trips || {})) {
      const [startDate, canceled, ups] = entry;
      out.set(id, {
        startDate,
        canceled: !!canceled,
        updates: (ups || []).map(
          ([seq, stop, time, delay, skipped]) => ({
            seq, stop, time, delay, skipped: !!skipped
          })
        ).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      });
    }
    return out;
  }

  // Public-facing vehicle visibility.
  async function vehicles() {
    const body = RELAY
      ? await relay("/v1/vehicles")
      : await swiftly("/vehicles", "json");

    const now = Date.now() / 1000;
    const all = body?.data?.vehicles || [];

    const visible = all.filter(v => {
      if (!v.loc || !v.routeId || !v.tripId)
        return false;

      if (v.layover === true)
        return false;

      const t = Number(v.loc.time);
      const lat = Number(v.loc.lat);
      const lon = Number(v.loc.lon);

      if (!Number.isFinite(t) || t <= 0)
        return false;

      if (now - t > GPS_MAX_AGE || now - t < -30)
        return false;

      if (!Number.isFinite(lat) ||
          !Number.isFinite(lon) ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180)
        return false;

      return true;
    });

    const newest = visible.reduce(
      (max, v) => Math.max(max, Number(v.loc.time)), 0
    );

    return {
      type: "FeatureCollection",
      features: visible.map(v => ({
        type: "Feature",
        properties: {
          id: v.id,
          label: v.id,
          route_id: v.routeId,
          trip_id: v.tripId,
          headsign: v.headsign || "",
          heading: v.loc.heading ?? null,
          time: Number(v.loc.time) * 1000,
          speed: v.loc.speed ?? null,
          service_status: "operating_candidate"
        },
        geometry: {
          type: "Point",
          coordinates: [
            Number(v.loc.lon),
            Number(v.loc.lat)
          ]
        }
      })),
      meta: {
        reported: all.length,
        hiddenLayovers: all.filter(
          v => v.layover === true
        ).length,
        shown: visible.length,
        newestObservation: newest ? newest * 1000 : null,
        feed: RELAY
          ? feedStatus("/v1/vehicles")
          : { state: "unknown", ageSeconds: null }
      }
    };
  }

  // Minimal GTFS-realtime protobuf decoder.
  function reader(buf) {
    let pos = 0;

    const varint = () => {
      let result = 0n, shift = 0n, b;
      do {
        if (pos >= buf.length)
          throw new Error("Invalid protobuf");
        b = buf[pos++];
        result |= BigInt(b & 0x7f) << shift;
        shift += 7n;
      } while (b & 0x80);
      return result;
    };

    const skip = wire => {
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) pos += Number(varint());
      else if (wire === 5) pos += 4;
      else throw new Error("Unsupported protobuf wire type");
    };

    const message = (end, onField) => {
      while (pos < end) {
        const tag = Number(varint());
        const field = tag >> 3, wire = tag & 7;
        if (!onField(field, wire)) skip(wire);
      }
    };

    const sub = fn => {
      const end = pos + Number(varint());
      const out = fn(end);
      pos = end;
      return out;
    };

    const decoder = new TextDecoder();
    const str = () => {
      const len = Number(varint());
      const value = decoder.decode(buf.subarray(pos, pos + len));
      pos += len;
      return value;
    };

    return {
      message, sub, str,
      int: () => Number(BigInt.asIntN(64, varint())),
      get pos() { return pos; }
    };
  }

  function decodeTripUpdates(arrayBuffer) {
    const buf = new Uint8Array(arrayBuffer);
    const r = reader(buf), out = new Map();

    const event = end => {
      const e = {};
      r.message(end, (f, w) => {
        if (f === 1 && w === 0) {
          e.delay = r.int(); return true;
        }
        if (f === 2 && w === 0) {
          e.time = r.int(); return true;
        }
        return false;
      });
      return e;
    };

    const update = end => {
      const u = {
        seq: null, stop: null,
        time: null, delay: null, skipped: false
      };
      r.message(end, (f, w) => {
        if (f === 1 && w === 0) {
          u.seq = r.int(); return true;
        }
        if ((f === 2 || f === 3) && w === 2) {
          const e = r.sub(event);
          if (u.time == null && e.time != null)
            u.time = e.time;
          if (u.delay == null && e.delay != null)
            u.delay = e.delay;
          return true;
        }
        if (f === 4 && w === 2) {
          u.stop = r.str(); return true;
        }
        if (f === 5 && w === 0) {
          u.skipped = r.int() === 1; return true;
        }
        return false;
      });
      return u;
    };

    const descriptor = end => {
      const t = {};
      r.message(end, (f, w) => {
        if (f === 1 && w === 2) {
          t.tripId = r.str(); return true;
        }
        if (f === 3 && w === 2) {
          t.startDate = r.str(); return true;
        }
        if (f === 4 && w === 0) {
          t.rel = r.int(); return true;
        }
        return false;
      });
      return t;
    };

    const tripUpdate = end => {
      const tu = { trip: {}, updates: [] };
      r.message(end, (f, w) => {
        if (f === 1 && w === 2) {
          tu.trip = r.sub(descriptor); return true;
        }
        if (f === 2 && w === 2) {
          tu.updates.push(r.sub(update)); return true;
        }
        return false;
      });
      return tu;
    };

    const entity = end => {
      let tu = null;
      r.message(end, (f, w) => {
        if (f === 3 && w === 2) {
          tu = r.sub(tripUpdate); return true;
        }
        return false;
      });
      return tu;
    };

    r.message(buf.length, (f, w) => {
      if (f !== 2 || w !== 2) return false;
      const tu = r.sub(entity);
      if (tu?.trip?.tripId) {
        out.set(tu.trip.tripId, {
          startDate: tu.trip.startDate || null,
          canceled: tu.trip.rel === 3,
          updates: tu.updates.sort(
            (a, b) => (a.seq ?? 0) - (b.seq ?? 0)
          )
        });
      }
      return true;
    });

    return out;
  }

  function parsePredictions(body) {
    const now = Date.now() / 1000, out = [];
    const groups =
      body?.data?.predictionsData ||
      body?.data?.predictions || [];

    for (const g of groups) {
      for (const dest of g.destinations || [g]) {
        for (const p of dest.predictions || []) {
          let t = p.time ?? p.predictionTime ??
            (p.sec != null ? now + p.sec :
             p.min != null ? now + p.min * 60 : null);
          if (t == null) continue;
          if (t > 1e12) t /= 1000;

          out.push({
            route: String(g.routeId ?? dest.routeId ?? ""),
            short: g.routeShortName || "",
            headsign: dest.headsign || g.headsign || "",
            dir: String(dest.directionId ?? ""),
            trip: p.tripId ? String(p.tripId) : null,
            time: Math.round(t)
          });
        }
      }
    }
    return out;
  }

  function localClock() {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: TZ,
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
        second: "2-digit", hourCycle: "h23"
      }).formatToParts(new Date()).map(
        x => [x.type, x.value]
      )
    );

    const secs = +p.hour * 3600 +
      +p.minute * 60 + +p.second;
    const now = Math.floor(Date.now() / 1000);

    return {
      now,
      midnight: now - secs,
      ymd: `${p.year}${p.month}${p.day}`
    };
  }

  function shiftYmd(ymd, days) {
    const d = new Date(Date.UTC(
      +ymd.slice(0, 4),
      +ymd.slice(4, 6) - 1,
      +ymd.slice(6, 8) + days,
      12
    ));
    return {
      ymd: d.toISOString().slice(0, 10).replace(/-/g, ""),
      dow: (d.getUTCDay() + 6) % 7
    };
  }

  function servicesOn(cal, ymd, dow) {
    const on = new Set(
      cal.cal.filter(c =>
        c.a <= ymd && ymd <= c.b && c.d[dow]
      ).map(c => c.s)
    );
    const ex = cal.ex[ymd];
    if (ex) {
      ex.add.forEach(s => on.add(s));
      ex.rm.forEach(s => on.delete(s));
    }
    return on;
  }

  function positions(tu, trip) {
    tu._pos ??= new Map();
    if (!tu._pos.has(trip.t)) {
      tu._pos.set(trip.t, tu.updates.map(u => {
        if (u.stop) {
          const hits = trip.st.map(
            (x, i) => x[0] === u.stop ? i : -1
          ).filter(i => i >= 0);
          if (hits.length === 1) return hits[0];
          if (hits.length > 1)
            return hits.find(
              i => trip.st[i][2] === u.seq
            ) ?? hits[0];
        }
        return u.seq != null
          ? trip.st.findIndex(x => x[2] === u.seq)
          : -1;
      }));
    }
    return tu._pos.get(trip.t);
  }

  function applyRealtime(
    tu, trip, idx, scheduledEpoch, dayMidnight
  ) {
    if (!tu) return {
      epoch: scheduledEpoch, live: false
    };
    if (tu.canceled) return null;

    const pos = positions(tu, trip);
    const k = pos.indexOf(idx);
    const exact = k >= 0 ? tu.updates[k] : null;

    if (exact) {
      if (exact.skipped) return null;
      if (exact.time) return {
        epoch: exact.time, live: true
      };
      if (exact.delay != null) return {
        epoch: scheduledEpoch + exact.delay,
        live: true
      };
    }

    let delay = null, at = -1;
    tu.updates.forEach((u, j) => {
      const p = pos[j];
      if (p < 0 || p >= idx || p < at) return;
      const d = u.delay != null ? u.delay :
        u.time
          ? u.time - (dayMidnight + trip.st[p][1])
          : null;
      if (d != null) {
        delay = d;
        at = p;
      }
    });

    return delay != null
      ? { epoch: scheduledEpoch + delay, live: true }
      : { epoch: scheduledEpoch, live: false };
  }

  function realtimeFor(tu, trip, day, days, now) {
    if (!tu) return null;
    if (tu.startDate)
      return tu.startDate === day.ymd ? tu : null;

    const mid = d => d.midnight +
      (trip.st[0][1] +
       trip.st[trip.st.length - 1][1]) / 2;

    const best = days.filter(
      d => d.services.has(trip.s)
    ).sort(
      (a, b) =>
        Math.abs(mid(a) - now) -
        Math.abs(mid(b) - now)
    )[0];

    return best === day ? tu : null;
  }

  async function arrivals({ stop, route, all, only }) {
    const [meta, cal, stops] = await Promise.all([
      data("routes.json"),
      data("calendar.json"),
      data("stops.geojson")
    ]);

    let live = false, preds = [], tus = new Map();

    if (RELAY) {
      try {
        tus = await relayTripUpdates();
        live = feedStatus("/v1/trip-updates").state === "fresh";
        if (!live) tus = new Map();
      } catch {}
    } else if (KEY && stop) {
      try {
        preds = parsePredictions(await swiftly(
          `/predictions?stop=${encodeURIComponent(stop)}`,
          "json"
        ));
        live = true;
      } catch {}
    }

    let routeIds;
    if (route) {
      routeIds = meta.stops[route] ? [route] : [];
    } else {
      routeIds = stops.features.find(
        x => x.properties.stop_id === stop
      )?.properties.routes || [];
    }

    if (only)
      routeIds = routeIds.filter(id => only.includes(id));

    const clock = localClock();
    const days = [-1, 0, 1].map(offset => {
      const { ymd, dow } = shiftYmd(clock.ymd, offset);
      return {
        ymd,
        midnight: clock.midnight + offset * 86400,
        services: servicesOn(cal, ymd, dow)
      };
    });

    const routeById = Object.fromEntries(
      meta.routes.map(r => [r.route_id, r])
    );
    const result = {};

    const scheds = await Promise.all(
      routeIds.map(rid =>
        data(`sched/${encodeURIComponent(rid)}.json`)
          .then(s => [rid, s])
      )
    );

    for (const [rid, sched] of scheds) {
      for (const day of days) {
        for (const trip of sched) {
          if (all && day.midnight > clock.midnight)
            continue;
          if (!day.services.has(trip.s)) continue;

          const tu = realtimeFor(
            tus.get(trip.t), trip, day, days, clock.now
          );

          for (let i = 0; i < trip.st.length - 1; i++) {
            const sid = trip.st[i][0];
            if (stop && sid !== stop) continue;

            const scheduled =
              day.midnight + trip.st[i][1];

            if (all) {
              if (scheduled < clock.midnight ||
                  scheduled >= clock.midnight + 86400 + 10800)
                continue;
            } else if (
              scheduled < clock.now - 10800 ||
              scheduled > clock.now + 108000
            ) {
              continue;
            }

            const r = applyRealtime(
              tu, trip, i, scheduled, day.midnight
            );

            if (!r ||
                (!all && r.epoch < clock.now - 30))
              continue;

            (result[sid] ??= []).push({
              route_id: rid,
              short_name:
                routeById[rid]?.short_name || rid,
              color: routeById[rid]?.color,
              headsign: trip.h,
              direction: trip.d,
              time: r.epoch,
              live: r.live,
              past: r.epoch < clock.now - 30,
              trip: trip.t
            });
          }
        }
      }
    }

    if (stop && preds.length) {
      const list = result[stop] || [];
      for (const pr of preds) {
        const a = pr.trip && list.filter(
          x => x.trip === pr.trip &&
            !x.live &&
            Math.abs(x.time - pr.time) < 10800
        ).sort(
          (x, y) =>
            Math.abs(x.time - pr.time) -
            Math.abs(y.time - pr.time)
        )[0];

        if (a) {
          a.time = pr.time;
          a.live = true;
          a.past = pr.time < clock.now - 30;
          continue;
        }

        if (!routeIds.includes(pr.route)) continue;

        list.push({
          route_id: pr.route,
          short_name:
            routeById[pr.route]?.short_name || pr.short,
          color: routeById[pr.route]?.color,
          headsign: pr.headsign,
          direction: pr.dir,
          time: pr.time,
          live: true,
          past: false,
          trip: pr.trip
        });
      }
      result[stop] = list;
    }

    const next = list =>
      list.filter(
        a => all || a.time >= clock.now - 30
      ).sort(
        (a, b) => a.time - b.time
      ).slice(0, COUNT);

    for (const sid in result) {
      if (all) {
        result[sid].sort((a, b) => a.time - b.time);
      } else if (stop) {
        result[sid] = next(result[sid]);
      } else {
        const byDir = {};
        for (const a of result[sid])
          (byDir[a.direction] ??= []).push(a);
        for (const d in byDir)
          byDir[d] = next(byDir[d]);
        result[sid] = byDir;
      }
    }

    return {
      live,
      arrivals: result,
      freshness: RELAY
        ? feedStatus("/v1/trip-updates") : null
    };
  }

  async function detours() {
    if (!RELAY) return null;
    const b = await relay("/v1/trip-updates");
    return {
      detours: b.detours || [],
      stops: b.stops || {}
    };
  }

  async function alerts() {
    if (!RELAY) return null;
    const b = await relay("/v1/alerts", 60000);
    const now = Date.now() / 1000;

    return (b.alerts || []).filter(a =>
      !a.periods.length ||
      a.periods.some(([s, e]) =>
        (!s || s <= now) && (!e || e >= now)
      )
    );
  }

  async function tempStopTimes(stopId) {
    if (!RELAY) return [];
    const tus = await relayTripUpdates(), out = [];

    for (const [trip, tu] of tus) {
      for (const u of tu.updates) {
        if (u.stop === stopId && u.time)
          out.push({ trip, time: u.time });
      }
    }
    return out;
  }

  globalThis.GMTLive = {
    configure({ key, dataDir, relay: r }) {
      KEY = key || "";
      if (dataDir) DATA = dataDir;
      RELAY = (r || "").replace(/\/$/, "");
    },
    data,
    vehicles,
    arrivals,
    detours,
    alerts,
    tempStopTimes,
    decodeTripUpdates,
    localClock,
    shiftYmd,
    servicesOn,
    applyRealtime,
    liveStatus,
    liveTrips: () =>
      RELAY ? relayTripUpdates() : Promise.resolve(null)
  };
})();
