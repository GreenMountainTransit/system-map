// GMT 3D models for the 3D view, built in the browser as glTF:
//
//   const busUrl  = await GMTBus3D.build({ color: "#f4432e", short: "1", headsign: "Williston" });
//   const signUrl = await GMTBus3D.buildStopSign();
//   map.addModel("gmt-bus", busUrl);
//
// The bus wears GMT's livery (light blue body, green mountains along the side, charcoal bumper, the GMT logo),
// a lit destination sign, and a friendly driver sitting on the left, facing forward. The stop sign copies GMT's
// real sign: light blue with a white bus, "BUS STOP", and green hills with the logo and phone number.
// Sizes are real-world meters; the map scales them up so they read at street zoom.
(function () {
  const L = 12.2, W = 2.6, H = 2.95, LIFT = 0.42; // bus length, width, body height, height of the body above the road
  const SKY = "#a9c9ec", SKY_LIGHT = "#c3dbf3", CHARCOAL = "#3a4248", GLASS = "#141a20", GREEN = "#5bb947", TEAL = "#2d9c8c", AMBER = "#ffb43c";
  let logoImg = null;
  const tryImg = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
  const loadLogo = () => logoImg ?? (logoImg = tryImg("gmt-logo.png").then((im) => im || tryImg("assets/gmt-logo.png")));
  // The logo recolored white (as painted on the buses).
  function whiteLogo(logo) {
    if (!logo) return null;
    const c = document.createElement("canvas"); c.width = logo.width; c.height = logo.height;
    const g = c.getContext("2d"); g.drawImage(logo, 0, 0); g.globalCompositeOperation = "source-in"; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  // ---------- bus texture: one 1024x1024 image holding every face ----------
  const R = { right: [0, 0, 1024, 248], left: [0, 256, 1024, 248], front: [0, 512, 224, 248], back: [256, 512, 224, 248], roof: [512, 512, 512, 110] };

  // A friendly driver. "front": seen through the windshield. "side": in profile, facing `dir` (+1 right, -1 left),
  // so eyes, cap brim, mouth, hands and wheel all point toward the front of the bus.
  function drawDriver(g, cx, cy, s, view, dir = 1) {
    g.save(); g.translate(cx, cy); g.scale(s * (view === "side" ? dir : 1), s);
    g.fillStyle = "#3b6fb6"; g.beginPath(); g.ellipse(0, 46, 34, 22, 0, Math.PI, 0); g.fill();            // shirt
    g.fillStyle = "#f1c48f"; g.beginPath(); g.arc(0, 8, 21, 0, 7); g.fill();                           // head
    g.fillStyle = GREEN; g.beginPath(); g.ellipse(0, -6, 23, 13, 0, Math.PI, 0); g.fill();             // cap
    if (view === "front") {
      g.fillRect(-16, -7, 32, 6);                                                                         // brim
      g.fillStyle = "#fff"; g.font = "bold 9px sans-serif"; g.textAlign = "center"; g.fillText("GMT", 0, -9);
      g.fillStyle = "#2b2f33"; g.beginPath(); g.arc(-7, 7, 2.4, 0, 7); g.arc(7, 7, 2.4, 0, 7); g.fill(); // eyes
      g.strokeStyle = "#8a4b2a"; g.lineWidth = 2.4; g.beginPath(); g.arc(0, 13, 8, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke(); // smile
      g.strokeStyle = "#222"; g.lineWidth = 5; g.beginPath(); g.ellipse(0, 44, 24, 9, 0, 0, 7); g.stroke(); // wheel
      g.fillStyle = "#f1c48f"; g.beginPath(); g.arc(-18, 42, 5, 0, 7); g.arc(18, 42, 5, 0, 7); g.fill();  // hands
    } else { // profile facing +x (mirrored for the other side)
      g.fillRect(4, -7, 26, 6);                                                                           // brim forward
      g.fillStyle = "#2b2f33"; g.beginPath(); g.arc(10, 6, 2.4, 0, 7); g.fill();                          // eye
      g.strokeStyle = "#8a4b2a"; g.lineWidth = 2.4; g.beginPath(); g.arc(11, 13, 6, 0.1 * Math.PI, 0.6 * Math.PI); g.stroke(); // smile
      g.fillStyle = "#f1c48f"; g.beginPath(); g.arc(19, 9, 4, 0, 7); g.fill();                             // nose
      g.strokeStyle = "#222"; g.lineWidth = 5; g.beginPath(); g.ellipse(30, 40, 7, 16, 0.3, 0, 7); g.stroke(); // wheel ahead of him
      g.strokeStyle = "#3b6fb6"; g.lineWidth = 7; g.beginPath(); g.moveTo(6, 34); g.lineTo(26, 38); g.stroke(); // arm reaching forward
      g.fillStyle = "#f1c48f"; g.beginPath(); g.arc(28, 37, 5, 0, 7); g.fill();                            // hand on the wheel
    }
    g.restore();
  }
  function sign(g, x, y, w, h, text) { // amber LED destination sign
    g.fillStyle = "#0d0f11"; g.fillRect(x, y, w, h);
    g.fillStyle = AMBER; g.font = `bold ${Math.round(h * 0.62)}px "Courier New", monospace`; g.textAlign = "center"; g.textBaseline = "middle";
    let t = text.toUpperCase(); while (g.measureText(t).width > w - 10 && t.length > 3) t = t.slice(0, -1);
    g.fillText(t, x + w / 2, y + h / 2 + 1);
  }
  function mountains(g, x0, y0, w, h, flip) { // GMT's green-mountain band
    g.fillStyle = "#8fb3d9"; g.fillRect(x0, y0, w, h);
    const peaks = (col, base, amp, n, ph) => {
      g.fillStyle = col; g.beginPath(); g.moveTo(x0, y0 + h);
      for (let i = 0; i <= n; i++) { const t = i / n, x = x0 + (flip ? 1 - t : t) * w, y = y0 + base - amp * Math.abs(Math.sin(t * Math.PI * n * 0.5 + ph)); g.lineTo(x, y); }
      g.lineTo(flip ? x0 : x0 + w, y0 + h); g.closePath(); g.fill();
    };
    peaks(TEAL, h * 0.55, h * 0.45, 9, 0.6); peaks(GREEN, h * 0.85, h * 0.4, 7, 1.7);
  }
  function side(g, [x0, y0, w, h], frontOnRight, o, logo) {
    const fx = (f) => (frontOnRight ? x0 + f * w : x0 + (1 - f) * w); // f: 0 = rear, 1 = front
    g.fillStyle = SKY; g.fillRect(x0, y0, w, h);
    mountains(g, x0, y0 + h * 0.56, w, h * 0.27, !frontOnRight);
    g.fillStyle = CHARCOAL; g.fillRect(x0, y0 + h * 0.83, w, h * 0.17);                                 // skirt
    g.fillStyle = o.color; g.fillRect(x0, y0 + h * 0.535, w, h * 0.025);                                // route-color stripe
    g.fillStyle = GLASS; g.fillRect(x0 + w * 0.015, y0 + h * 0.12, w * 0.97, h * 0.4);                   // windows
    g.fillStyle = "rgba(255,255,255,0.09)";
    for (let i = 0; i < 14; i++) { const a = x0 + (i / 14) * w; g.beginPath(); g.moveTo(a, y0 + h * 0.12); g.lineTo(a + w * 0.04, y0 + h * 0.12); g.lineTo(a + w * 0.01, y0 + h * 0.52); g.lineTo(a - w * 0.03, y0 + h * 0.52); g.fill(); }
    g.fillStyle = "#2a3138"; for (let i = 1; i < 8; i++) g.fillRect(fx(i / 8) - 3, y0 + h * 0.12, 6, h * 0.4); // pillars
    if (frontOnRight) { // passenger side: front door
      g.fillStyle = "#cfd8de"; g.fillRect(fx(0.9) - w * 0.035, y0 + h * 0.1, w * 0.07, h * 0.73);
      g.fillStyle = GLASS; g.fillRect(fx(0.9) - w * 0.03, y0 + h * 0.13, w * 0.027, h * 0.65); g.fillRect(fx(0.9) + w * 0.003, y0 + h * 0.13, w * 0.027, h * 0.65);
    } else drawDriver(g, fx(0.935), y0 + h * 0.3, h / 210, "side", frontOnRight ? 1 : -1); // driver's window, facing the front
    sign(g, fx(0.84) - w * 0.06, y0 + h * 0.025, w * 0.12, h * 0.075, `${o.short} ${o.headsign}`);
    const wl = whiteLogo(logo);
    if (wl) { const lh = h * 0.13, lw = lh * (wl.width / wl.height); g.drawImage(wl, fx(frontOnRight ? 0.76 : 0.82) - lw / 2, y0 + h * 0.64, lw, lh); }
    g.fillStyle = "#111"; for (const f of [0.2, 0.82]) { g.beginPath(); g.arc(fx(f), y0 + h, h * 0.2, Math.PI, 0); g.fill(); } // wheel arches
  }
  async function busTexture(o) {
    const logo = await loadLogo();
    const c = document.createElement("canvas"); c.width = c.height = 1024;
    const g = c.getContext("2d");
    g.fillStyle = SKY; g.fillRect(0, 0, 1024, 1024);
    side(g, R.right, true, o, logo); side(g, R.left, false, o, logo);
    { // front: sign, black-framed windshield with the driver on the bus's LEFT (the viewer's right), lights, bumper
      const [x, y, w, h] = R.front;
      g.fillStyle = SKY; g.fillRect(x, y, w, h);
      g.fillStyle = "#1a1d21"; g.fillRect(x + w * 0.03, y + h * 0.02, w * 0.94, h * 0.64);
      sign(g, x + w * 0.1, y + h * 0.05, w * 0.8, h * 0.11, `${o.short} ${o.headsign}`);
      g.fillStyle = GLASS; g.fillRect(x + w * 0.07, y + h * 0.19, w * 0.86, h * 0.44);
      drawDriver(g, x + w * 0.7, y + h * 0.37, h / 230, "front");
      g.fillStyle = "rgba(255,255,255,0.12)"; g.beginPath(); g.moveTo(x + w * 0.2, y + h * 0.19); g.lineTo(x + w * 0.38, y + h * 0.19); g.lineTo(x + w * 0.28, y + h * 0.63); g.lineTo(x + w * 0.12, y + h * 0.63); g.fill();
      mountains(g, x, y + h * 0.66, w, h * 0.12, false);
      g.fillStyle = CHARCOAL; g.fillRect(x, y + h * 0.78, w, h * 0.22);                                    // bumper
      g.fillStyle = "#fff8d8"; for (const f of [0.08, 0.8]) g.fillRect(x + w * f, y + h * 0.8, w * 0.12, h * 0.06); // headlights
      g.fillStyle = "#ff8a1f"; for (const f of [0.22, 0.7]) g.fillRect(x + w * f, y + h * 0.81, w * 0.07, h * 0.04); // amber markers
      const wl = whiteLogo(logo); if (wl) { const lw = w * 0.26, lh = lw * (wl.height / wl.width); g.drawImage(wl, x + (w - lw) / 2, y + h * 0.89, lw, lh); }
    }
    { // back
      const [x, y, w, h] = R.back;
      g.fillStyle = SKY; g.fillRect(x, y, w, h);
      g.fillStyle = GLASS; g.fillRect(x + w * 0.12, y + h * 0.14, w * 0.76, h * 0.3);
      mountains(g, x, y + h * 0.56, w, h * 0.22, false);
      const wl = whiteLogo(logo); if (wl) { const lw = w * 0.5, lh = lw * (wl.height / wl.width); g.drawImage(wl, x + (w - lw) / 2, y + h * 0.6, lw, lh); }
      g.fillStyle = "#d32f2f"; for (const f of [0.05, 0.85]) g.fillRect(x + w * f, y + h * 0.48, w * 0.1, h * 0.16);
      g.fillStyle = CHARCOAL; g.fillRect(x, y + h * 0.8, w, h * 0.2);
      sign(g, x + w * 0.35, y + h * 0.03, w * 0.3, h * 0.08, o.short);
    }
    { // roof
      const [x, y, w, h] = R.roof;
      g.fillStyle = SKY_LIGHT; g.fillRect(x, y, w, h);
      g.fillStyle = o.color; g.fillRect(x, y + h * 0.46, w, h * 0.08);
      g.fillStyle = "#b4c3cf"; g.fillRect(x + w * 0.55, y + h * 0.2, w * 0.25, h * 0.6); g.fillRect(x + w * 0.15, y + h * 0.28, w * 0.12, h * 0.44);
    }
    return c;
  }

  // ---------- stop sign texture: GMT's sign (arched top, white bus, BUS STOP, green hills) ----------
  async function signTexture() {
    const logo = await loadLogo();
    const c = document.createElement("canvas"); c.width = 512; c.height = 1024;
    const g = c.getContext("2d"), w = 512, h = 840, top = 92; // the sign occupies the top 840 px; the rest is pole color
    g.clearRect(0, 0, 512, 1024);
    g.beginPath(); g.moveTo(0, top + 140); g.quadraticCurveTo(0, top, 140, top); g.lineTo(w - 140, top); g.quadraticCurveTo(w, top, w, top + 140);
    g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = "#a8cdee"; g.fill(); g.save(); g.clip();
    // white bus front
    g.fillStyle = "#fff"; g.beginPath(); g.roundRect(146, top + 40, 220, 250, 34); g.fill();
    g.fillStyle = "#a8cdee"; g.beginPath(); g.roundRect(170, top + 80, 172, 92, 10); g.fill();
    g.beginPath(); g.arc(192, top + 220, 16, 0, 7); g.arc(320, top + 220, 16, 0, 7); g.fill();
    g.fillStyle = "#fff"; g.fillRect(176, top + 290, 36, 36); g.fillRect(300, top + 290, 36, 36);
    g.fillStyle = "#fff"; g.font = "bold 92px Helvetica, Arial, sans-serif"; g.textAlign = "center"; g.fillText("BUS STOP", w / 2, top + 448);
    g.fillStyle = "#3f4a52"; g.font = "30px Helvetica, Arial, sans-serif"; g.fillText("Green Mountain Transit", w / 2, top + 500);
    // green hills
    g.fillStyle = "#9fd36a"; g.beginPath(); g.moveTo(0, top + 560); g.quadraticCurveTo(110, top + 520, 200, top + 548); g.quadraticCurveTo(330, top + 510, 512, top + 552); g.lineTo(512, h); g.lineTo(0, h); g.fill();
    g.fillStyle = "#7ac143"; g.fillRect(0, top + 580, 512, h - top - 580);
    if (logo) { const lw = 190, lh = lw * (logo.height / logo.width); g.drawImage(logo, 22, top + 620, lw, lh); }
    g.fillStyle = "#1f2a1f"; g.font = "bold 34px Helvetica, Arial, sans-serif"; g.textAlign = "right"; g.fillText("RideGMT.com", w - 24, top + 650); g.fillText("802-540-2468", w - 24, top + 694);
    g.restore();
    g.fillStyle = "#9aa3aa"; g.fillRect(0, 880, 512, 144); // pole color strip
    return c;
  }

  // ---------- geometry helpers ----------
  function mesh() {
    const m = { pos: [], nrm: [], uv: [], idx: [] };
    m.quad = (P, N, [u0, v0, u1, v1]) => { // corners: bottom-left, bottom-right, top-right, top-left (seen from outside)
      const b = m.pos.length / 3;
      P.forEach((p) => { m.pos.push(...p); m.nrm.push(...N); });
      m.uv.push(u0, v1, u1, v1, u1, v0, u0, v0);
      m.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    m.cylinder = (cx, cy0, cy1, cz, r, n, uvAt, horizontal) => { // vertical (y) cylinder, or horizontal along z for wheels
      const b = m.pos.length / 3;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2, ca = Math.cos(a) * r, sa = Math.sin(a) * r;
        if (horizontal) { m.pos.push(cx + ca, cy0 + sa, cz - horizontal, cx + ca, cy0 + sa, cz + horizontal); m.nrm.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 0); }
        else { m.pos.push(cx + ca, cy0, cz + sa, cx + ca, cy1, cz + sa); m.nrm.push(Math.cos(a), 0, Math.sin(a), Math.cos(a), 0, Math.sin(a)); }
        m.uv.push(...uvAt, ...uvAt);
      }
      for (let i = 0; i < n; i++) { const p = b + i * 2; m.idx.push(p, p + 2, p + 1, p + 1, p + 2, p + 3); }
      if (horizontal) for (const s of [-1, 1]) { // wheel faces
        const c0 = m.pos.length / 3; m.pos.push(cx, cy0, cz + s * horizontal); m.nrm.push(0, 0, s); m.uv.push(...uvAt);
        for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI * 2; m.pos.push(cx + Math.cos(a) * r, cy0 + Math.sin(a) * r, cz + s * horizontal); m.nrm.push(0, 0, s); m.uv.push(...uvAt); }
        for (let i = 0; i < n; i++) s > 0 ? m.idx.push(c0, c0 + 1 + i, c0 + 2 + i) : m.idx.push(c0, c0 + 2 + i, c0 + 1 + i);
      }
    };
    return m;
  }
  const rect = (r, size = 1024) => [r[0] / size, r[1] / size, (r[0] + r[2]) / size, (r[1] + r[3]) / size];

  // ---------- pack meshes + one texture into a binary glTF (GLB) ----------
  async function packGLB(canvas, prims, materials) {
    const png = new Uint8Array(await (await new Promise((res) => canvas.toBlob(res, "image/png"))).arrayBuffer());
    const parts = [], views = [], accessors = []; let offset = 0;
    const add = (typed, target) => {
      const pad = (4 - (offset % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); offset += pad; }
      const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) }); parts.push(bytes); offset += bytes.byteLength; return views.length - 1;
    };
    const acc = (arr, type, comp, target, minmax) => {
      const typed = comp === 5126 ? new Float32Array(arr) : new Uint16Array(arr);
      const a = { bufferView: add(typed, target), componentType: comp, count: arr.length / ({ VEC3: 3, VEC2: 2, SCALAR: 1 })[type], type };
      if (minmax) { const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity]; for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]); } a.min = mn; a.max = mx; }
      accessors.push(a); return accessors.length - 1;
    };
    const primitives = prims.map((p) => ({ attributes: { POSITION: acc(p.m.pos, "VEC3", 5126, 34962, true), NORMAL: acc(p.m.nrm, "VEC3", 5126, 34962), TEXCOORD_0: acc(p.m.uv, "VEC2", 5126, 34962) },
      indices: acc(p.m.idx, "SCALAR", 5123, 34963), material: p.material }));
    const imgView = add(png);
    const json = { asset: { version: "2.0", generator: "GMT system map" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives }],
      materials, textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987 }], images: [{ bufferView: imgView, mimeType: "image/png" }],
      accessors, bufferViews: views, buffers: [{ byteLength: 0 }] };
    const pad4 = (n) => (n + 3) & ~3, binLen = pad4(offset); json.buffers[0].byteLength = binLen;
    const jsonBytes = new TextEncoder().encode(JSON.stringify(json)), jsonLen = pad4(jsonBytes.length);
    const out = new Uint8Array(28 + jsonLen + binLen), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
    const b0 = 20 + jsonLen; dv.setUint32(b0, binLen, true); dv.setUint32(b0 + 4, 0x004e4942, true);
    let p = b0 + 8; for (const part of parts) { out.set(part, p); p += part.byteLength; }
    return URL.createObjectURL(new Blob([out], { type: "model/gltf-binary" }));
  }
  const textured = { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.55 } };

  // ---------- the bus ----------
  // glTF is Y-up. Length runs along X with the front at +X; +Z is the right (passenger) side.
  async function build(o) {
    const canvas = await busTexture(o), body = mesh(), wheels = mesh();
    const x0 = -L / 2, x1 = L / 2, y0 = LIFT, y1 = LIFT + H, z0 = -W / 2, z1 = W / 2;
    body.quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], rect(R.right));
    body.quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], rect(R.left));
    body.quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], rect(R.front));
    body.quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], rect(R.back));
    body.quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], rect(R.roof));
    body.quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], rect(R.roof));
    for (const ax of [L * 0.32, -L * 0.3]) for (const s of [-1, 1]) wheels.cylinder(ax, 0.5, 0, s * (W / 2 - 0.18), 0.5, 14, [0, 0], 0.16);
    return packGLB(canvas, [{ m: body, material: 0 }, { m: wheels, material: 1 }],
      [textured, { pbrMetallicRoughness: { baseColorFactor: [0.06, 0.07, 0.08, 1], metallicFactor: 0, roughnessFactor: 0.9 } }]);
  }

  // ---------- the stop sign: a pole and GMT's sign (same face on both sides) ----------
  const SIGN_W = 0.46, SIGN_H = 0.76, SIGN_TOP = 2.55, POLE_H = 2.7;
  async function buildStopSign() {
    const canvas = await signTexture(), face = mesh(), pole = mesh();
    const d = 0.012, x0 = -SIGN_W / 2, x1 = SIGN_W / 2, yb = SIGN_TOP - SIGN_H, yt = SIGN_TOP + (SIGN_H * 92) / 748; // texture's sign area spans 92..840 px
    const uvFace = [0, 0, 1, 840 / 1024];
    face.quad([[x0, yb, d], [x1, yb, d], [x1, yt, d], [x0, yt, d]], [0, 0, 1], uvFace);   // front (faces +Z)
    face.quad([[x1, yb, -d], [x0, yb, -d], [x0, yt, -d], [x1, yt, -d]], [0, 0, -1], uvFace); // back
    pole.cylinder(0, 0, POLE_H, -0.05, 0.035, 10, [0.5, 950 / 1024]);
    return packGLB(canvas, [{ m: face, material: 0 }, { m: pole, material: 1 }],
      [{ ...textured, alphaMode: "MASK", alphaCutoff: 0.5, doubleSided: false }, { ...textured }]);
  }

  globalThis.GMTBus3D = { build, buildStopSign, LENGTH_M: L };
})();
