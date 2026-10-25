// GMT trip planner: finds bus trips between two points, with transfers, from the published schedule.
//
//   const trips = await GMTPlanner.plan({ from: [lon, lat], to: [lon, lat], depart: epochSeconds });
//
// It uses RAPTOR (round-based public transit routing), the method most journey planners use:
// round 1 finds everywhere reachable on one bus, round 2 adds one transfer, and so on.
// Walking: up to ACCESS_M to and from stops, up to TRANSFER_M between stops when changing buses.
// Live data: GMT's real-time predictions are only available one stop at a time, so each suggested
// trip's FIRST bus is checked live (GMTLive.arrivals); later legs use the timetable.
(function () {
  const WALK_MPS = 1.25;          // walking speed, meters per second (about 2.8 mph)
  const DETOUR = 1.3;             // streets aren't straight lines: straight-line distance x 1.3
  const ACCESS_M = 800;           // farthest walk to the first stop / from the last stop (about 10 minutes)
  const TRANSFER_M = 400;         // farthest walk between stops when transferring
  const TRANSFER_BUFFER = 120;    // at least 2 minutes to change buses
  const MAX_RIDES = 3;            // at most 3 buses (2 transfers)
  const DIRECT_WALK_M = 1600;     // also offer "just walk" if it's under about 20 minutes
  const BIKE_MPS = 4.2;           // cycling speed, about 9.5 mph
  const BIKE_ACCESS_M = 3200;     // bike-friendly mode: cycle up to ~2 miles to the first stop / from the last stop

  const L = () => globalThis.GMTLive;
  let net = null, netDay = null;

  const meters = ([lo1, la1], [lo2, la2]) => {
    const k = Math.cos(((la1 + la2) / 2) * Math.PI / 180);
    return Math.hypot((lo2 - lo1) * k, la2 - la1) * 111320;
  };
  const walkSecs = (m) => Math.round((m * DETOUR) / WALK_MPS);
  const bikeSecs = (m) => Math.round((m * DETOUR) / BIKE_MPS) + 60; // + a minute to lock or load the bike

  // ---------- network: built once per service day from the data/ files ----------
  // Midnight in Vermont at the start of a date (YYYYMMDD), as seconds since 1970 (right across daylight-saving changes).
  function localMidnight(ymd) {
    const y = +ymd.slice(0, 4), m = +ymd.slice(4, 6) - 1, d = +ymd.slice(6, 8);
    for (const h of [4, 5, 3, 6]) { // Vermont is UTC-4 (summer) or UTC-5 (winter)
      const t = Date.UTC(y, m, d, h) / 1000;
      const hh = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t * 1000));
      if (hh === "00:00") return t;
    }
    return Date.UTC(y, m, d, 5) / 1000;
  }
  // The date (and its midnight) `dayOffset` days from today in Vermont: 0 = today, 1 = tomorrow...
  function dayAt(dayOffset = 0) { const { ymd, dow } = L().shiftYmd(L().localClock().ymd, dayOffset); return { ymd, dow, midnight: localMidnight(ymd) }; }
  async function network(dayOffset = 0) {
    const target = dayAt(dayOffset);
    if (net && netDay === target.ymd) return net;
    const [meta, cal, stopsGeo] = await Promise.all([L().data("routes.json"), L().data("calendar.json"), L().data("stops.geojson")]);
    // Accessibility: "no" if EITHER source says the stop isn't accessible (GTFS wheelchair boarding, or no ADA boarding
    // pad in GMT's stop survey) -- safest for riders using wheelchairs; "yes" if a source confirms it; "" if not known.
    const acc = (p) => (p.wheelchair === "no" || p.ada_pad === "no" ? "no" : p.wheelchair === "yes" || p.ada_pad === "yes" ? "yes" : "");
    const stops = stopsGeo.features.map((f) => ({ id: f.properties.stop_id, name: f.properties.name, c: f.geometry.coordinates, acc: acc(f.properties) }));
    const idx = new Map(stops.map((s, i) => [s.id, i]));

    // The day before's late trips, the chosen day's, and the next day's early ones, as real times (seconds since 1970).
    const days = [-1, 0, 1].map((o) => {
      const { ymd, dow } = L().shiftYmd(target.ymd, o);
      return { midnight: localMidnight(ymd), on: L().servicesOn(cal, ymd, dow) };
    });
    const patterns = [], byKey = new Map();
    for (const r of meta.routes) {
      const sched = await L().data(`sched/${encodeURIComponent(r.route_id)}.json`);
      for (const day of days) for (const trip of sched) {
        if (!day.on.has(trip.s)) continue;
        const key = r.route_id + "|" + trip.st.map((x) => x[0]).join(",");
        if (!byKey.has(key)) {
          byKey.set(key, patterns.length);
          patterns.push({ route: r.route_id, stops: trip.st.map((x) => idx.get(x[0])), trips: [] });
        }
        patterns[byKey.get(key)].trips.push({ id: trip.t, headsign: trip.h, times: trip.st.map((x) => day.midnight + x[1]) });
      }
    }
    for (const p of patterns) p.trips.sort((a, b) => a.times[0] - b.times[0]);
    const stopPatterns = stops.map(() => []);
    patterns.forEach((p, pi) => p.stops.forEach((s, pos) => s != null && stopPatterns[s].push([pi, pos])));

    // Walking transfers between nearby stops (grid lookup, so it stays fast).
    const cell = (c) => `${Math.floor(c[0] / 0.006)}:${Math.floor(c[1] / 0.004)}`;
    const grid = new Map();
    stops.forEach((s, i) => { const k = cell(s.c); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
    const near = (c, maxM) => {
      const [gx, gy] = cell(c).split(":").map(Number), out = [];
      const span = Math.ceil(maxM / 400);
      for (let x = gx - span; x <= gx + span; x++) for (let y = gy - span; y <= gy + span; y++)
        for (const i of grid.get(`${x}:${y}`) || []) { const m = meters(c, stops[i].c); if (m <= maxM) out.push([i, m]); }
      return out;
    };
    const footpaths = stops.map((s, i) => near(s.c, TRANSFER_M).filter(([j]) => j !== i).map(([j, m]) => [j, walkSecs(m)]));
    net = { stops, idx, patterns, stopPatterns, footpaths, near, routes: Object.fromEntries(meta.routes.map((r) => [r.route_id, r])) };
    netDay = target.ymd;
    return net;
  }

  // ---------- one RAPTOR search ----------
  function raptor(n, from, to, depart, opt = {}) {
    const S = n.stops.length, INF = Infinity, accessM = opt.bike ? BIKE_ACCESS_M : opt.accessM || ACCESS_M, transferM = opt.transferM || TRANSFER_M;
    const endSecs = opt.bike ? bikeSecs : walkSecs; // getting to the first stop and from the last stop
    const usable = (i) => !opt.accessible || n.stops[i].acc !== "no"; // wheelchair mode: skip stops marked not accessible
    const access = n.near(from, accessM).filter(([i]) => usable(i)), egress = new Map(n.near(to, accessM).filter(([i]) => usable(i)).map(([i, m]) => [i, endSecs(m)]));
    const tau = [new Float64Array(S).fill(INF)], label = [new Array(S)], best = new Float64Array(S).fill(INF);
    let marked = new Set();
    for (const [i, m] of access) { tau[0][i] = depart + endSecs(m); best[i] = tau[0][i]; label[0][i] = { kind: "access", secs: endSecs(m) }; marked.add(i); }
    const targetBest = () => { let b = INF; for (const [i, w] of egress) if (best[i] + w < b) b = best[i] + w; return b; };

    for (let k = 1; k <= MAX_RIDES && marked.size; k++) {
      tau[k] = new Float64Array(S).fill(INF); label[k] = new Array(S);
      const queue = new Map();
      for (const s of marked) for (const [pi, pos] of n.stopPatterns[s]) if (!queue.has(pi) || pos < queue.get(pi)) queue.set(pi, pos);
      const newly = new Set(), cutoff = targetBest();
      for (const [pi, start] of queue) {
        const p = n.patterns[pi];
        let trip = null, boardPos = -1, boardStop = -1;
        for (let pos = start; pos < p.stops.length; pos++) {
          const s = p.stops[pos]; if (s == null) continue;
          if (trip && usable(s)) {
            const arr = trip.times[pos];
            if (arr < best[s] && arr < cutoff) {
              tau[k][s] = arr; best[s] = arr; newly.add(s);
              label[k][s] = { kind: "ride", pattern: pi, trip, boardPos, alightPos: pos, from: boardStop };
            }
          }
          // Can we catch an earlier bus here than the one we're on?
          const ready = tau[k - 1][s] + (k > 1 && label[k - 1][s]?.kind === "ride" ? TRANSFER_BUFFER : 0);
          if (ready < INF && usable(s) && pos < p.stops.length - 1 && (!trip || ready <= trip.times[pos])) {
            const t = p.trips.find((x) => x.times[pos] >= ready);
            if (t && t !== trip) { trip = t; boardPos = pos; boardStop = s; }
          }
        }
      }
      // Walk to nearby stops to change buses.
      for (const s of [...newly]) for (const [j, w] of n.footpaths[s]) {
        if (!usable(j) || w > walkSecs(transferM)) continue;
        const arr = tau[k][s] + w;
        if (arr < best[j]) { tau[k][j] = arr; best[j] = arr; label[k][j] = { kind: "walk", from: s, secs: w }; newly.add(j); }
      }
      marked = newly;
    }

    // Best arrival at the destination for each number of buses; keep only options that are faster
    // than every option with fewer buses.
    const results = [];
    let bestSoFar = INF;
    for (let k = 1; k < tau.length; k++) {
      let bestStop = -1, bestArr = INF;
      for (const [i, w] of egress) if (tau[k][i] + w < bestArr) { bestArr = tau[k][i] + w; bestStop = i; }
      if (bestStop < 0 || bestArr >= bestSoFar) continue;
      bestSoFar = bestArr;
      results.push(reconstruct(n, label, k, bestStop, egress.get(bestStop), from, to, depart, opt));
    }
    return results;
  }

  function reconstruct(n, label, k, stop, egressSecs, from, to, depart, opt = {}) {
    const legs = [];
    let s = stop;
    while (k >= 0) {
      const lb = label[k][s];
      if (!lb) break;
      if (lb.kind === "access") { legs.unshift({ kind: opt.bike ? "bike" : "walk", from, to: n.stops[s].c, toName: n.stops[s].name, secs: lb.secs }); break; }
      if (lb.kind === "walk") { legs.unshift({ kind: "walk", from: n.stops[lb.from].c, to: n.stops[s].c, fromName: n.stops[lb.from].name, toName: n.stops[s].name, secs: lb.secs }); s = lb.from; continue; }
      const p = n.patterns[lb.pattern], r = n.routes[p.route];
      legs.unshift({
        kind: "ride", route: p.route, short: r.short_name, color: r.color, text: r.text_color, headsign: lb.trip.headsign, trip: lb.trip.id,
        fromStop: n.stops[lb.from].id, fromName: n.stops[lb.from].name, toStop: n.stops[s].id, toName: n.stops[s].name,
        dep: lb.trip.times[lb.boardPos], arr: lb.trip.times[lb.alightPos], stopsCount: lb.alightPos - lb.boardPos,
        path: p.stops.slice(lb.boardPos, lb.alightPos + 1).filter((x) => x != null).map((x) => n.stops[x].c),
        _p: p, _trip: lb.trip, _b: lb.boardPos, _a: lb.alightPos, _n: n, // for the walking clean-up below
      });
      s = lb.from; k--;
    }
    legs.push({ kind: opt.bike ? "bike" : "walk", from: n.stops[stop].c, to, fromName: n.stops[stop].name, secs: egressSecs });
    shortenWalks(n, legs, from, to, depart, opt);
    mergeEndLegs(legs);
    // Times: walking legs are placed right before / after the rides they connect.
    const firstRide = legs.find((l) => l.kind === "ride");
    let t = firstRide.dep - (legs[0].kind !== "ride" ? legs[0].secs : 0);
    const start = Math.max(depart, t);
    for (const l of legs) {
      if (l.kind === "ride") { t = l.arr; continue; }
      l.start = l === legs[0] ? firstRide.dep - l.secs : t; l.end = l.start + l.secs; t = l.end;
    }
    const arrive = legs[legs.length - 1].end;
    return { legs: legs.filter((l) => l.kind === "ride" || l.secs > 30), depart: legs[0].kind !== "ride" ? legs[0].start : firstRide.dep, arrive,
      rides: legs.filter((l) => l.kind === "ride").length, leaveBy: start };
  }

  // Least walking for the same buses: board the first bus at whichever of its stops is the shortest walk from
  // the start (if it still leaves after you could get there), and get off the last bus at whichever of its later
  // stops is the shortest walk to the destination.
  function shortenWalks(n, legs, from, to, depart, opt = {}) {
    const ok = (sIdx) => sIdx != null && (!opt.accessible || n.stops[sIdx].acc !== "no"); // wheelchair mode: never move to an inaccessible stop
    const rides = legs.filter((l) => l.kind === "ride");
    const first = rides[0], last = rides[rides.length - 1];
    const set = (l, b, a) => {
      l._b = b; l._a = a;
      l.fromStop = n.stops[l._p.stops[b]].id; l.fromName = n.stops[l._p.stops[b]].name; l.dep = l._trip.times[b];
      l.toStop = n.stops[l._p.stops[a]].id; l.toName = n.stops[l._p.stops[a]].name; l.arr = l._trip.times[a];
      l.stopsCount = a - b; l.path = l._p.stops.slice(b, a + 1).filter((x) => x != null).map((x) => n.stops[x].c);
    };
    const endSecs = (l) => (l.kind === "bike" ? bikeSecs : walkSecs);
    if (legs[0].kind !== "ride" && legs[1] === first) {
      let best = first._b, bestW = legs[0].secs;
      for (let pos = 0; pos < first._a; pos++) {
        const sIdx = first._p.stops[pos]; if (!ok(sIdx)) continue;
        const w = endSecs(legs[0])(meters(from, n.stops[sIdx].c));
        if (w < bestW && first._trip.times[pos] - w >= depart - 60) { best = pos; bestW = w; }
      }
      if (best !== first._b) { set(first, best, first._a); legs[0].to = n.stops[first._p.stops[best]].c; legs[0].toName = first.fromName; legs[0].secs = bestW; }
    }
    const lastWalk = legs[legs.length - 1];
    if (lastWalk.kind !== "ride" && legs[legs.length - 2] === last) {
      let best = last._a, bestW = lastWalk.secs;
      for (let pos = last._b + 1; pos < last._p.stops.length; pos++) {
        const sIdx = last._p.stops[pos]; if (!ok(sIdx)) continue;
        const w = endSecs(lastWalk)(meters(n.stops[sIdx].c, to));
        if (w < bestW) { best = pos; bestW = w; }
      }
      if (best !== last._a) { set(last, last._b, best); lastWalk.from = n.stops[last._p.stops[best]].c; lastWalk.fromName = last.toName; lastWalk.secs = bestW; }
    }
    // A transfer walk next to a changed ride starts or ends at that ride's new stop.
    for (let i = 1; i < legs.length - 1; i++) if (legs[i].kind === "walk") {
      const before = legs[i - 1], after = legs[i + 1];
      if (before.kind === "ride") { legs[i].from = n.stops[before._p.stops[before._a]].c; legs[i].fromName = before.toName; }
      if (after.kind === "ride") { legs[i].to = n.stops[after._p.stops[after._b]].c; legs[i].toName = after.fromName; }
    }
    for (const l of rides) { l.fromAcc = n.stops[l._p.stops[l._b]].acc; l.toAcc = n.stops[l._p.stops[l._a]].acc; delete l._p; delete l._trip; delete l._b; delete l._a; delete l._n; }
  }

  // Back-to-back walking (or walking then biking) becomes one leg, straight from the first start to the last end:
  // e.g. a transfer walk to a stop followed by a walk from that stop to the destination.
  function mergeEndLegs(legs) {
    for (let i = legs.length - 1; i > 0; i--) {
      const a = legs[i - 1], b = legs[i];
      if (a.kind === "ride" || b.kind === "ride") continue;
      const bike = a.kind === "bike" || b.kind === "bike", m = meters(a.from, b.to);
      legs.splice(i - 1, 2, { kind: bike ? "bike" : "walk", from: a.from, to: b.to, fromName: a.fromName, toName: b.toName,
        secs: Math.min(a.secs + b.secs, bike ? bikeSecs(m) : walkSecs(m)) });
    }
  }

  // ---------- public: plan a trip ----------
  // Preferences: sort = "fastest" | "walk" (least walking) | "transfers" (fewest); accessible = avoid stops marked
  // not wheelchair accessible. Least-walking also searches with shorter walking limits, for options that walk less.
  async function plan({ from, to, depart, arriveBy, prefs = {}, dayOffset = 0 }) {
    const n = await network(dayOffset);
    const opt = { accessible: !!prefs.accessible, bike: !!prefs.bike };
    const runs = prefs.sort === "walk" ? [opt, { ...opt, accessM: 450, transferM: 200 }] : [opt];
    let result;
    if (arriveBy) result = planArriveBy(n, from, to, arriveBy, runs);
    else {
      const options = [], seen = new Set();
      for (const o of runs) collect(n, from, to, depart, o, options, seen);
      result = finish(options, from, to);
    }
    return { ...result, options: sortByPref(result.options, prefs.sort), prefs };
  }
  const walkTotal = (o) => o.legs.filter((l) => l.kind === "walk").reduce((a, l) => a + l.secs, 0);
  const bikeTotal = (o) => o.legs.filter((l) => l.kind === "bike").reduce((a, l) => a + l.secs, 0);
  function sortByPref(options, sort) {
    const by = { fastest: (a, b) => a.arrive - b.arrive || a.rides - b.rides, walk: (a, b) => walkTotal(a) - walkTotal(b) || a.arrive - b.arrive,
      transfers: (a, b) => a.rides - b.rides || a.arrive - b.arrive }[sort] || ((a, b) => a.arrive - b.arrive || a.rides - b.rides);
    return options.slice().sort(by).slice(0, 4).map((o) => ({ ...o, walkSecs: walkTotal(o), bikeSecs: bikeTotal(o) }));
  }
  function collect(n, from, to, depart, opt, options, seen) {
    // Search from the requested time, then again just after each option's first bus, to offer later choices too.
    let t = depart;
    for (let round = 0; round < 3; round++) {
      const found = raptor(n, from, to, t, opt);
      if (!found.length) break;
      for (const o of found) {
        const key = o.legs.filter((l) => l.kind === "ride").map((l) => l.trip).join(">");
        if (!seen.has(key)) { seen.add(key); options.push(o); }
      }
      t = Math.min(...found.map((o) => o.legs.find((l) => l.kind === "ride").dep)) + 60;
    }
  }
  function finish(options, from, to) {
    // Drop options another option beats: leaving no earlier, arriving no later, with no more buses and no more walking.
    const keep = options.filter((o) => !options.some((x) => x !== o && x.depart >= o.depart && x.arrive <= o.arrive && x.rides <= o.rides && walkTotal(x) <= walkTotal(o) &&
      (x.depart > o.depart || x.arrive < o.arrive || x.rides < o.rides || walkTotal(x) < walkTotal(o))));
    const direct = meters(from, to);
    const walkOnly = direct <= DIRECT_WALK_M ? { walkOnly: true, secs: walkSecs(direct), meters: Math.round(direct * DETOUR) } : null;
    return { options: keep, walkOnly };
  }

  // Arrive by: search forward from 3 hours before the target, collecting trips that get there in time,
  // then offer the ones that leave latest (so riders don't wait around).
  function planArriveBy(n, from, to, arriveBy, runs = [{}]) {
    const options = [], seen = new Set();
    for (const opt of runs) arriveByRun(n, from, to, arriveBy, opt, options, seen);
    const keep = options.filter((o) => !options.some((x) => x !== o && x.depart >= o.depart && x.rides <= o.rides && walkTotal(x) <= walkTotal(o) && (x.depart > o.depart || x.rides < o.rides || walkTotal(x) < walkTotal(o))));
    keep.sort((a, b) => b.depart - a.depart || a.rides - b.rides);
    const direct = meters(from, to);
    return { options: keep, walkOnly: direct <= DIRECT_WALK_M ? { walkOnly: true, secs: walkSecs(direct), meters: Math.round(direct * DETOUR) } : null, arriveBy };
  }
  function arriveByRun(n, from, to, arriveBy, opt, options, seen) {
    let t = arriveBy - 3 * 3600;
    for (let round = 0; round < 12; round++) {
      const found = raptor(n, from, to, t, opt);
      if (!found.length) break;
      let anyInTime = false;
      for (const o of found) {
        if (o.arrive > arriveBy) continue;
        anyInTime = true;
        const key = o.legs.filter((l) => l.kind === "ride").map((l) => l.trip).join(">");
        if (!seen.has(key)) { seen.add(key); options.push(o); }
      }
      const nextT = Math.min(...found.map((o) => o.legs.find((l) => l.kind === "ride").dep)) + 60;
      if (!anyInTime && Math.min(...found.map((o) => o.arrive)) > arriveBy) break;
      t = nextT;
    }
  }

  // Check the first bus of a trip against Swiftly's live predictions for its boarding stop.
  async function liveFirstBus(option) {
    const ride = option.legs.find((l) => l.kind === "ride");
    try {
      const r = await L().arrivals({ stop: ride.fromStop, only: [ride.route] });
      const hit = (r.arrivals[ride.fromStop] || []).find((a) => a.trip === ride.trip);
      if (hit && hit.live) return { live: true, dep: hit.time, delay: hit.time - ride.dep };
      return { live: false, feed: r.live };
    } catch { return { live: false, feed: false }; }
  }

  globalThis.GMTPlanner = { plan, liveFirstBus, dayAt, settings: { WALK_MPS, ACCESS_M, TRANSFER_M, TRANSFER_BUFFER, MAX_RIDES } };
})();
