// GMT 3D bus for "follow a bus" in 3D view.
//
//   const url = await GMTBus3D.build({ color: "#f4432e", short: "1", headsign: "Williston" });
//   map.addModel("gmt-bus", url);
//
// Builds a small glTF model in the browser: a 40-ft bus body painted with a texture (GMT livery, the GMT logo,
// windows, door, destination sign and a cartoon driver), plus wheels and roof units. Sizes are real-world
// meters; the map scales it up so it reads at street zoom.
(function () {
  const L = 12.2, W = 2.6, H = 2.95, LIFT = 0.42; // length, width, body height, height of the body above the road
  const GREEN = "#7dc242", CHARCOAL = "#2b2f33", WHITE = "#f7f8f6", GLASS = "#1d2a33";
  let logoImg = null;
  const loadLogo = () => logoImg ?? (logoImg = new Promise((res) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = "assets/gmt-logo.png";
  }));

  // ---------- texture: one 1024x1024 image holding every face ----------
  // regions: right side, left side, front, back, roof (x, y, w, h in pixels)
  const R = { right: [0, 0, 1024, 248], left: [0, 256, 1024, 248], front: [0, 512, 224, 248], back: [256, 512, 224, 248], roof: [512, 512, 512, 110] };

  function drawDriver(g, cx, cy, s, facing) { // a friendly driver: green GMT cap, smile, hands on the wheel
    g.save(); g.translate(cx, cy); g.scale(s, s);
    g.fillStyle = "#3b6fb6"; g.beginPath(); g.ellipse(0, 46, 34, 22, 0, Math.PI, 0); g.fill();          // shirt
    g.fillStyle = "#f1c48f"; g.beginPath(); g.arc(0, 8, 21, 0, 7); g.fill();                         // face
    g.fillStyle = GREEN; g.beginPath(); g.ellipse(0, -6, 23, 13, 0, Math.PI, 0); g.fill();           // cap
    g.fillRect(facing === "front" ? -16 : 0, -7, facing === "front" ? 32 : 30, 6);                    // brim
    g.fillStyle = "#fff"; g.font = "bold 9px sans-serif"; g.textAlign = "center"; g.fillText("GMT", 0, -9);
    g.fillStyle = "#2b2f33";
    if (facing === "front") { g.beginPath(); g.arc(-7, 7, 2.4, 0, 7); g.arc(7, 7, 2.4, 0, 7); g.fill(); }
    else { g.beginPath(); g.arc(8, 7, 2.4, 0, 7); g.fill(); }
    g.strokeStyle = "#8a4b2a"; g.lineWidth = 2.4; g.beginPath();
    if (facing === "front") g.arc(0, 13, 8, 0.15 * Math.PI, 0.85 * Math.PI); else g.arc(7, 13, 7, 0.1 * Math.PI, 0.7 * Math.PI);
    g.stroke();
    g.strokeStyle = "#222"; g.lineWidth = 5; g.beginPath(); g.ellipse(facing === "front" ? 0 : 18, 44, 24, 9, 0, 0, 7); g.stroke(); // wheel
    g.fillStyle = "#f1c48f"; g.beginPath(); g.arc(facing === "front" ? -18 : 6, 42, 5, 0, 7); g.arc(facing === "front" ? 18 : 30, 42, 5, 0, 7); g.fill(); // hands
    g.restore();
  }
  function sign(g, x, y, w, h, text) { // amber LED destination sign
    g.fillStyle = "#111"; g.fillRect(x, y, w, h);
    g.fillStyle = "#ffb43c"; g.font = `bold ${Math.round(h * 0.62)}px "Courier New", monospace`; g.textAlign = "center"; g.textBaseline = "middle";
    let t = text.toUpperCase(); while (g.measureText(t).width > w - 10 && t.length > 3) t = t.slice(0, -1);
    g.fillText(t, x + w / 2, y + h / 2 + 1);
  }
  function side(g, [x0, y0, w, h], frontOnRight, o, logo) {
    const fx = (f) => (frontOnRight ? x0 + f * w : x0 + (1 - f) * w); // f: 0 = rear, 1 = front
    g.fillStyle = WHITE; g.fillRect(x0, y0, w, h);
    g.fillStyle = CHARCOAL; g.fillRect(x0, y0 + h * 0.8, w, h * 0.2);                                // skirt
    g.fillStyle = GREEN; g.beginPath();                                                               // green swoosh
    g.moveTo(fx(0), y0 + h * 0.7); g.lineTo(fx(0.55), y0 + h * 0.78); g.lineTo(fx(1), y0 + h * 0.765);
    g.lineTo(fx(1), y0 + h * 0.8); g.lineTo(fx(0), y0 + h * 0.8); g.closePath(); g.fill();
    g.fillStyle = o.color; g.fillRect(x0, y0 + h * 0.555, w, h * 0.03);                              // route-color stripe
    g.fillStyle = GLASS; g.fillRect(x0 + w * 0.015, y0 + h * 0.12, w * 0.97, h * 0.4);               // window band
    g.fillStyle = "rgba(255,255,255,0.10)";
    for (let i = 0; i < 14; i++) { const a = x0 + (i / 14) * w; g.beginPath(); g.moveTo(a, y0 + h * 0.12); g.lineTo(a + w * 0.04, y0 + h * 0.12); g.lineTo(a + w * 0.01, y0 + h * 0.52); g.lineTo(a - w * 0.03, y0 + h * 0.52); g.fill(); } // reflections
    g.fillStyle = WHITE; for (let i = 1; i < 8; i++) g.fillRect(fx(i / 8) - 3, y0 + h * 0.12, 6, h * 0.4);   // pillars
    if (frontOnRight) { // passenger side: front door with glass panels
      g.fillStyle = "#cfd6d3"; g.fillRect(fx(0.9) - w * 0.035, y0 + h * 0.1, w * 0.07, h * 0.7);
      g.fillStyle = GLASS; g.fillRect(fx(0.9) - w * 0.03, y0 + h * 0.13, w * 0.027, h * 0.62); g.fillRect(fx(0.9) + w * 0.003, y0 + h * 0.13, w * 0.027, h * 0.62);
    } else drawDriver(g, fx(0.93), y0 + h * 0.3, h / 210, "side"); // driver's side window
    sign(g, fx(0.86) - w * 0.06, y0 + h * 0.025, w * 0.12, h * 0.075, `${o.short} ${o.headsign}`);   // side sign
    if (logo) { const lh = h * 0.17, lw = lh * (logo.width / logo.height); g.drawImage(logo, fx(0.42) - lw / 2, y0 + h * 0.595, lw, lh); }
    g.fillStyle = "#111"; for (const f of [0.2, 0.82]) { g.beginPath(); g.arc(fx(f), y0 + h, h * 0.2, Math.PI, 0); g.fill(); } // wheel arches
  }
  async function texture(o) {
    const logo = await loadLogo();
    const c = document.createElement("canvas"); c.width = c.height = 1024;
    const g = c.getContext("2d");
    g.fillStyle = WHITE; g.fillRect(0, 0, 1024, 1024);
    side(g, R.right, true, o, logo); side(g, R.left, false, o, logo);
    { // front: destination sign, windshield with the driver, headlights, bumper
      const [x, y, w, h] = R.front;
      g.fillStyle = WHITE; g.fillRect(x, y, w, h);
      sign(g, x + w * 0.08, y + h * 0.04, w * 0.84, h * 0.12, `${o.short} ${o.headsign}`);
      g.fillStyle = GLASS; g.fillRect(x + w * 0.05, y + h * 0.18, w * 0.9, h * 0.44);
      drawDriver(g, x + w * 0.3, y + h * 0.36, h / 230, "front");
      g.fillStyle = "rgba(255,255,255,0.12)"; g.beginPath(); g.moveTo(x + w * 0.55, y + h * 0.18); g.lineTo(x + w * 0.75, y + h * 0.18); g.lineTo(x + w * 0.6, y + h * 0.62); g.lineTo(x + w * 0.42, y + h * 0.62); g.fill();
      g.fillStyle = GREEN; g.fillRect(x, y + h * 0.66, w, h * 0.05);
      g.fillStyle = "#fff6c8"; for (const fx of [0.12, 0.76]) g.fillRect(x + w * fx, y + h * 0.74, w * 0.12, h * 0.06);
      g.fillStyle = CHARCOAL; g.fillRect(x, y + h * 0.84, w, h * 0.16);
      g.fillStyle = CHARCOAL; g.font = `bold ${Math.round(h * 0.07)}px sans-serif`; g.textAlign = "center"; g.fillText("GMT", x + w / 2, y + h * 0.79);
    }
    { // back: rear window, tail lights, logo, route number
      const [x, y, w, h] = R.back;
      g.fillStyle = WHITE; g.fillRect(x, y, w, h);
      g.fillStyle = GLASS; g.fillRect(x + w * 0.12, y + h * 0.14, w * 0.76, h * 0.26);
      if (logo) { const lw = w * 0.7, lh = lw * (logo.height / logo.width); g.drawImage(logo, x + (w - lw) / 2, y + h * 0.45, lw, lh); }
      g.fillStyle = "#d32f2f"; for (const fx of [0.05, 0.85]) g.fillRect(x + w * fx, y + h * 0.5, w * 0.1, h * 0.16);
      g.fillStyle = CHARCOAL; g.fillRect(x, y + h * 0.82, w, h * 0.18);
      sign(g, x + w * 0.35, y + h * 0.03, w * 0.3, h * 0.08, o.short);
    }
    { // roof: light gray with air-conditioning units and a route-color stripe
      const [x, y, w, h] = R.roof;
      g.fillStyle = "#e3e7e5"; g.fillRect(x, y, w, h);
      g.fillStyle = o.color; g.fillRect(x, y + h * 0.46, w, h * 0.08);
      g.fillStyle = "#c4cbc8"; g.fillRect(x + w * 0.55, y + h * 0.2, w * 0.25, h * 0.6); g.fillRect(x + w * 0.15, y + h * 0.28, w * 0.12, h * 0.44);
    }
    return c;
  }

  // ---------- geometry ----------
  // glTF is Y-up. The bus's length runs along X with the front at +X; +Z is its right (passenger) side.
  function buildMesh() {
    const pos = [], nrm = [], uv = [], idx = [], wpos = [], wnrm = [], widx = [];
    const uvRect = ([x, y, w, h]) => [x / 1024, y / 1024, (x + w) / 1024, (y + h) / 1024];
    const quad = (P, N, [u0, v0, u1, v1], flipU) => { // P: 4 corners (bottom-left, bottom-right, top-right, top-left as seen from outside)
      const b = pos.length / 3;
      P.forEach((p) => { pos.push(...p); nrm.push(...N); });
      const us = flipU ? [u1, u0, u0, u1] : [u0, u1, u1, u0];
      uv.push(us[0], v1, us[1], v1, us[2], v0, us[3], v0);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    };
    const x0 = -L / 2, x1 = L / 2, y0 = LIFT, y1 = LIFT + H, z0 = -W / 2, z1 = W / 2;
    quad([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], uvRect(R.right));        // right side (front on the right)
    quad([[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1], uvRect(R.left));       // left side (front on the left)
    quad([[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0], uvRect(R.front));       // front
    quad([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], uvRect(R.back));       // back
    quad([[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0], uvRect(R.roof));        // roof
    quad([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0], uvRect(R.roof));       // underside
    // wheels: 12-sided cylinders across the bus, at the front and rear axles
    const wheel = (cx, cz, r, wd) => {
      const n = 12, b = wpos.length / 3;
      for (const side of [-1, 1]) for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2; wpos.push(cx + Math.cos(a) * r, r + Math.sin(a) * r, cz + side * wd / 2); wnrm.push(Math.cos(a), Math.sin(a), 0);
      }
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; widx.push(b + i, b + j, b + n + j, b + i, b + n + j, b + n + i); }
      for (const [off, s] of [[0, -1], [n, 1]]) { const cIdx = wpos.length / 3; wpos.push(cx, r, cz + s * wd / 2); wnrm.push(0, 0, s);
        for (let i = 0; i < n; i++) { const j = (i + 1) % n; s > 0 ? widx.push(cIdx, b + off + i, b + off + j) : widx.push(cIdx, b + off + j, b + off + i); } }
    };
    for (const ax of [L * 0.32, -L * 0.3]) for (const s of [-1, 1]) wheel(ax, s * (W / 2 - 0.18), 0.5, 0.32);
    return { body: { pos, nrm, uv, idx }, wheels: { pos: wpos, nrm: wnrm, idx: widx } };
  }

  // ---------- pack everything into a binary glTF (GLB) ----------
  async function build(o) {
    const canvas = await texture(o);
    const png = new Uint8Array(await (await new Promise((res) => canvas.toBlob(res, "image/png"))).arrayBuffer());
    const { body, wheels } = buildMesh();
    const parts = [], views = [], accessors = [];
    let offset = 0;
    const add = (typed, target) => {
      const pad = (4 - (offset % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); offset += pad; }
      const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
      views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
      parts.push(bytes); offset += bytes.byteLength; return views.length - 1;
    };
    const acc = (arr, type, comp, target, minmax) => {
      const typed = comp === 5126 ? new Float32Array(arr) : new Uint16Array(arr);
      const a = { bufferView: add(typed, target), componentType: comp, count: arr.length / ({ VEC3: 3, VEC2: 2, SCALAR: 1 })[type], type };
      if (minmax) { const n = 3, mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < arr.length; i += n) for (let k = 0; k < n; k++) { mn[k] = Math.min(mn[k], arr[i + k]); mx[k] = Math.max(mx[k], arr[i + k]); }
        a.min = mn; a.max = mx; }
      accessors.push(a); return accessors.length - 1;
    };
    const bP = acc(body.pos, "VEC3", 5126, 34962, true), bN = acc(body.nrm, "VEC3", 5126, 34962), bT = acc(body.uv, "VEC2", 5126, 34962), bI = acc(body.idx, "SCALAR", 5123, 34963);
    const wP = acc(wheels.pos, "VEC3", 5126, 34962, true), wN = acc(wheels.nrm, "VEC3", 5126, 34962), wI = acc(wheels.idx, "SCALAR", 5123, 34963);
    const imgView = add(png);
    const json = {
      asset: { version: "2.0", generator: "GMT system map" },
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [
        { attributes: { POSITION: bP, NORMAL: bN, TEXCOORD_0: bT }, indices: bI, material: 0 },
        { attributes: { POSITION: wP, NORMAL: wN }, indices: wI, material: 1 },
      ] }],
      materials: [
        { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 0.55 } },
        { pbrMetallicRoughness: { baseColorFactor: [0.06, 0.07, 0.08, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
      ],
      textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9729, minFilter: 9987 }],
      images: [{ bufferView: imgView, mimeType: "image/png" }],
      accessors, bufferViews: views, buffers: [{ byteLength: 0 }],
    };
    const pad4 = (n) => (n + 3) & ~3;
    const binLen = pad4(offset); json.buffers[0].byteLength = binLen;
    let jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    const jsonLen = pad4(jsonBytes.length);
    const out = new Uint8Array(12 + 8 + jsonLen + 8 + binLen), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true); out.set(jsonBytes, 20); out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
    const b0 = 20 + jsonLen; dv.setUint32(b0, binLen, true); dv.setUint32(b0 + 4, 0x004e4942, true);
    let p = b0 + 8; for (const part of parts) { out.set(part, p); p += part.byteLength; }
    return URL.createObjectURL(new Blob([out], { type: "model/gltf-binary" }));
  }

  globalThis.GMTBus3D = { build, LENGTH_M: L };
})();
