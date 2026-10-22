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

  const L = () => globalThis.GMTLive;
  let net = null, netDay = null;

  const meters = ([lo1, la1], [lo2, la2]) => {
    const k = Math.cos(((la1 + la2) / 2) * Math.PI / 180);
    return Math.hypot((lo2 - lo1) * k, la2 - la1) * 111320;
  };
  const walkSecs = (m) => Math.round((m * DETOUR) / WALK_MPS);

  // ---------- network: built once per service day from the data/ files ----------
  async function network() {
    const clock = L().localClock();
    if (net && netDay === clock.ymd) return net;
    const [meta, cal, stopsGeo] = await Promise.all([L().data("routes.json"), L().data("calendar.json"), L().data("stops.geojson")]);
    const stops = stopsGeo.features.map((f) => ({ id: f.properties.stop_id, name: f.properties.name, c: f.geometry.coordinates }));
    const idx = new Map(stops.map((s, i) => [s.id, i]));

    // Yesterday's late trips, today's, and tomorrow's early ones, as real times (seconds since 1970).
    const days = [-1, 0, 1].map((o) => {
      const { ymd, dow } = L().shiftYmd(clock.ymd, o);
      return { midnight: clock.midnight + o * 86400, on: L().servicesOn(cal, ymd, dow) };
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
    netDay = clock.ymd;
    return net;
  }

  // ---------- one RAPTOR search ----------
  function raptor(n, from, to, depart) {
    const S = n.stops.length, INF = Infinity;
    const access = n.near(from, ACCESS_M), egress = new Map(n.near(to, ACCESS_M).map(([i, m]) => [i, walkSecs(m)]));
    const tau = [new Float64Array(S).fill(INF)], label = [new Array(S)], best = new Float64Array(S).fill(INF);
    let marked = new Set();
    for (const [i, m] of access) { tau[0][i] = depart + walkSecs(m); best[i] = tau[0][i]; label[0][i] = { kind: "access", secs: walkSecs(m) }; marked.add(i); }
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
          if (trip) {
            const arr = trip.times[pos];
            if (arr < best[s] && arr < cutoff) {
              tau[k][s] = arr; best[s] = arr; newly.add(s);
              label[k][s] = { kind: "ride", pattern: pi, trip, boardPos, alightPos: pos, from: boardStop };
            }
          }
          // Can we catch an earlier bus here than the one we're on?
          const ready = tau[k - 1][s] + (k > 1 && label[k - 1][s]?.kind === "ride" ? TRANSFER_BUFFER : 0);
          if (ready < INF && pos < p.stops.length - 1 && (!trip || ready <= trip.times[pos])) {
            const t = p.trips.find((x) => x.times[pos] >= ready);
            if (t && t !== trip) { trip = t; boardPos = pos; boardStop = s; }
          }
        }
      }
      // Walk to nearby stops to change buses.
      for (const s of [...newly]) for (const [j, w] of n.footpaths[s]) {
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
      results.push(reconstruct(n, label, k, bestStop, egress.get(bestStop), from, to, depart));
    }
    return results;
  }

  function reconstruct(n, label, k, stop, egressSecs, from, to, depart) {
    const legs = [];
    let s = stop;
    while (k >= 0) {
      const lb = label[k][s];
      if (!lb) break;
      if (lb.kind === "access") { legs.unshift({ kind: "walk", from, to: n.stops[s].c, toName: n.stops[s].name, secs: lb.secs }); break; }
      if (lb.kind === "walk") { legs.unshift({ kind: "walk", from: n.stops[lb.from].c, to: n.stops[s].c, fromName: n.stops[lb.from].name, toName: n.stops[s].name, secs: lb.secs }); s = lb.from; continue; }
      const p = n.patterns[lb.pattern], r = n.routes[p.route];
      legs.unshift({
        kind: "ride", route: p.route, short: r.short_name, color: r.color, text: r.text_color, headsign: lb.trip.headsign, trip: lb.trip.id,
        fromStop: n.stops[lb.from].id, fromName: n.stops[lb.from].name, toStop: n.stops[s].id, toName: n.stops[s].name,
        dep: lb.trip.times[lb.boardPos], arr: lb.trip.times[lb.alightPos], stopsCount: lb.alightPos - lb.boardPos,
        path: p.stops.slice(lb.boardPos, lb.alightPos + 1).filter((x) => x != null).map((x) => n.stops[x].c),
      });
      s = lb.from; k--;
    }
    legs.push({ kind: "walk", from: n.stops[stop].c, to, fromName: n.stops[stop].name, secs: egressSecs });
    // Times: walking legs are placed right before / after the rides they connect.
    const firstRide = legs.find((l) => l.kind === "ride");
    let t = firstRide.dep - (legs[0].kind === "walk" ? legs[0].secs : 0);
    const start = Math.max(depart, t);
    for (const l of legs) {
      if (l.kind === "ride") { t = l.arr; continue; }
      l.start = l === legs[0] ? firstRide.dep - l.secs : t; l.end = l.start + l.secs; t = l.end;
    }
    const arrive = legs[legs.length - 1].end;
    return { legs: legs.filter((l) => l.kind === "ride" || l.secs > 30), depart: legs[0].kind === "walk" ? legs[0].start : firstRide.dep, arrive,
      rides: legs.filter((l) => l.kind === "ride").length, leaveBy: start };
  }

  // ---------- public: plan a trip ----------
  async function plan({ from, to, depart }) {
    const n = await network();
    const options = [], seen = new Set();
    // Search from the requested time, then again just after each option's first bus, to offer later choices too.
    let t = depart;
    for (let round = 0; round < 3; round++) {
      const found = raptor(n, from, to, t);
      if (!found.length) break;
      for (const o of found) {
        const key = o.legs.filter((l) => l.kind === "ride").map((l) => l.trip).join(">");
        if (!seen.has(key)) { seen.add(key); options.push(o); }
      }
      t = Math.min(...found.map((o) => o.legs.find((l) => l.kind === "ride").dep)) + 60;
    }
    // Drop options another option beats: leaving no earlier, arriving no later, with no more buses.
    const keep = options.filter((o) => !options.some((x) => x !== o && x.depart >= o.depart && x.arrive <= o.arrive && x.rides <= o.rides &&
      (x.depart > o.depart || x.arrive < o.arrive || x.rides < o.rides)));
    options.length = 0; options.push(...keep);
    options.sort((a, b) => a.arrive - b.arrive || a.rides - b.rides);
    const direct = meters(from, to);
    const walkOnly = direct <= DIRECT_WALK_M ? { walkOnly: true, secs: walkSecs(direct), meters: Math.round(direct * DETOUR) } : null;
    return { options: options.slice(0, 4), walkOnly };
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

  globalThis.GMTPlanner = { plan, liveFirstBus, settings: { WALK_MPS, ACCESS_M, TRANSFER_M, TRANSFER_BUFFER, MAX_RIDES } };
})();
