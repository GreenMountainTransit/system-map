// GMT trip planner: finds bus trips between two points, with transfers, from the published schedule.
//
//   const trips = await GMTPlanner.plan({ from: [lon, lat], to: [lon, lat], depart: epochSeconds });
//
// It uses RAPTOR (round-based public transit routing), the method most journey planners use:
// round 1 finds everywhere reachable on one bus, round 2 adds one transfer, and so on.
// Walking: up to ACCESS_M to and from stops, up to TRANSFER_M between stops when changing buses.
// Live data: with the relay, every trip and stop gets Swiftly's live predictions before the search (applyLive), so
// every bus and transfer is timed live. Without the relay, the timetable is used.
(function () {
  const WALK_MPS = 1.25;          // walking speed, meters per second (about 2.8 mph)
  const DETOUR = 1.3;             // streets aren't straight lines: straight-line distance x 1.3
  const ACCESS_M = 800;           // farthest walk to the first stop / from the last stop (about 10 minutes)
  const TRANSFER_M = 900;         // allow realistic cross-stop transfers (e.g. UVMMC); about 12 min at walking speed
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
  // Hills: a casual rider loses about 10 seconds for every meter climbed, and gains a little going downhill (capped,
  // so steep descents don't look unrealistically fast). dz = meters of rise from start to end (null if unknown).
  const CLIMB_SECS_PER_M = 10, DESCENT_SECS_PER_M = 2;
  const bikeHillSecs = (m, dz) => {
    const base = bikeSecs(m);
    if (dz == null || !isFinite(dz)) return base;
    return Math.max(Math.round(base * 0.8), Math.round(base + (dz > 0 ? dz * CLIMB_SECS_PER_M : dz * DESCENT_SECS_PER_M)));
  };

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
      return { midnight: localMidnight(ymd), ymd, on: L().servicesOn(cal, ymd, dow) };
    });
    const patterns = [], byKey = new Map();
    for (const r of meta.routes) {
      let sched;
      try { sched = await L().data(`sched/${encodeURIComponent(r.route_id)}.json`); }
      catch (err) { console.warn(`[GMT planner] Missing schedule for route ${r.route_id}; skipping`, err); continue; }
      if (!Array.isArray(sched)) continue;
      for (const day of days) for (const trip of sched) {
        if (!day.on.has(trip.s)) continue;
        const key = r.route_id + "|" + trip.st.map((x) => x[0]).join(",");
        if (!byKey.has(key)) {
          byKey.set(key, patterns.length);
          patterns.push({ route: r.route_id, stops: trip.st.map((x) => idx.get(x[0])), trips: [] });
        }
        const sched = trip.st.map((x) => day.midnight + x[1]);
        // times = what the search uses (live when available); sched = the timetable; src/midnight/ymd for live updates.
        patterns[byKey.get(key)].trips.push({ id: trip.t, headsign: trip.h, times: sched.slice(), sched, src: trip, midnight: day.midnight, ymd: day.ymd, live: false });
      }
    }
    // Stay on board: when a trip ends where the next trip on the same block (same bus) and route begins, within
    // 30 minutes, riders can stay on (e.g. Route 96 turning around at the St. Albans Park and Ride, from "toward
    // St. Albans" to "toward Burlington"). Each such pair becomes a through trip, so the search sees one ride.
    {
      const byBlock = new Map();
      patterns.forEach((p) => p.trips.forEach((t) => { if (t.src.b) { const k = `${p.route}|${t.ymd}|${t.src.b}`; (byBlock.get(k) || byBlock.set(k, []).get(k)).push({ p, t }); } }));
      for (const list of byBlock.values()) {
        list.sort((a, b) => a.t.sched[0] - b.t.sched[0]);
        for (let i = 0; i + 1 < list.length; i++) {
          const A = list[i], B = list[i + 1], aEnd = A.t.sched.length - 1;
          const gap = B.t.sched[0] - A.t.sched[aEnd];
          if (A.t.src.st[aEnd][0] !== B.t.src.st[0][0] || gap < 0 || gap > 30 * 60) continue;
          const stopsThru = [...A.p.stops, ...B.p.stops.slice(1)];
          const key = A.p.route + "|thru|" + [...A.t.src.st.map((x) => x[0]), ...B.t.src.st.slice(1).map((x) => x[0])].join(",");
          if (!byKey.has(key)) { byKey.set(key, patterns.length); patterns.push({ route: A.p.route, stops: stopsThru, trips: [] }); }
          // At the turnaround stop, the time is when the bus leaves again (boarding there means waiting for that).
          const sched = [...A.t.sched.slice(0, aEnd), ...B.t.sched];
          patterns[byKey.get(key)].trips.push({ id: `${A.t.id}+${B.t.id}`, headsign: B.t.headsign, times: sched.slice(), sched, live: false, ymd: A.t.ymd,
            parts: [{ t: A.t, n: aEnd }, { t: B.t, n: B.t.sched.length }], stayAt: aEnd, firstHeadsign: A.t.headsign });
        }
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
    // Within the Downtown Transit Center, changing bays requires no walking-time estimate.
    // This does NOT eliminate the boarding/connection buffer. GTFS transfer rules take precedence.
    const dtc = (s) => /downtown transit center|\bdtc\b/i.test(s.name || "");
    const [rules] = await Promise.all([L().data("transfers.json").catch(() => ({}))]);
    const footpaths = stops.map((s, i) => near(s.c, TRANSFER_M).filter(([j]) => j !== i).flatMap(([j, m]) => {
      const rule = rules[`${s.id}|${stops[j].id}`];
      if (rule?.type === 3) return [];
      const inDtc = dtc(s) && dtc(stops[j]) && m <= 250;
      return [[j, rule?.seconds != null ? rule.seconds : inDtc ? 0 : walkSecs(m)]];
    }));
    net = { stops, idx, patterns, stopPatterns, footpaths, near, routes: Object.fromEntries(meta.routes.map((r) => [r.route_id, r])) };
    netDay = target.ymd;
    return net;
  }

  // ---------- one RAPTOR search ----------
  function raptor(n, from, to, depart, opt = {}) {
    const S = n.stops.length, INF = Infinity, accessM = opt.bike ? BIKE_ACCESS_M : opt.accessM || ACCESS_M, transferM = opt.transferM || TRANSFER_M;
    // Getting to the first stop and from the last stop. Biking includes hills when elevations are known (opt.elev):
    // so the planner prefers biking downhill to a stop and riding the bus up the hill.
    const el = opt.elev, stopEl = (i) => el?.stops?.get(n.stops[i].id);
    const dzTo = (i) => (el && el.from != null && stopEl(i) != null ? stopEl(i) - el.from : null);
    const dzFrom = (i) => (el && el.to != null && stopEl(i) != null ? el.to - stopEl(i) : null);
    const accessSecs = (i, m) => (opt.bike ? bikeHillSecs(m, dzTo(i)) : walkSecs(m));
    const egressSecs = (i, m) => (opt.bike ? bikeHillSecs(m, dzFrom(i)) : walkSecs(m));
    const usable = (i) => !opt.accessible || n.stops[i].acc !== "no"; // wheelchair mode: skip stops marked not accessible
    const access = n.near(from, accessM).filter(([i]) => usable(i)), egress = new Map(n.near(to, accessM).filter(([i]) => usable(i)).map(([i, m]) => [i, egressSecs(i, m)]));
    const tau = [new Float64Array(S).fill(INF)], label = [new Array(S)], best = new Float64Array(S).fill(INF);
    let marked = new Set();
    for (const [i, m] of access) { const a = accessSecs(i, m); tau[0][i] = depart + a; best[i] = tau[0][i]; label[0][i] = { kind: "access", secs: a }; marked.add(i); }
    // Bus trips are compared only with other bus trips: arriving at a stop by bike or on foot (no bus at all) never
    // blocks a bus arrival there, or every bus option could vanish whenever biking/walking the whole way is quicker.
    // (Walk and Bike for the whole trip are offered separately, after the bus trips.)
    const bestRide = new Float64Array(S).fill(INF);
    const targetBest = () => { let b = INF; for (const [i, w] of egress) if (bestRide[i] + w < b) b = bestRide[i] + w; return b; };

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
            if (arr < bestRide[s] && arr < cutoff) {
              tau[k][s] = arr; bestRide[s] = arr; if (arr < best[s]) best[s] = arr; newly.add(s);
              label[k][s] = { kind: "ride", pattern: pi, trip, boardPos, alightPos: pos, from: boardStop };
            }
          }
          // Can we catch an earlier bus here than the one we're on?
          const ready = tau[k - 1][s] + (k > 1 ? TRANSFER_BUFFER : 0);
          if (ready < INF && usable(s) && pos < p.stops.length - 1 && (!trip || ready <= trip.times[pos])) {
            let t = null; // the trip that actually leaves soonest (live delays can reorder buses)
            for (const x of p.trips) { const d = x.times[pos]; if (d >= ready && isFinite(d) && (!t || d < t.times[pos])) t = x; }
            if (t && t !== trip) { trip = t; boardPos = pos; boardStop = s; }
          }
        }
      }
      // Walk to nearby stops to change buses.
      for (const s of [...newly]) for (const [j, w] of n.footpaths[s]) {
        if (!usable(j) || w > walkSecs(transferM)) continue;
        const arr = tau[k][s] + w;
        if (arr < bestRide[j]) { tau[k][j] = arr; bestRide[j] = arr; if (arr < best[j]) best[j] = arr; label[k][j] = { kind: "walk", from: s, secs: w }; newly.add(j); }
      }
      marked = newly;
    }

    // Preserve more than just the earliest-arrival stop. Nearby alternatives can save
    // a substantial walk for a small increase in journey time. The preference selector
    // cannot select options that have already been discarded here.
    const results = [];
    for (let k = 1; k < tau.length; k++) {
      const ends = [...egress].filter(([i, w]) => isFinite(tau[k][i]) && isFinite(w))
        .map(([i, w]) => ({ i, w, arrival: tau[k][i] + w }))
        .sort((a, b) => a.arrival - b.arrival);
      if (!ends.length) continue;
      const fastest = ends[0].arrival;
      // Walking-first must not impose an arrival-time penalty. Keep the closest
      // destination stops even when their bus arrives much later. For fastest,
      // retain the existing bounded window to control candidate count.
      const candidates = opt.preferWalking
        ? ends.sort((a, b) => a.w - b.w || a.arrival - b.arrival).slice(0, 100)
        : ends.filter(e => e.arrival <= fastest + 20 * 60).slice(0, 25);
      for (const e of candidates) {
        const option = reconstruct(n, label, k, e.i, e.w, from, to, depart, opt);
        if (option && isFinite(option.arrive) && option.depart >= depart - 60) results.push(option);
      }
    }
    return results;
  }

  // Walking-first multi-criteria label search. Preserve BOTH time and walking cost at
  // every stop, rather than suppressing later arrivals just because an earlier bus exists.
  // Exact for the enumerated stop/footpath/timetable graph *within the stated horizon*
  // when no safety cap is reached; pedestrian walking times are still estimates.
  function walkingPareto(n, from, to, depart, opt = {}) {
    const horizon = depart + 14 * 3600; // permit long, low-walking journeys in winter
    const maxLabels = 180000;           // bound browser memory if source data is pathological
    const maxPerStop = 64;              // bound highly repetitive terminal patterns
    const accessible = i => !opt.accessible || n.stops[i].acc !== "no";
    const egress = n.near(to, ACCESS_M).filter(([i]) => accessible(i));
    const ending = new Map(egress.map(([i,m]) => [i, walkSecs(m)]));
    const perRound = Array.from({length: MAX_RIDES+1}, () => Array.from({length:n.stops.length}, () => []));
    const options = [];
    let nodes = 0, capped = false;
    function put(k, node) {
      if (nodes >= maxLabels) { capped = true; return false; }
      const bag = perRound[k][node.stop];
      if (bag.some(x => x.ready <= node.ready && x.walk <= node.walk)) return false;
      // Keep all non-dominated alternatives. Only cap genuinely excessive labels.
      for (let i=bag.length-1; i>=0; i--) if (node.ready <= bag[i].ready && node.walk <= bag[i].walk) bag.splice(i,1);
      if (bag.length >= maxPerStop) {
        capped = true;
        const worst = bag.reduce((a,b) => a.walk>b.walk ? a : b);
        if (worst.walk <= node.walk) return false;
        bag.splice(bag.indexOf(worst),1);
      }
      bag.push(node); nodes++;
      return true;
    }
    for (const [i,m] of n.near(from,ACCESS_M)) if (accessible(i)) {
      const seconds=walkSecs(m);
      put(0,{stop:i,ready:depart+seconds,walk:seconds,prev:null,kind:'access',seconds});
    }
    const candidateSet = new Set();
    const addResult = node => {
      const w=ending.get(node.stop);
      if (w === undefined || node.ready+w > horizon) return;
      const total=node.walk+w;
      // Retain the low-walking frontier, even when a journey arrives much later.
      const option=walkingReconstruct(n,node,w,from,to,depart,opt);
      if (!option || !Number.isFinite(option.arrive)) return;
      const key=option.legs.filter(l=>l.kind==='ride').map(l=>l.trip+':'+l.fromStop+':'+l.toStop).join('>');
      if (!candidateSet.has(key)) { candidateSet.add(key); options.push(option); }
    };
    for (let k=1; k<=MAX_RIDES; k++) {
      const prev=perRound[k-1], current=perRound[k];
      // Scan every active boarding label. Enumerating later departures is necessary:
      // a later bus may reduce a subsequent transfer walk substantially.
      for (let s=0;s<prev.length;s++) for (const state of prev[s]) {
        for (const [pi,pos] of n.stopPatterns[s]) {
          const pattern=n.patterns[pi];
          if (pos>=pattern.stops.length-1) continue;
          const earliest=state.ready+(k>1?TRANSFER_BUFFER:0);
          for (const trip of pattern.trips) {
            const dep=trip.times[pos];
            if (!Number.isFinite(dep) || dep<earliest || dep>horizon) continue;
            for (let a=pos+1;a<pattern.stops.length;a++) {
              const stop=pattern.stops[a], arr=trip.times[a];
              if (stop==null || !accessible(stop) || !Number.isFinite(arr) || arr<dep || arr>horizon) continue;
              put(k,{stop,ready:arr,walk:state.walk,prev:state,kind:'ride',pattern:pi,trip,b:pos,a});
            }
          }
        }
      }
      // Transfer walking edges: maintain walking cost, time, and provenance.
      // Multi-hop walks are valid but bounded by per-transfer walking distance.
      const queue=[];
      for (const bag of current) for (const x of bag) queue.push(x);
      for (let qi=0;qi<queue.length;qi++) {
        const x=queue[qi];
        if (!current[x.stop].includes(x)) continue; // dominated during expansion
        for (const [j, seconds] of n.footpaths[x.stop]) {
          if (!accessible(j) || seconds>walkSecs(TRANSFER_M) || x.ready+seconds>horizon) continue;
          const node={stop:j,ready:x.ready+seconds,walk:x.walk+seconds,prev:x,kind:'walk',seconds};
          if (put(k,node)) queue.push(node);
        }
      }
      for (const [stop] of ending) for (const node of current[stop]) addResult(node);
      if (capped && nodes>=maxLabels) break;
    }
    return { options, capped, labels:nodes, horizonHours:14 };
  }

  function walkingReconstruct(n, end, egressSecs, from, to, depart, opt={}) {
    const chain=[];
    for (let node=end;node;node=node.prev) chain.push(node);
    chain.reverse();
    if (!chain.length || chain[0].kind!=='access') return null;
    const firstStop=n.stops[chain[0].stop];
    const legs=[{kind:'walk',from,to:firstStop.c,toName:firstStop.name,secs:chain[0].seconds}];
    for (let i=1;i<chain.length;i++) {
      const step=chain[i], prior=chain[i-1];
      if (step.kind==='walk') {
        legs.push({kind:'walk',from:n.stops[prior.stop].c,to:n.stops[step.stop].c,fromName:n.stops[prior.stop].name,toName:n.stops[step.stop].name,secs:step.seconds});
        continue;
      }
      const p=n.patterns[step.pattern],r=n.routes[p.route],t=step.trip;
      const leg={kind:'ride',route:p.route,short:r.short_name,color:r.color,text:r.text_color,trip:t.id,
        fromStop:n.stops[prior.stop].id,fromName:n.stops[prior.stop].name,toStop:n.stops[step.stop].id,toName:n.stops[step.stop].name,
        dep:t.times[step.b],arr:t.times[step.a],stopsCount:step.a-step.b,
        path:p.stops.slice(step.b,step.a+1).filter(x=>x!=null).map(x=>n.stops[x].c),
        live:!!t.live,depDelay:t.times[step.b]-t.sched[step.b],arrDelay:t.times[step.a]-t.sched[step.a],
        _p:p,_trip:t,_b:step.b,_a:step.a,_n:n};
      rideDetails(leg,n,p,t,step.b,step.a);
      legs.push(leg);
    }
    legs.push({kind:'walk',from:n.stops[end.stop].c,to,fromName:n.stops[end.stop].name,secs:egressSecs});
    return finalizeLegs(n,legs,from,to,depart,opt);
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
        kind: "ride", route: p.route, short: r.short_name, color: r.color, text: r.text_color, trip: lb.trip.id,
        fromStop: n.stops[lb.from].id, fromName: n.stops[lb.from].name, toStop: n.stops[s].id, toName: n.stops[s].name,
        dep: lb.trip.times[lb.boardPos], arr: lb.trip.times[lb.alightPos], stopsCount: lb.alightPos - lb.boardPos,
        path: p.stops.slice(lb.boardPos, lb.alightPos + 1).filter((x) => x != null).map((x) => n.stops[x].c),
        live: !!lb.trip.live, depDelay: lb.trip.times[lb.boardPos] - lb.trip.sched[lb.boardPos], arrDelay: lb.trip.times[lb.alightPos] - lb.trip.sched[lb.alightPos],
        _p: p, _trip: lb.trip, _b: lb.boardPos, _a: lb.alightPos, _n: n, // for the walking clean-up below
      });
      rideDetails(legs[0], n, p, lb.trip, lb.boardPos, lb.alightPos);
      s = lb.from; k--;
    }
    legs.push({ kind: opt.bike ? "bike" : "walk", from: n.stops[stop].c, to, fromName: n.stops[stop].name, secs: egressSecs });
    return finalizeLegs(n,legs,from,to,depart,opt);
  }

  function finalizeLegs(n,legs,from,to,depart,opt={}) {
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
    // A common GTFS block is evidence of a planned vehicle continuation, not proof of
    // an operator-approved through ride. Flag it explicitly as a scheduled possibility.
    let previousRide = null, betweenWalk = false;
    for (const leg of legs) {
      if (leg.kind !== "ride") { if (previousRide && leg.secs > 30) betweenWalk = true; continue; }
      if (previousRide && !betweenWalk) {
        const a = previousRide._trip, b = leg._trip;
        const aEnd = a?.src?.st?.length - 1;
        const sameBlock = !!a?.src?.b && a.src.b === b?.src?.b && a.ymd === b.ymd;
        const terminals = aEnd >= 0 && previousRide._a === aEnd && leg._b === 0 && String(previousRide.toStop) === String(leg.fromStop);
        if (sameBlock && terminals && b.sched[0] - a.sched[aEnd] >= 0 && b.sched[0] - a.sched[aEnd] <= 1800)
          leg.scheduledInterline = { fromRoute: previousRide.short, toRoute: leg.short, stop: leg.fromName };
      }
      previousRide = leg; betweenWalk = false;
    }
    const arrive = legs[legs.length - 1].end;
    const trueWalkingSecs = legs.filter(l => l.kind === "walk").reduce((a,l) => a+l.secs,0);
    return { _walkSecs: trueWalkingSecs, legs: legs.filter((l) => l.kind === "ride" || l.secs > 30), depart: legs[0].kind !== "ride" ? legs[0].start : firstRide.dep, arrive,
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
      l.depDelay = l._trip.times[b] - l._trip.sched[b]; l.arrDelay = l._trip.times[a] - l._trip.sched[a];
      rideDetails(l, n, l._p, l._trip, b, a); // direction, shapes and stay-on for the new stops
    };
    const el = opt.elev, stopEl = (sIdx) => el?.stops?.get(n.stops[sIdx].id);
    const firstSecs = (l, sIdx, m) => (l.kind === "bike" ? bikeHillSecs(m, el?.from != null && stopEl(sIdx) != null ? stopEl(sIdx) - el.from : null) : walkSecs(m));
    const lastSecs = (l, sIdx, m) => (l.kind === "bike" ? bikeHillSecs(m, el?.to != null && stopEl(sIdx) != null ? el.to - stopEl(sIdx) : null) : walkSecs(m));
    // Getting on: the stop on this bus that lets you leave LATEST (bus time minus the walk to it), then the shorter
    // walk -- never boarding earlier and riding around a turnaround just to save a few steps.
    if (legs[0].kind !== "ride" && legs[1] === first) {
      let best = first._b, bestW = legs[0].secs, bestLeave = first._trip.times[first._b] - legs[0].secs;
      for (let pos = 0; pos < first._a; pos++) {
        const sIdx = first._p.stops[pos]; if (!ok(sIdx)) continue;
        const w = firstSecs(legs[0], sIdx, meters(from, n.stops[sIdx].c)), leave = first._trip.times[pos] - w;
        if (!isFinite(leave) || leave < depart - 60) continue;
        if (opt.preferWalking
          ? (w < bestW - 1 || (Math.abs(w - bestW) <= 1 && leave > bestLeave))
          : (leave > bestLeave + 30 || (leave >= bestLeave - 30 && w < bestW))) {
          best = pos; bestW = w; bestLeave = leave;
        }
      }
      if (best !== first._b) { set(first, best, first._a); legs[0].to = n.stops[first._p.stops[best]].c; legs[0].toName = first.fromName; legs[0].secs = bestW; }
    }
    const lastWalk = legs[legs.length - 1];
    // Getting off: the stop on this bus that gets you to your destination SOONEST (bus time plus the walk), then the
    // shorter walk -- never riding past a closer stop around a turnaround to save a few steps.
    if (lastWalk.kind !== "ride" && legs[legs.length - 2] === last) {
      let best = last._a, bestW = lastWalk.secs, bestArrive = last._trip.times[last._a] + lastWalk.secs;
      for (let pos = last._b + 1; pos < last._p.stops.length; pos++) {
        const sIdx = last._p.stops[pos]; if (!ok(sIdx)) continue;
        const w = lastSecs(lastWalk, sIdx, meters(n.stops[sIdx].c, to)), arrive = last._trip.times[pos] + w;
        if (!isFinite(arrive)) continue;
        if (opt.preferWalking
          ? (w < bestW - 1 || (Math.abs(w - bestW) <= 1 && arrive < bestArrive))
          : (arrive < bestArrive - 30 || (arrive <= bestArrive + 30 && w < bestW))) {
          best = pos; bestW = w; bestArrive = arrive;
        }
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

  // Direction sign, GTFS shape(s) and stay-on-board details for a ride, from where the rider boards and gets off.
  // Recomputed whenever the boarding or drop-off stop changes (e.g. a stop the bus passes before AND after a turnaround).
  function rideDetails(l, n, p, trip, b, a) {
    const thru = trip.parts && trip.stayAt != null;
    l.headsign = thru && a <= trip.stayAt ? trip.firstHeadsign : trip.headsign;
    l.shapes = !thru ? [trip.src?.p || null]
      : b >= trip.stayAt ? [trip.parts[1].t.src.p || null]      // only the part after the turnaround
      : a <= trip.stayAt ? [trip.parts[0].t.src.p || null]      // only the part before it
      : trip.parts.map((x) => x.t.src.p || null);
    if (thru && b < trip.stayAt && a > trip.stayAt) {
      const sp = n.stops[p.stops[trip.stayAt]];
      l.stayOn = { name: sp?.name || "", c: sp?.c, firstHeadsign: trip.firstHeadsign };
    } else delete l.stayOn;
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
  // not wheelchair accessible. Least walking ranks total walking seconds before all travel-time or transfer costs.
  // This is a walking-first heuristic over feasible RAPTOR candidates, not a globally exact pedestrian-network optimum.
  // Live predictions for every trip and stop (GTFS-realtime through the relay), laid over the timetable before
  // searching, so every leg and every transfer is timed live -- as Google Maps and Transit do. A canceled trip or
  // skipped stop can't be used. Trips without live data keep their timetable times.
  async function applyLive(n) {
    let tus = null;
    try { tus = await L().liveTrips?.(); } catch { tus = null; }
    const now = Date.now() / 1000;
    let liveTrips = 0;
    const liveFor = (t) => { // live times for one timetable trip (or null to keep the timetable)
      const tu = tus?.get(t.id);
      if (!tu) return null;
      if (tu.startDate ? tu.startDate !== t.ymd : Math.abs((t.sched[0] + t.sched[t.sched.length - 1]) / 2 - now) > 12 * 3600) return null;
      if (tu.canceled) return { times: t.sched.map(() => Infinity), live: false };
      let any = false;
      const times = t.sched.map((sec, i) => { const r = L().applyRealtime(tu, t.src, i, sec, t.midnight); if (!r) return Infinity; if (r.live) any = true; return r.epoch; });
      return { times, live: any };
    };
    for (const p of n.patterns) for (const t of p.trips) if (t.parts) { // through trip: its two halves
      const a = liveFor(t.parts[0].t) || { times: t.parts[0].t.sched, live: false }, b = liveFor(t.parts[1].t) || { times: t.parts[1].t.sched, live: false };
      t.times = [...a.times.slice(0, t.parts[0].n), ...b.times]; t.live = a.live || b.live;
    }
    for (const p of n.patterns) for (const t of p.trips) {
      if (t.parts) continue;
      t.times = t.sched.slice(); t.live = false;
      const tu = tus?.get(t.id);
      if (!tu) continue;
      if (tu.startDate ? tu.startDate !== t.ymd : Math.abs((t.sched[0] + t.sched[t.sched.length - 1]) / 2 - now) > 12 * 3600) continue; // that day's run only
      if (tu.canceled) { t.times = t.times.map(() => Infinity); continue; }
      let any = false;
      t.times = t.sched.map((sec, i) => { const r = L().applyRealtime(tu, t.src, i, sec, t.midnight); if (!r) return Infinity; if (r.live) any = true; return r.epoch; });
      t.live = any; if (any) liveTrips++;
    }
    return { feed: !!tus, trips: liveTrips };
  }
  async function plan({ from, to, depart, arriveBy, prefs = {}, dayOffset = 0, elev = null }) {
    const n = await network(dayOffset);
    const live = dayOffset === 0 ? await applyLive(n) : (n.patterns.forEach((p) => p.trips.forEach((t) => { t.times = t.sched.slice(); t.live = false; })), { feed: false, trips: 0 });
    // (applyLive handles through trips too: each half gets its own trip's live times.)
    // elev (bike mode): { from, to: meters above sea level, stops: Map(stop id -> meters) }, looked up by the page.
    const opt = { accessible: !!prefs.accessible, bike: !!prefs.bike, preferWalking: prefs.sort === "walk", elev: prefs.bike ? elev || null : null };
    const runs = [opt];
    let result, searchAudit = null;
    if (prefs.sort === "walk" && !prefs.bike) {
      const searchDepart = arriveBy ? arriveBy - 14 * 3600 : depart;
      searchAudit = walkingPareto(n, from, to, searchDepart, opt);
      const options = arriveBy ? searchAudit.options.filter(o=>o.arrive <= arriveBy) : searchAudit.options;
      result = finish(options,from,to);
      if (arriveBy) result.arriveBy = arriveBy;
    } else if (arriveBy) result = planArriveBy(n, from, to, arriveBy, runs);
    else {
      const options = [], seen = new Set();
      for (const o of runs) collect(n, from, to, depart, o, options, seen);
      result = finish(options, from, to);
    }
    return { ...result, options: sortByPref(result.options, prefs.sort), prefs, live,
      searchAudit: searchAudit && { mode:'walking-pareto', capped:searchAudit.capped, labels:searchAudit.labels, horizonHours:searchAudit.horizonHours, walkingModel:'straight-line × 1.3' } };
  }
  const walkTotal = (o) => o._walkSecs ?? o.legs.filter((l) => l.kind === "walk").reduce((a, l) => a + l.secs, 0);
  const bikeTotal = (o) => o.legs.filter((l) => l.kind === "bike").reduce((a, l) => a + l.secs, 0);
  function sortByPref(options, sort) {
    const by = { fastest: (a, b) => a.arrive - b.arrive || a.rides - b.rides || walkTotal(a) - walkTotal(b),
      walk: (a, b) => walkTotal(a) - walkTotal(b) || a.arrive - b.arrive || a.rides - b.rides,
      transfers: (a, b) => a.rides - b.rides || a.arrive - b.arrive || walkTotal(a) - walkTotal(b) }[sort] || ((a, b) => a.arrive - b.arrive || a.rides - b.rides);
    return options.filter(sensibleBusSequence).slice().sort(by).slice(0, 1).map((o) => ({ ...o, walkSecs: walkTotal(o), bikeSecs: bikeTotal(o) }));
  }
  function collect(n, from, to, depart, opt, options, seen) {
    // Search from the requested time, then again just after each option's first bus, to offer later choices too.
    let t = depart;
    for (let round = 0; round < 3; round++) {
      const found = raptor(n, from, to, t, opt);
      if (!found.length) break;
      for (const o of found) {
        const key = o.legs.filter((l) => l.kind === "ride").map((l) => `${l.trip}:${l.fromStop}:${l.toStop}`).join(">");
        if (!seen.has(key)) { seen.add(key); options.push(o); }
      }
      t = Math.min(...found.map((o) => o.legs.find((l) => l.kind === "ride").dep)) + 60;
    }
  }
  // Never recommend getting off one bus and boarding the SAME route again as a
  // connection. In particular, outbound-to-inbound backtracking is confusing and
  // unnecessary for a public trip planner. A through ride is represented by one leg.
  function sensibleBusSequence(option) {
    const rides = (option.legs || []).filter(l => l.kind === "ride");
    for (let i = 1; i < rides.length; i++) {
      if (String(rides[i - 1].route) === String(rides[i].route)) return false;
    }
    return true;
  }
  function finish(options, from, to) {
    options = options.filter(sensibleBusSequence);
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
    const validOptions = options.filter(sensibleBusSequence);
    const keep = validOptions.filter((o) => !validOptions.some((x) => x !== o && x.depart >= o.depart && x.rides <= o.rides && walkTotal(x) <= walkTotal(o) && (x.depart > o.depart || x.rides < o.rides || walkTotal(x) < walkTotal(o))));
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
        const key = o.legs.filter((l) => l.kind === "ride").map((l) => `${l.trip}:${l.fromStop}:${l.toStop}`).join(">");
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
