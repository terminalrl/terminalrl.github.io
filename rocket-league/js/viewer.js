/* Terminal replay viewer: full 5-minute recorded bot games, drawn procedurally with three.js.
   No game assets: every mesh and texture is generated here. Data = compact binary timelines made by tools/npz_to_bin.py.
   World = RocketSim coordinates (x, y, z up; left-handed). Three.js is right-handed with y up, so world (x,y,z) -> three
   (x,z,y). That swap is a reflection, which un-mirrors the left-handed world: blue (team 0) attacks +y. Cars: local +X is
   forward, +Y up. */
(function () {
  'use strict';
  var THREE_URLS = ['https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js', 'https://unpkg.com/three@0.160.0/build/three.module.js'];
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), msg = $('msg'), box = $('viewerBox');
  var T, renderer, scene, camera, sun, hemi, flashLight, ballObj, ballHalo, ballBlob;
  var carObjs = [], padObjs = [], goalFx = null, particles = null, pAttr = {}, ceiling, envTex;
  var game = null, t = 0, playing = false, speed = 1, camMode = 'director', followCar = 0, lastTs = 0;
  var lowQ = false, dirty = true, visible = true, started = false, ready = false, index = [], uScale = 1000, pendingPlay = false;
  var orbit = { th: 0.0, ph: 0.5, r: 8800, vth: 0, vph: 0 };
  var camPos = null, camTgt = null, camSnap = true, dirSm = null;
  var MAXP = 1600, np = 0;
  var W = 4096, L = 5120, CH = 1152, H = 2044, GW = 893, GH = 642.775, GD = 880;
  var BLUE = 0x2a86ff, ORG = 0xff8a1f;

  function fail(m) { msg.hidden = false; msg.classList.add('err'); msg.innerHTML = ''; var p = document.createElement('p'); p.textContent = m; msg.appendChild(p); }
  function info(m) { msg.hidden = false; msg.classList.remove('err'); msg.textContent = m; }
  function withTimeout(p, ms, what) { return Promise.race([p, new Promise(function (_, rj) { setTimeout(function () { rj(new Error(what + ' timed out')); }, ms); })]); }
  function importFirst(urls, i) {
    i = i || 0; if (i >= urls.length) return Promise.reject(new Error('could not load three.js from a CDN'));
    return withTimeout(import(urls[i]), 25000, 'three.js').catch(function () { return importFirst(urls, i + 1); });
  }

  /* ---------- start: never depends on one trigger ---------- */
  function start() {
    if (started) return; started = true;
    info('Loading 3-D engine…');
    var idxP = fetch('data/index.json').then(function (r) { if (!r.ok) throw new Error('data/index.json: HTTP ' + r.status); return r.json(); });
    importFirst(THREE_URLS).then(function (mod) { T = mod; return idxP; }).then(function (j) {
      index = j; init(); return loadGame(0);
    }).catch(function (e) {
      started = false; console.error(e);
      fail('The 3-D viewer could not start (' + (e && e.message || e) + '). The clips below still work. Click here to retry.');
      msg.onclick = function () { msg.onclick = null; start(); };
    });
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (e) { visible = e[0].isIntersecting; if (visible) { dirty = true; start(); } }, { rootMargin: '600px' }).observe(stage);
  }
  window.addEventListener('load', function () { setTimeout(start, 1200); });   // fallback if the observer never fires
  $('bigplay').addEventListener('click', function () { start(); if (ready) togglePlay(); else pendingPlay = true; });

  function P(x, y, z) { return new T.Vector3(x, z, y); } // world -> three

  /* ---------- procedural textures ---------- */
  function canvasTex(w, h, draw, opts) {
    var c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
    var tx = new T.CanvasTexture(c); tx.colorSpace = T.SRGBColorSpace; opts = opts || {};
    if (opts.repeat) { tx.wrapS = tx.wrapT = T.RepeatWrapping; }
    tx.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); return tx;
  }
  function rnd(seed) { var s = seed >>> 0; return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function grassTex() {
    var PW = 2048, PH = 2560;
    return canvasTex(PW, PH, function (g) {
      var r = rnd(7), n = 14, sh = PH / n;
      for (var i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#2c7a36' : '#348a3e'; g.fillRect(0, i * sh, PW, sh + 1); }
      for (var k = 0; k < 60000; k++) { g.fillStyle = 'rgba(' + (r() < 0.5 ? '20,70,30' : '90,170,90') + ',' + (0.03 + r() * 0.05) + ')'; g.fillRect(r() * PW, r() * PH, 2 + r() * 3, 3 + r() * 6); }
      var sx = PW / (2 * W), sy = PH / (2 * L), X = function (x) { return (x + W) * sx; }, Y = function (y) { return (L - y) * sy; };
      g.strokeStyle = 'rgba(255,255,255,.88)'; g.lineWidth = 7; g.lineCap = 'round';
      g.strokeRect(X(-W + 90), Y(L - 90), 2 * (W - 90) * sx, 2 * (L - 90) * sy);          // touch lines
      g.beginPath(); g.moveTo(X(-W + 90), Y(0)); g.lineTo(X(W - 90), Y(0)); g.stroke();   // centre line
      g.beginPath(); g.arc(X(0), Y(0), 1000 * sx, 0, 7); g.stroke();                     // centre circle
      g.fillStyle = '#fff'; g.beginPath(); g.arc(X(0), Y(0), 14, 0, 7); g.fill();
      [-1, 1].forEach(function (s) {                                                      // goal boxes
        g.strokeRect(X(-1900), Math.min(Y(s * (L - 90)), Y(s * (L - 1790))), 3800 * sx, 1700 * sy);
        g.strokeRect(X(-900), Math.min(Y(s * (L - 90)), Y(s * (L - 790))), 1800 * sx, 700 * sy);
      });
    });
  }
  function hexTex(rgb, a1, a2) {
    return canvasTex(256, 256, function (g, w, h) {
      g.fillStyle = 'rgba(' + rgb + ',' + a1 + ')'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(' + rgb + ',' + a2 + ')'; g.lineWidth = 2.5;
      var r = 32, dx = r * 1.5, dy = r * Math.sqrt(3);
      for (var cx = 0, col = 0; cx < w + r; cx += dx, col++) for (var cy = (col % 2 ? dy / 2 : 0); cy < h + dy; cy += dy) {
        g.beginPath(); for (var k = 0; k < 6; k++) { var an = k * Math.PI / 3; g.lineTo(cx + r * Math.cos(an), cy + r * Math.sin(an)); } g.closePath(); g.stroke();
      }
    }, { repeat: true });
  }
  function crowdTex() {
    return canvasTex(256, 128, function (g, w, h) {
      var r = rnd(11); g.fillStyle = '#1b2230'; g.fillRect(0, 0, w, h);
      var cols = ['#c9d3e6', '#5a7bb0', '#d86a4a', '#e6c458', '#4a4f66', '#8fb3d9', '#b85c8a', '#7a8aa0'];
      for (var y = 4; y < h; y += 8) { g.globalAlpha = 1; g.fillStyle = 'rgba(0,0,0,.35)'; g.fillRect(0, y + 5, w, 3); for (var x = 2; x < w; x += 6) { g.fillStyle = cols[(r() * cols.length) | 0]; g.globalAlpha = 0.5 + r() * 0.25; g.fillRect(x, y, 5, 6); } }
      g.globalAlpha = 1;
    }, { repeat: true });
  }
  function boardTex() {
    return canvasTex(1024, 64, function (g, w, h) {
      g.fillStyle = '#0a0f1a'; g.fillRect(0, 0, w, h); g.font = 'bold 40px system-ui,sans-serif'; g.textBaseline = 'middle';
      for (var i = 0; i < 4; i++) { g.fillStyle = i % 2 ? '#ff8a1f' : '#2a86ff'; g.fillText('TERMINAL', 20 + i * 256, h / 2); g.fillStyle = '#dfe8ff'; g.fillRect(i * 256 + 220, 20, 6, 24); }
    }, { repeat: true });
  }
  function glowTex() {
    return canvasTex(128, 128, function (g, w) { var gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, w); });
  }
  function ballTex() {
    return canvasTex(512, 256, function (g, w, h) {
      g.fillStyle = '#f2f5fa'; g.fillRect(0, 0, w, h);
      var phi = (1 + Math.sqrt(5)) / 2, v = [];
      [[0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi]].forEach(function (a) { v.push(a, [a[1], a[2], a[0]], [a[2], a[0], a[1]]); });
      function patch(d, rad, col, n) {
        var l = Math.hypot(d[0], d[1], d[2]), lat = Math.asin(d[1] / l), lon = Math.atan2(d[2], d[0]);
        var x = (lon / (2 * Math.PI) + 0.5) * w, y = (0.5 - lat / Math.PI) * h, sx = 1 / Math.max(0.25, Math.cos(lat));
        for (var o = -1; o <= 1; o++) { g.save(); g.translate(x + o * w, y); g.scale(sx, 1); g.fillStyle = col; g.beginPath(); for (var k = 0; k < n; k++) { var a = k * 2 * Math.PI / n + 0.3; g.lineTo(rad * Math.cos(a), rad * Math.sin(a)); } g.closePath(); g.fill(); g.restore(); }
      }
      v.forEach(function (d) { patch(d, 24, '#1b2a48', 5); });
      v.forEach(function (d) { patch([-d[0], d[1], -d[2]], 22, '#2a7fff', 6); });
      g.strokeStyle = 'rgba(30,40,70,.55)'; g.lineWidth = 2;
      for (var i = 1; i < 8; i++) { g.beginPath(); g.moveTo(0, i * h / 8); g.lineTo(w, i * h / 8); g.stroke(); }
    }, { repeat: true });
  }

  /* ---------- scene ---------- */
  function polyFloor() { return [[W, -(L - CH)], [W, L - CH], [W - CH, L], [-(W - CH), L], [-W, L - CH], [-W, -(L - CH)], [-(W - CH), -L], [W - CH, -L]]; }
  function offsetPoly(poly, d) {
    var n = poly.length, out = [];
    for (var i = 0; i < n; i++) {
      var a = poly[(i + n - 1) % n], b = poly[i], c = poly[(i + 1) % n];
      var e1 = [b[0] - a[0], b[1] - a[1]], e2 = [c[0] - b[0], c[1] - b[1]];
      var l1 = Math.hypot(e1[0], e1[1]), l2 = Math.hypot(e2[0], e2[1]);
      var n1 = [e1[1] / l1, -e1[0] / l1], n2 = [e2[1] / l2, -e2[0] / l2];
      var m = [n1[0] + n2[0], n1[1] + n2[1]], ml = Math.hypot(m[0], m[1]); m = [m[0] / ml, m[1] / ml];
      var k = d / Math.max(0.5, m[0] * n1[0] + m[1] * n1[1]);
      out.push([b[0] + m[0] * k, b[1] + m[1] * k]);
    }
    return out;
  }
  function stripMesh(ringA, zA, ringB, zB, mat, uPer, vRep) { // quad strip between two rings (world x,y + height)
    var pos = [], uv = [], idx = [], n = ringA.length, u = 0;
    for (var i = 0; i <= n; i++) {
      var a = ringA[i % n], b = ringB[i % n], pa = ringA[(i + n - 1) % n];
      if (i) u += Math.hypot(a[0] - pa[0], a[1] - pa[1]) / uPer;
      pos.push(a[0], zA, a[1], b[0], zB, b[1]); uv.push(u, 0, u, vRep || 1);
      if (i < n) { var k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new T.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    return new T.Mesh(g, mat);
  }
  function skyColor(c, y) {
    var top = new T.Color('#0b1a3a'), mid = new T.Color('#3f66a8'), hor = new T.Color('#c6d6ec'), low = new T.Color('#27303f');
    if (y < 0) return c.copy(hor).lerp(low, Math.min(1, -y * 4));
    if (y < 0.25) return c.copy(hor).lerp(mid, y / 0.25);
    return c.copy(mid).lerp(top, Math.min(1, (y - 0.25) / 0.6));
  }
  function skySphere() {
    var g = new T.SphereGeometry(30000, 32, 20), col = [], c = new T.Color(), p = g.attributes.position;
    for (var i = 0; i < p.count; i++) { skyColor(c, p.getY(i) / 30000); col.push(c.r, c.g, c.b); }
    g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
    return new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide, fog: false, toneMapped: false, depthWrite: false }));
  }
  function buildEnv() {
    var es = new T.Scene(); es.add(skySphere());
    var pan = new T.MeshBasicMaterial({ color: new T.Color(6, 6, 5.5) });
    [[0, 8000, 0, 9000, 400], [-9000, 5000, 6000, 3000, 3000], [9000, 5000, -6000, 3000, 3000]].forEach(function (a) { var m = new T.Mesh(new T.BoxGeometry(a[3], 200, a[4]), pan); m.position.set(a[0], a[1], a[2]); es.add(m); });
    var pm = new T.PMREMGenerator(renderer); envTex = pm.fromScene(es, 0.03).texture; pm.dispose(); scene.environment = envTex;
  }
  function faceY(geo, up) { // make the front face of a horizontal triangle mesh point up (+1) or down (-1)
    var p = geo.attributes.position, ix = geo.index; if (!ix) return;
    var ax = p.getX(ix.getX(0)), az = p.getZ(ix.getX(0)), bx = p.getX(ix.getX(1)), bz = p.getZ(ix.getX(1)), cx = p.getX(ix.getX(2)), cz = p.getZ(ix.getX(2));
    var ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az); // y of (b-a)x(c-a) with y-components zero
    if ((ny > 0) !== (up > 0)) for (var q = 0; q < ix.count; q += 3) { var tmp = ix.getX(q + 1); ix.setX(q + 1, ix.getX(q + 2)); ix.setX(q + 2, tmp); }
  }
  function buildArena() {
    var poly = polyFloor();
    var sh = new T.Shape(); poly.forEach(function (p, i) { if (i) sh.lineTo(p[0], p[1]); else sh.moveTo(p[0], p[1]); });
    var fg = new T.ShapeGeometry(sh), pa = fg.attributes.position, uv = [];
    for (var i = 0; i < pa.count; i++) { var x = pa.getX(i), y = pa.getY(i); pa.setXYZ(i, x, 0, y); uv.push((x + W) / (2 * W), (y + L) / (2 * L)); }
    fg.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    var nrm = fg.attributes.normal; for (var j = 0; j < nrm.count; j++) nrm.setXYZ(j, 0, 1, 0);
    faceY(fg, 1);
    var floor = new T.Mesh(fg, new T.MeshStandardMaterial({ map: grassTex(), roughness: 0.62, metalness: 0.0, envMapIntensity: 0.25 }));
    floor.receiveShadow = true; scene.add(floor);
    var gnd = new T.Mesh(new T.PlaneGeometry(60000, 60000), new T.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.95, envMapIntensity: 0.1 }));
    gnd.rotation.x = -Math.PI / 2; gnd.position.y = -4; gnd.receiveShadow = true; scene.add(gnd);
    [[-1, BLUE], [1, ORG]].forEach(function (s) {
      var gg = new T.PlaneGeometry(2 * GW, 1100); gg.rotateX(-Math.PI / 2);
      var m = new T.Mesh(gg, new T.MeshBasicMaterial({ color: s[1], transparent: true, opacity: 0.16, blending: T.AdditiveBlending, depthWrite: false })); m.position.set(0, 1.5, s[0] * (L - 550)); scene.add(m);
    });
    // walls: translucent panels with hex pattern; team-tinted back walls
    var tN = hexTex('150,185,240', 0.05, 0.28), tB = hexTex('60,140,255', 0.08, 0.38), tO = hexTex('255,150,50', 0.08, 0.38);
    function wall(a, b, z0, z1, tex) {
      var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      var tx = tex.clone(); tx.needsUpdate = true; tx.repeat.set(len / 520, Math.abs(z1 - z0) / 520);
      var mat = new T.MeshBasicMaterial({ map: tx, transparent: true, side: T.FrontSide, depthWrite: false, fog: false });
      var g = new T.BufferGeometry(); g.setAttribute('position', new T.Float32BufferAttribute([a[0], z0, a[1], b[0], z0, b[1], b[0], z1, b[1], a[0], z1, a[1]], 3));
      g.setAttribute('uv', new T.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
      // front face = the side facing the arena centre, so a camera outside the wall sees through it
      var e1x = b[0] - a[0], e1z = b[1] - a[1], nx = -e1z * (z1 - z0), nz = e1x * (z1 - z0), mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      g.setIndex(nx * -mx + nz * -mz > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
      scene.add(new T.Mesh(g, mat));
    }
    for (var k = 0; k < poly.length; k++) {
      var a = poly[k], b = poly[(k + 1) % poly.length];
      if (Math.abs(a[1]) === L && Math.abs(b[1]) === L) {
        var sy = a[1] > 0 ? 1 : -1, lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]), tx = sy > 0 ? tO : tB;
        wall([lo, sy * L], [-GW, sy * L], 0, H, tx); wall([GW, sy * L], [hi, sy * L], 0, H, tx); wall([-GW, sy * L], [GW, sy * L], GH, H, tx);
      } else wall(a, b, 0, H, tN);
    }
    function loopLine(pts, color, op) { var g = new T.BufferGeometry().setFromPoints(pts.concat([pts[0]])); scene.add(new T.Line(g, new T.LineBasicMaterial({ color: color, transparent: true, opacity: op }))); }
    loopLine(poly.map(function (p) { return P(p[0], p[1], 3); }), 0x9fd0ff, 0.7);
    loopLine(poly.map(function (p) { return P(p[0], p[1], H); }), 0xbfd8ff, 0.8);
    // ceiling grid (hidden in the top-down camera)
    var cg = new T.ShapeGeometry(sh), cp = cg.attributes.position, cuv = [];
    for (var q = 0; q < cp.count; q++) { var cx = cp.getX(q), cy = cp.getY(q); cp.setXYZ(q, cx, H, cy); cuv.push(cx / 520, cy / 520); }
    cg.setAttribute('uv', new T.Float32BufferAttribute(cuv, 2)); faceY(cg, -1);
    ceiling = new T.Mesh(cg, new T.MeshBasicMaterial({ map: hexTex('150,185,240', 0.015, 0.1), transparent: true, side: T.FrontSide, depthWrite: false, fog: false })); scene.add(ceiling);
    // goals: posts, crossbar, net, glow
    var postMat = function (c) { return new T.MeshStandardMaterial({ color: 0xe9eef7, emissive: c, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.2 }); };
    [[-1, BLUE], [1, ORG]].forEach(function (s) {
      var sy = s[0], c = s[1], d = L + GD, pm = postMat(c);
      [-GW, GW].forEach(function (x) {
        var p = new T.Mesh(new T.CylinderGeometry(24, 24, GH, 10), pm); p.position.copy(P(x, sy * L, GH / 2)); p.castShadow = true; scene.add(p);
        var p2 = new T.Mesh(new T.CylinderGeometry(14, 14, GD, 8), pm); p2.rotation.x = Math.PI / 2; p2.position.copy(P(x, sy * (L + GD / 2), GH)); scene.add(p2);
      });
      var cb = new T.Mesh(new T.CylinderGeometry(24, 24, 2 * GW, 10), pm); cb.rotation.z = Math.PI / 2; cb.position.copy(P(0, sy * L, GH)); scene.add(cb);
      var pts = [], st = 90;
      for (var x = -GW; x <= GW + 1; x += st) { pts.push(P(x, sy * d, 0), P(x, sy * d, GH), P(x, sy * L, GH), P(x, sy * d, GH)); }
      for (var z = 0; z <= GH + 1; z += st) { pts.push(P(-GW, sy * d, z), P(GW, sy * d, z), P(-GW, sy * L, z), P(-GW, sy * d, z), P(GW, sy * L, z), P(GW, sy * d, z)); }
      for (var y = L; y <= d + 1; y += st) { pts.push(P(-GW, sy * y, GH), P(GW, sy * y, GH), P(-GW, sy * y, GH), P(-GW, sy * y, 0), P(GW, sy * y, GH), P(GW, sy * y, 0)); }
      scene.add(new T.LineSegments(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.32 })));
      var gp = new T.Mesh(new T.PlaneGeometry(2 * GW, GH), new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.2, blending: T.AdditiveBlending, side: T.DoubleSide, depthWrite: false }));
      gp.position.copy(P(0, sy * L, GH / 2)); scene.add(gp);
      var inner = new T.Mesh(new T.BoxGeometry(2 * GW, 8, GD), new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.25, blending: T.AdditiveBlending, depthWrite: false }));
      inner.position.copy(P(0, sy * (L + GD / 2), 5)); scene.add(inner);
    });
    // stadium: advertising boards, two crowd tiers, light towers
    var o1 = offsetPoly(poly, 1100);
    scene.add(stripMesh(o1, 0, o1, 190, new T.MeshBasicMaterial({ map: boardTex(), side: T.DoubleSide, toneMapped: false }), 1000, 1));
    var crowd = crowdTex(), cm = new T.MeshLambertMaterial({ map: crowd, color: 0x9aa3b4, side: T.DoubleSide, emissive: 0x303848, emissiveMap: crowd, emissiveIntensity: 0.2 });
    var dark = new T.MeshLambertMaterial({ color: 0x1a2030, side: T.DoubleSide });
    var rings = [offsetPoly(poly, 1200), offsetPoly(poly, 2600), offsetPoly(poly, 2650), offsetPoly(poly, 4000)];
    [stripMesh(o1, 190, rings[0], 190, dark, 1000, 1), stripMesh(rings[0], 190, rings[1], 1100, cm, 600, 4), stripMesh(rings[1], 1100, rings[2], 1400, dark, 1000, 1),
      stripMesh(rings[2], 1400, rings[3], 2900, cm, 600, 5), stripMesh(rings[3], 2900, rings[3], 3600, dark, 1000, 1),
      stripMesh(offsetPoly(poly, 1800), 3900, rings[3], 3600, new T.MeshStandardMaterial({ color: 0x252c3a, roughness: 0.8, side: T.DoubleSide }), 1000, 1)].forEach(function (m) { scene.add(m); });
    var tmat = new T.MeshStandardMaterial({ color: 0x3a4152, roughness: 0.6, metalness: 0.5 }), lmat = new T.MeshBasicMaterial({ color: new T.Color(3, 3, 2.7), toneMapped: false });
    var gmat = new T.SpriteMaterial({ map: glowTex(), color: 0xfff1c8, blending: T.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 0], [1, 1]].forEach(function (s) {
      var x = s[0] * (W + 2300), y = s[1] * (L * 0.62);
      var pole = new T.Mesh(new T.CylinderGeometry(50, 80, 4200, 8), tmat); pole.position.copy(P(x, y, 2100)); scene.add(pole);
      var head = new T.Mesh(new T.BoxGeometry(900, 520, 120), lmat); head.position.copy(P(x, y, 4300)); head.lookAt(0, 4300, 0); scene.add(head);
      var gs = new T.Sprite(gmat); gs.scale.set(1800, 1800, 1); gs.position.copy(P(x, y, 4300)); scene.add(gs);
    });
    scene.add(skySphere());
  }

  /* ---------- ball, cars, pads, effects ---------- */
  var blobTex = null;
  function blob(r) {
    blobTex = blobTex || canvasTex(64, 64, function (g) { var gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(0,0,0,.65)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); });
    var m = new T.Mesh(new T.PlaneGeometry(2 * r, 2 * r), new T.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }));
    m.rotation.x = -Math.PI / 2; m.position.y = 1.2; scene.add(m); return m;
  }
  function buildBall() {
    ballObj = new T.Group();
    var m = new T.Mesh(new T.SphereGeometry(91.25, 32, 20), new T.MeshStandardMaterial({ map: ballTex(), roughness: 0.35, metalness: 0.05, emissive: 0x1a2a40, emissiveIntensity: 0.6, envMapIntensity: 0.9 }));
    m.castShadow = true; ballObj.add(m); scene.add(ballObj);
    ballHalo = new T.Sprite(new T.SpriteMaterial({ map: glowTex(), color: 0x9fd0ff, blending: T.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0.55 })); ballHalo.scale.set(520, 520, 1); scene.add(ballHalo);
    ballBlob = blob(110);
  }
  function extrude(pts, depth, bevel) {
    var s = new T.Shape(); pts.forEach(function (p, i) { if (i) s.lineTo(p[0], p[1]); else s.moveTo(p[0], p[1]); });
    var g = new T.ExtrudeGeometry(s, { depth: depth, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4 });
    g.translate(0, 0, -depth / 2); return g;
  }
  function makeCar(team, label) {
    var col = team === 0 ? BLUE : ORG, g = new T.Group(), parts = {};
    var paint = new T.MeshStandardMaterial({ color: col, metalness: 0.35, roughness: 0.3, envMapIntensity: 1.1, emissive: col, emissiveIntensity: 0.16 });
    var darkM = new T.MeshStandardMaterial({ color: 0x0d1118, metalness: 0.4, roughness: 0.5 });
    var glass = new T.MeshStandardMaterial({ color: 0x1a2f4a, metalness: 0.7, roughness: 0.12, envMapIntensity: 2.2 });
    function add(geo, mat, x, y, z, shadow) { var m = new T.Mesh(geo, mat); m.position.set(x, y, z); if (shadow !== false) m.castShadow = true; g.add(m); return m; }
    var body = new T.Mesh(extrude([[-45, 6], [-46, 22], [-34, 27], [28, 27], [58, 24], [72, 18], [74, 9], [62, 5], [-40, 4]], 76, 3), paint); body.castShadow = true; g.add(body);
    var cab = new T.Mesh(extrude([[-26, 26], [-10, 38.5], [14, 38.5], [36, 26]], 64, 2), glass); cab.castShadow = true; g.add(cab);
    add(new T.BoxGeometry(26, 2.6, 62), paint, 2, 40.4, 0);
    var arch = new T.CircleGeometry(17.5, 20); [[51, 39.3], [-34, 39.3]].forEach(function (a) { [1, -1].forEach(function (sd) { var m = new T.Mesh(arch, darkM); m.position.set(a[0], -1, a[1] * sd); m.rotation.y = sd > 0 ? 0 : Math.PI; g.add(m); }); });
    add(new T.BoxGeometry(14, 2.5, 82), paint, -44, 36, 0);
    [-24, 24].forEach(function (z) { add(new T.BoxGeometry(4, 10, 3), darkM, -42, 30, z, false); });
    add(new T.BoxGeometry(8, 3, 82), darkM, 73, 5.5, 0, false);
    var hl = new T.MeshBasicMaterial({ color: new T.Color(2.2, 2.2, 1.9), toneMapped: false }), tl = new T.MeshBasicMaterial({ color: new T.Color(2.4, 0.15, 0.1), toneMapped: false });
    [-27, 27].forEach(function (z) { add(new T.BoxGeometry(3, 5, 17), hl, 75, 17, z, false); add(new T.BoxGeometry(3, 5, 17), tl, -47, 19, z, false); });
    add(new T.BoxGeometry(100, 4, 70), darkM, 14, 3.6, 0, false);
    var tire = new T.CylinderGeometry(14, 14, 11, 20); tire.rotateX(Math.PI / 2);
    var rim = new T.CylinderGeometry(8.6, 8.6, 12, 12); rim.rotateX(Math.PI / 2);
    var spoke = new T.BoxGeometry(15.5, 2.2, 12.6);
    var tireM = new T.MeshStandardMaterial({ color: 0x14171d, roughness: 0.9 }), rimM = new T.MeshStandardMaterial({ color: 0xcfd6e2, metalness: 0.9, roughness: 0.25 });
    parts.wheels = [];
    [[51, 36], [51, -36], [-34, 36], [-34, -36]].forEach(function (w) {
      var wg = new T.Group(), tr = new T.Mesh(tire, tireM); tr.castShadow = true; wg.add(tr); wg.add(new T.Mesh(rim, rimM));
      for (var k = 0; k < 3; k++) { var s = new T.Mesh(spoke, darkM); s.rotation.z = k * Math.PI / 3; wg.add(s); }
      var holder = new T.Group(); holder.position.set(w[0], -3, w[1]); holder.add(wg); g.add(holder); parts.wheels.push(wg);
    });
    var fg = new T.ConeGeometry(7, 52, 12, 1, true); fg.rotateZ(Math.PI / 2); fg.translate(-46 - 26, 12, 0);
    parts.flame = new T.Mesh(fg, new T.MeshBasicMaterial({ color: new T.Color(2.2, 1.0, 0.25), transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    parts.flame.visible = false; g.add(parts.flame);
    var cg = new T.ConeGeometry(3.5, 30, 10, 1, true); cg.rotateZ(Math.PI / 2); cg.translate(-46 - 15, 12, 0);
    parts.core = new T.Mesh(cg, new T.MeshBasicMaterial({ color: new T.Color(0.6, 1.2, 3), transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false }));
    parts.core.visible = false; g.add(parts.core);
    var tg = canvasTex(64, 64, function (c) { c.fillStyle = team === 0 ? '#2a86ff' : '#ff8a1f'; c.beginPath(); c.arc(32, 32, 28, 0, 7); c.fill(); c.fillStyle = '#fff'; c.font = 'bold 36px system-ui'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(label, 32, 34); });
    parts.tag = new T.Sprite(new T.SpriteMaterial({ map: tg, depthTest: false, transparent: true, opacity: 0.9 })); parts.tag.scale.set(54, 54, 1); parts.tag.position.set(0, 98, 0); parts.tag.renderOrder = 10; g.add(parts.tag);
    scene.add(g);
    return { g: g, parts: parts, blob: blob(74) };
  }
  function buildPads(gm) {
    padObjs.forEach(function (p) { scene.remove(p.g); }); padObjs = [];
    gm.padPos.forEach(function (pp, k) {
      var big = gm.padBig[k], r = big ? 100 : 44, g = new T.Group();
      var base = new T.Mesh(new T.CylinderGeometry(r * 1.1, r * 1.2, 5, 6), new T.MeshStandardMaterial({ color: 0x1a1f2b, roughness: 0.6 })); base.position.y = 2.5; base.receiveShadow = true; g.add(base);
      var gl = new T.Mesh(new T.CylinderGeometry(r * 0.92, r * 0.92, 4, 6), new T.MeshBasicMaterial({ color: big ? 0xffb21f : 0xffd36a, transparent: true, toneMapped: false })); gl.position.y = 6; g.add(gl);
      var beam = null;
      if (big) { beam = new T.Mesh(new T.CylinderGeometry(r * 0.85, r * 0.85, 170, 6, 1, true), new T.MeshBasicMaterial({ color: 0xffa31a, transparent: true, opacity: 0.2, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide })); beam.position.y = 88; g.add(beam); }
      g.position.copy(P(pp[0], pp[1], 0)); scene.add(g); padObjs.push({ g: g, gl: gl, beam: beam, lvl: 1, target: 1, base: gl.material.color.clone() });
    });
  }
  function buildParticles() {
    var geo = new T.BufferGeometry();
    pAttr.pos = new Float32Array(MAXP * 3); pAttr.col = new Float32Array(MAXP * 4); pAttr.size = new Float32Array(MAXP);
    geo.setAttribute('position', new T.BufferAttribute(pAttr.pos, 3)); geo.setAttribute('col', new T.BufferAttribute(pAttr.col, 4)); geo.setAttribute('size', new T.BufferAttribute(pAttr.size, 1));
    var mat = new T.ShaderMaterial({
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, uniforms: { uScale: { value: 1000 } },
      vertexShader: 'attribute vec4 col; attribute float size; uniform float uScale; varying vec4 vC; void main(){ vC=col; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=max(1.,size*uScale/-mv.z); gl_Position=projectionMatrix*mv; }',
      fragmentShader: 'varying vec4 vC; void main(){ float d=length(gl_PointCoord-.5)*2.; float a=clamp(1.-d,0.,1.); gl_FragColor=vec4(vC.rgb, vC.a*a*a); }'
    });
    particles = new T.Points(geo, mat); particles.frustumCulled = false; particles.renderOrder = 5; scene.add(particles);
    flashLight = new T.PointLight(0xffffff, 0, 9000, 1.6); scene.add(flashLight);
    var sw = new T.Mesh(new T.SphereGeometry(1, 24, 12), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.DoubleSide }));
    sw.visible = false; scene.add(sw); goalFx = { sw: sw, dirs: [] };
    var r = rnd(5);
    for (var i = 0; i < 260; i++) { var a = r() * 6.283, b = Math.acos(2 * r() - 1), s = 300 + r() * 1500; goalFx.dirs.push([Math.sin(b) * Math.cos(a) * s, Math.abs(Math.cos(b)) * s * 0.9 + 100, Math.sin(b) * Math.sin(a) * s, r()]); }
  }
  function addP(x, y, z, size, r, g, b, a) { if (np >= MAXP) return; var i = np++; pAttr.pos[i * 3] = x; pAttr.pos[i * 3 + 1] = y; pAttr.pos[i * 3 + 2] = z; pAttr.size[i] = size; pAttr.col[i * 4] = r; pAttr.col[i * 4 + 1] = g; pAttr.col[i * 4 + 2] = b; pAttr.col[i * 4 + 3] = a; }

  function init() {
    var coarse = window.matchMedia && matchMedia('(pointer:coarse)').matches;
    lowQ = coarse || Math.min(screen.width, screen.height) < 600;
    try { renderer = new T.WebGLRenderer({ antialias: !lowQ, powerPreference: 'high-performance' }); }
    catch (e) { throw new Error('WebGL is not available in this browser'); }
    renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    stage.insertBefore(renderer.domElement, stage.firstChild);
    scene = new T.Scene(); scene.fog = new T.Fog(0x7d93b8, 16000, 42000);
    camera = new T.PerspectiveCamera(42, 16 / 9, 10, 60000);
    hemi = new T.HemisphereLight(0xaac8ff, 0x2e4a30, 1.1); scene.add(hemi);
    sun = new T.DirectionalLight(0xfff0d8, 2.6); sun.position.set(0, 7000, -3500); sun.target.position.set(0, 0, 0);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 3;
    var sc = sun.shadow.camera; sc.left = -3200; sc.right = 3200; sc.top = 3200; sc.bottom = -3200; sc.near = 500; sc.far = 16000;
    scene.add(sun); scene.add(sun.target);
    buildEnv(); buildArena(); buildBall(); buildParticles();
    bindUI(); applyQuality(); window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', function () { lastTs = 0; });
    index.forEach(function (gm, i) { var o = document.createElement('option'); o.value = i; o.textContent = gm.label; $('gameSel').appendChild(o); });
    requestAnimationFrame(loop);
  }
  function applyQuality() {
    renderer.shadowMap.enabled = !lowQ; sun.castShadow = !lowQ;
    renderer.setPixelRatio(lowQ ? 1 : Math.min(window.devicePixelRatio || 1, 1.5));
    scene.traverse(function (o) { if (o.material) { var ms = Array.isArray(o.material) ? o.material : [o.material]; ms.forEach(function (m) { m.needsUpdate = true; }); } });
    $('qual').classList.toggle('on', lowQ); $('qual').textContent = lowQ ? 'Low quality' : 'High quality';
    resize(); dirty = true;
  }

  /* ---------- game data ---------- */
  function loadGame(i) {
    ready = false; playing = false; $('play').textContent = 'Play'; $('bigplay').hidden = true; info('Loading game…');
    var m = index[i];
    return Promise.all([fetch(m.hdr).then(function (r) { if (!r.ok) throw new Error(m.hdr + ': HTTP ' + r.status); return r.json(); }),
      fetch(m.bin).then(function (r) { if (!r.ok) throw new Error(m.bin + ': HTTP ' + r.status); return r.arrayBuffer(); })]).then(function (res) {
      var gm = res[0]; decode(gm, res[1]); game = gm; t = 0;
      carObjs.forEach(function (c) { scene.remove(c.g); scene.remove(c.blob); }); carObjs = [];
      var nb = 0, no = 0;
      gm.teams.forEach(function (tm) { var lab = tm === 0 ? ++nb : ++no; carObjs.push(makeCar(tm, String(lab))); });
      buildPads(gm); camSnap = true;
      var cs = $('carSel'); cs.innerHTML = ''; nb = 0; no = 0;
      gm.teams.forEach(function (tm, c) { var o = document.createElement('option'); o.value = c; o.textContent = tm === 0 ? 'Terminal ' + (++nb) : gm.opp + (gm.teams.length > 2 ? ' ' + (++no) : ''); cs.appendChild(o); });
      followCar = 0; cs.value = 0;
      $('scrub').max = gm.frames - 1; $('scrub').value = 0; $('gameSel').value = i;
      $('oppName').textContent = gm.opp; $('gameNote').textContent = gm.note;
      buildMarkers(); buildBoostBars();
      $('hud').hidden = false; msg.hidden = true; $('banner').className = 'banner'; $('bigplay').hidden = false;
      ready = true; dirty = true; applyFrame();
      if (pendingPlay) { pendingPlay = false; togglePlay(); }
    });
  }
  function decode(gm, buf) {
    var N = gm.frames, C = gm.teams.length, FB = gm.frameBytes, dv = new DataView(buf);
    if (buf.byteLength !== N * FB) throw new Error('bad game file size');
    gm.ball = new Float32Array(N * 3); gm.ballQ = new Float32Array(N * 4); gm.pad = new Uint8Array(N * 5); gm.hold = new Uint8Array(N); gm.cut = new Uint8Array(N + 1);
    gm.pos = []; gm.quat = []; gm.boost = []; gm.fl = []; gm.wheel = []; gm.speed = [];
    for (var c = 0; c < C; c++) { gm.pos.push(new Float32Array(N * 3)); gm.quat.push(new Float32Array(N * 4)); gm.boost.push(new Uint8Array(N)); gm.fl.push(new Uint8Array(N)); gm.wheel.push(new Float32Array(N)); gm.speed.push(new Float32Array(N)); }
    gm.kickoffs.forEach(function (k) { gm.cut[k] = 1; });
    var bq = new T.Quaternion(), dq = new T.Quaternion(), ax = new T.Vector3();
    for (var i = 0; i < N; i++) {
      var o = i * FB; gm.hold[i] = dv.getUint8(o) & 1;
      for (var k = 0; k < 5; k++) gm.pad[i * 5 + k] = dv.getUint8(o + 1 + k);
      gm.ball[i * 3] = dv.getInt16(o + 6, true) / 4; gm.ball[i * 3 + 1] = dv.getInt16(o + 10, true) / 4; gm.ball[i * 3 + 2] = dv.getInt16(o + 8, true) / 4;
      var wx = dv.getInt16(o + 12, true) / 1000, wy = dv.getInt16(o + 14, true) / 1000, wz = dv.getInt16(o + 16, true) / 1000;
      if (i === 0 || gm.cut[i]) bq.set(0, 0, 0, 1);
      else if (!gm.hold[i]) { var wl = Math.hypot(wx, wy, wz); if (wl > 1e-4) { ax.set(wx / wl, wy / wl, wz / wl); dq.setFromAxisAngle(ax, wl / gm.hz); bq.premultiply(dq).normalize(); } }
      gm.ballQ[i * 4] = bq.x; gm.ballQ[i * 4 + 1] = bq.y; gm.ballQ[i * 4 + 2] = bq.z; gm.ballQ[i * 4 + 3] = bq.w;
      for (var c2 = 0; c2 < C; c2++) {
        var p = o + 18 + 16 * c2, P3 = gm.pos[c2], Q = gm.quat[c2];
        P3[i * 3] = dv.getInt16(p, true) / 4; P3[i * 3 + 1] = dv.getInt16(p + 4, true) / 4; P3[i * 3 + 2] = dv.getInt16(p + 2, true) / 4;
        for (var q = 0; q < 4; q++) Q[i * 4 + q] = dv.getInt16(p + 6 + 2 * q, true) / 32767;
        gm.boost[c2][i] = dv.getUint8(p + 14); gm.fl[c2][i] = dv.getUint8(p + 15);
      }
    }
    var fw = new T.Vector3(), qq = new T.Quaternion(), hz = gm.hz;
    for (var c3 = 0; c3 < C; c3++) {
      var P4 = gm.pos[c3], Q4 = gm.quat[c3], wa = gm.wheel[c3], sp = gm.speed[c3];
      for (var i2 = 1; i2 < N; i2++) {
        if (gm.cut[i2]) { wa[i2] = wa[i2 - 1]; sp[i2] = 0; continue; }
        var dx = P4[i2 * 3] - P4[(i2 - 1) * 3], dy = P4[i2 * 3 + 1] - P4[(i2 - 1) * 3 + 1], dz = P4[i2 * 3 + 2] - P4[(i2 - 1) * 3 + 2];
        qq.set(Q4[i2 * 4], Q4[i2 * 4 + 1], Q4[i2 * 4 + 2], Q4[i2 * 4 + 3]); fw.set(1, 0, 0).applyQuaternion(qq);
        wa[i2] = wa[i2 - 1] - (dx * fw.x + dy * fw.y + dz * fw.z) / 14;
        sp[i2] = Math.hypot(dx, dy, dz) * hz;
      }
      sp[0] = sp[1] || 0;
    }
    gm.clock = new Float32Array(N); var run = 0;
    for (var i4 = 0; i4 < N; i4++) { if (!gm.hold[i4]) run++; gm.clock[i4] = run / gm.hz; }
  }
  function buildMarkers() {
    var mk = $('markers'); mk.innerHTML = '';
    game.goals.forEach(function (gl) { var d = document.createElement('i'); d.className = gl[1] === 0 ? 'b' : 'o'; d.style.left = (gl[0] / (game.frames - 1) * 100) + '%'; mk.appendChild(d); });
  }
  var bars = [];
  function buildBoostBars() {
    var L1 = $('boostL'), R1 = $('boostR'); L1.innerHTML = ''; R1.innerHTML = ''; bars = []; var nb = 0, no = 0;
    game.teams.forEach(function (tm) {
      var d = document.createElement('div'); d.className = 'bb ' + (tm === 0 ? 'b' : 'o'); d.innerHTML = '<span></span><div><i></i></div>';
      d.firstChild.textContent = tm === 0 ? ++nb : ++no; (tm === 0 ? L1 : R1).appendChild(d); bars.push(d.lastChild.firstChild);
    });
  }

  /* ---------- per-frame update ---------- */
  var _q1, _q2, _qa, _v0;
  function applyFrame() {
    if (!game || !ready) return;
    var g = game, N = g.frames, i = Math.min(Math.floor(t), N - 1), a = t - i, j = Math.min(i + 1, N - 1);
    if (g.cut[j]) a = 0;
    if (!_q1) { _q1 = new T.Quaternion(); _q2 = new T.Quaternion(); _qa = new T.Quaternion(); _v0 = new T.Vector3(); }
    var b = g.ball;
    ballObj.position.set(b[i * 3] + (b[j * 3] - b[i * 3]) * a, b[i * 3 + 1] + (b[j * 3 + 1] - b[i * 3 + 1]) * a, b[i * 3 + 2] + (b[j * 3 + 2] - b[i * 3 + 2]) * a);
    _q1.set(g.ballQ[i * 4], g.ballQ[i * 4 + 1], g.ballQ[i * 4 + 2], g.ballQ[i * 4 + 3]); _q2.set(g.ballQ[j * 4], g.ballQ[j * 4 + 1], g.ballQ[j * 4 + 2], g.ballQ[j * 4 + 3]);
    ballObj.quaternion.copy(_q1).slerp(_q2, a); ballHalo.position.copy(ballObj.position);
    var bh = Math.max(0.25, 1 - ballObj.position.y / 1400); ballBlob.position.set(ballObj.position.x, 1.2, ballObj.position.z); ballBlob.scale.setScalar(bh); ballBlob.material.opacity = bh;
    ballBlob.visible = lowQ;
    np = 0;
    for (var k = 1; k <= 14; k++) {
      var f = Math.max(0, i - k); if (g.cut[f + 1] && f + 1 <= i) break; var w = 1 - k / 15;
      addP(b[f * 3], b[f * 3 + 1], b[f * 3 + 2], 85 * w + 10, 0.55 * w, 0.75 * w, 1.0 * w, 0.5 * w);
    }
    for (var c = 0; c < carObjs.length; c++) {
      var o = carObjs[c], P3 = g.pos[c], Q = g.quat[c], fl = g.fl[c][i];
      var cx = P3[i * 3] + (P3[j * 3] - P3[i * 3]) * a, cy = P3[i * 3 + 1] + (P3[j * 3 + 1] - P3[i * 3 + 1]) * a, cz = P3[i * 3 + 2] + (P3[j * 3 + 2] - P3[i * 3 + 2]) * a;
      var demo = (fl & 2) !== 0 && (g.fl[c][j] & 2) !== 0;
      o.g.visible = !demo; o.blob.visible = !demo && lowQ;
      o.g.position.set(cx, cy, cz);
      _q1.set(Q[i * 4], Q[i * 4 + 1], Q[i * 4 + 2], Q[i * 4 + 3]); _q2.set(Q[j * 4], Q[j * 4 + 1], Q[j * 4 + 2], Q[j * 4 + 3]);
      o.g.quaternion.copy(_q1).slerp(_q2, a);
      var wa = g.wheel[c], ang = wa[i] + (wa[j] - wa[i]) * a;
      for (var w2 = 0; w2 < 4; w2++) o.parts.wheels[w2].rotation.z = ang;
      var boosting = (fl & 1) !== 0 && !demo;
      o.parts.flame.visible = boosting; o.parts.core.visible = boosting;
      if (boosting) { var fk = 0.85 + 0.3 * Math.sin(t * 2.7 + c * 2.1) + 0.15 * Math.sin(t * 7.3); o.parts.flame.scale.set(fk, 1 + 0.2 * Math.sin(t * 5 + c), 1 + 0.2 * Math.sin(t * 5 + c)); o.parts.core.scale.set(fk, 1, 1); }
      var hgt = Math.max(0.2, 1 - cy / 700); o.blob.position.set(cx, 1.3, cz); o.blob.scale.setScalar(hgt); o.blob.material.opacity = hgt;
      o.parts.tag.visible = !demo && o.g.position.distanceToSquared(camera.position) > 600 * 600;
      if (bars[c]) bars[c].style.width = Math.min(100, g.boost[c][i]) + '%';
      // history-based effects: deterministic from the data, so scrubbing is safe
      var K = lowQ ? 6 : 12, tc = g.teams[c] === 0 ? [0.25, 0.6, 1.0] : [1.0, 0.6, 0.2];
      for (var h = 0; h < K; h++) {
        var f2 = i - h; if (f2 < 0 || (h > 0 && g.cut[f2 + 1])) break;
        var fl2 = g.fl[c][f2], age = (h + (1 - a)) / K;
        if ((fl2 & 1) && !(fl2 & 2)) {
          _v0.set(-48, 12, 0).applyQuaternion(_qa.set(Q[f2 * 4], Q[f2 * 4 + 1], Q[f2 * 4 + 2], Q[f2 * 4 + 3]));
          var jx = Math.sin(f2 * 12.9898 + c * 78.2) * 5, jz = Math.cos(f2 * 4.1 + c * 3.3) * 5;
          addP(P3[f2 * 3] + _v0.x + jx, P3[f2 * 3 + 1] + _v0.y, P3[f2 * 3 + 2] + _v0.z + jz, 16 + 34 * age, 1.0, 0.55 + 0.25 * (1 - age), 0.15, 0.55 * (1 - age));
        }
        if (g.speed[c][f2] > 2200 && h < K - 2) addP(P3[f2 * 3], P3[f2 * 3 + 1] + 14, P3[f2 * 3 + 2], 30 * (1 - age) + 8, tc[0] * 0.8 + 0.2, tc[1] * 0.8 + 0.2, tc[2] * 0.8 + 0.2, 0.32 * (1 - age));
      }
    }
    var pb = g.pad, base = i * 5;
    for (var p = 0; p < padObjs.length; p++) padObjs[p].target = (pb[base + (p >> 3)] >> (p & 7)) & 1;
    // goal effects, a function of the playhead only
    var show = null, age2 = 0, bn = $('banner');
    for (var gi = 0; gi < g.goals.length; gi++) { var ga = (t - g.goals[gi][0]) / g.hz; if (ga >= 0 && ga < 3.2) { show = g.goals[gi]; age2 = ga; } }
    if (show) {
      var gx = b[show[0] * 3], gy = b[show[0] * 3 + 1] + 40, gz = b[show[0] * 3 + 2], gc = show[1] === 0 ? [0.3, 0.6, 1] : [1, 0.6, 0.2];
      for (var d = 0; d < goalFx.dirs.length; d++) {
        var dr = goalFx.dirs[d], life = 0.8 + dr[3] * 1.8; if (age2 > life) continue;
        var px = gx + dr[0] * age2 * 0.9, py = gy + dr[1] * age2 - 520 * age2 * age2, pz = gz + dr[2] * age2 * 0.9; if (py < 5) py = 5;
        addP(px, py, pz, 38 * (0.6 + dr[3]), gc[0] * (0.5 + dr[3] * 0.5) + 0.35, gc[1] + 0.3, gc[2] + 0.2, 0.9 * (1 - age2 / life));
      }
      flashLight.position.set(gx, 700, gz); flashLight.color.setRGB(gc[0], gc[1], gc[2]); flashLight.intensity = Math.max(0, 1 - age2 / 0.7) * 600000;
      goalFx.sw.visible = age2 < 1.1; goalFx.sw.position.set(gx, gy, gz); goalFx.sw.scale.setScalar(80 + age2 * 1500); goalFx.sw.material.opacity = Math.max(0, 0.22 * (1 - age2 / 1.1) * (1 - age2 / 1.1));
      goalFx.sw.material.color.setRGB(gc[0], gc[1], gc[2]);
      if (age2 < 1.9) { bn.className = 'banner show ' + (show[1] === 0 ? 'b' : 'o'); $('bannerTxt').textContent = show[1] === 0 ? 'Terminal' : g.opp; } else bn.className = 'banner';
    } else { flashLight.intensity = 0; goalFx.sw.visible = false; bn.className = 'banner'; }
    particles.geometry.setDrawRange(0, np);
    particles.geometry.attributes.position.needsUpdate = true; particles.geometry.attributes.col.needsUpdate = true; particles.geometry.attributes.size.needsUpdate = true;
    var s0 = 0, s1 = 0; g.goals.forEach(function (x) { if (t >= x[0]) { if (x[1] === 0) s0++; else s1++; } });
    $('s0').textContent = s0; $('s1').textContent = s1;
    var rem = Math.max(0, 300 - g.clock[i]), mm = Math.floor(rem / 60), ss = Math.floor(rem % 60);
    $('clock').textContent = mm + ':' + (ss < 10 ? '0' : '') + ss;
    $('scrub').value = t;
    var sx = Math.round(Math.max(-2600, Math.min(2600, ballObj.position.x)) / 120) * 120, sz = Math.round(Math.max(-3600, Math.min(3600, ballObj.position.z)) / 120) * 120;
    sun.target.position.set(sx, 0, sz); sun.position.set(sx, 7000, sz - 3500);
    dirty = true;
  }


  /* ---------- director: picks a focus car and a shot, with hard cuts like the in-game replay director ---------- */
  var dir0 = { focus: 0, shot: 'ball', t0: 0, cand: -1, candT0: 0, last: -1e9, hi: false, hiT: 0, log: [], far: false, farFlip: -1, cuts: 0, yaw: 0, hgt: 120 };
  function carVel(c, i) { var P3 = game.pos[c], j = Math.min(i + 1, game.frames - 1), k = Math.max(0, j - 1), hz = game.hz; return [(P3[j * 3] - P3[k * 3]) * hz, (P3[j * 3 + 1] - P3[k * 3 + 1]) * hz, (P3[j * 3 + 2] - P3[k * 3 + 2]) * hz]; }
  function carScores(i) {
    var g = game, b = g.ball, out = [], bx = b[i * 3], by = b[i * 3 + 1], bz = b[i * 3 + 2];
    for (var c = 0; c < carObjs.length; c++) {
      var P3 = g.pos[c], dx = bx - P3[i * 3], dy = by - P3[i * 3 + 1], dz = bz - P3[i * 3 + 2], d = Math.hypot(dx, dy, dz) + 1, v = carVel(c, i);
      var closing = Math.max(0, (v[0] * dx + v[1] * dy + v[2] * dz) / d), eta = d / Math.max(closing, 600), sc = -eta;
      var q = g.quat[c]; _qa.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]); _v0.set(1, 0, 0).applyQuaternion(_qa);
      sc += 0.5 * (_v0.x * dx + _v0.y * dy + _v0.z * dz) / d;                       // facing the ball
      var touch = false; for (var h = 0; h < 8; h++) { var f = Math.max(0, i - h); if (Math.hypot(b[f * 3] - P3[f * 3], b[f * 3 + 1] - P3[f * 3 + 1], b[f * 3 + 2] - P3[f * 3 + 2]) < 265) { touch = true; break; } }
      if (touch) sc += 1.5;                                                          // recent toucher
      var att = g.teams[c] === 0 ? 1 : -1;
      if ((bz - P3[i * 3 + 2]) * att > 3000) sc -= 0.7;                              // far behind the play
      if (g.fl[c][i] & 2) sc -= 100;                                                 // demolished
      out.push({ s: sc, touch: touch, d: d });
    }
    return out;
  }
  // Director (reworked 2026-10-04 after "lots of fast cuts, cars not centred"). Modelled on the open-source viewers
  // RLViser (VirxEC, MIT: nearest car to the ball, re-picked on a slow timer) and rocket-viewer (Longi94, MIT: rigid
  // ball cam), plus the game's own ball-cam model (yaw-only offset behind the car, facing the ball). One shot type in
  // play (the ball cam) and a goal shot; the focus changes only when another car has been nearest the ball for 1.2 s
  // and the current shot has run 4 s, so cuts are rare and every one means "the play moved to another car".
  function directorUpdate(dt) {
    var g = game, i = Math.min(Math.floor(t), g.frames - 1), D = dir0, hz = g.hz, jump = (t - D.last) < 0 || (t - D.last) > 20;
    var bp = ballObj.position, best = 0, bd = 1e18, nearest = 1e18;
    for (var c = 0; c < carObjs.length; c++) { if (g.fl[c][i] & 2) continue; var d2 = carObjs[c].g.position.distanceToSquared(bp); if (d2 < bd) { bd = d2; best = c; } }   // demolished cars are skipped
    nearest = Math.sqrt(bd);
    var oldShot = D.shot, oldFocus = D.focus, kt = -1;
    for (var k = 0; k < g.kickoffs.length; k++) if (g.kickoffs[k] <= i) kt = g.kickoffs[k];
    // Kickoff: a wide shot from the start until the first touch (or 4 s), like a broadcast; the ball cam takes over after.
    var kickWide = false;
    if (kt >= 0 && i - kt < 4 * hz && !g.hold[i]) {
      kickWide = true;
      for (var f = kt; f <= i && kickWide; f += 2) { var bb = g.ball; for (var c2 = 0; c2 < carObjs.length; c2++) { var P3 = g.pos[c2]; if (Math.hypot(bb[f * 3] - P3[f * 3], bb[f * 3 + 1] - P3[f * 3 + 1], bb[f * 3 + 2] - P3[f * 3 + 2]) < 260) { kickWide = false; break; } } }
    }
    // Far from every car (a long clear, a loose ball): wide too, with hysteresis so the shot holds at least 4 s.
    if (jump) { D.far = nearest > 2600; D.farT = t; }
    else if (D.far ? nearest < 1800 : nearest > 2600) { if (D.farFlip === undefined || D.farFlip < 0) D.farFlip = t; if (t - D.farFlip > (D.far ? 0.8 : 1.0) * hz && t - D.t0 > (D.far ? 3 : 4) * hz) { D.far = !D.far; D.farFlip = -1; } }
    else D.farFlip = -1;
    var shot = g.hold[i] ? 'goal' : (kickWide || D.far) ? 'wide' : 'ball';
    if (jump || shot === 'ball' && oldShot !== 'ball') { D.focus = best; D.cand = -1; }
    else if (best !== D.focus) {
      if (D.cand !== best) { D.cand = best; D.candT0 = t; }
      if (t - D.candT0 > 1.2 * hz && t - D.t0 > 4 * hz) { D.focus = best; D.cand = -1; }
    } else D.cand = -1;
    if (jump || shot !== oldShot || (shot === 'ball' && D.focus !== oldFocus)) { camSnap = true; D.t0 = t; D.cuts++; }
    D.shot = shot; D.last = t;
    var nm = $('carSel').options[D.focus]; $('ftag').textContent = nm ? nm.textContent : '';
    $('ftag').className = 'ftag ' + (g.teams[D.focus] === 0 ? 'b' : 'o'); $('ftag').hidden = camMode !== 'director' || shot !== 'ball';
    return D;
  }
  function carVel0(i) { var b = game.ball, j = Math.min(i + 1, game.frames - 1), k = Math.max(0, j - 1), hz = game.hz; return [(b[j * 3] - b[k * 3]) * hz, (b[j * 3 + 1] - b[k * 3 + 1]) * hz, (b[j * 3 + 2] - b[k * 3 + 2]) * hz]; }

  /* ---------- cameras ---------- */
  var _a, _b, _c;
  function sm(dt, k) { return 1 - Math.exp(-k * dt); }
  function updateCamera(dt) {
    if (!_a) { _a = new T.Vector3(); _b = new T.Vector3(); _c = new T.Vector3(); camPos = new T.Vector3(0, 2500, -9000); camTgt = new T.Vector3(); dirSm = new T.Vector3(1, 0, 0); }
    var want = _a, look = _b, fov = 42;
    ceiling.visible = camPos.y < H - 50;
    camera.up.set(0, 1, 0);
    if (camMode === 'orbit') {
      if (!pointers.size) { orbit.th += orbit.vth * dt; orbit.ph = Math.max(0.05, Math.min(1.5, orbit.ph + orbit.vph * dt)); var dm = Math.exp(-4 * dt); orbit.vth *= dm; orbit.vph *= dm; }
      var cp = Math.cos(orbit.ph);
      camPos.set(Math.sin(orbit.th) * cp * orbit.r, Math.sin(orbit.ph) * orbit.r, -Math.cos(orbit.th) * cp * orbit.r); camTgt.set(0, 250, 0); fov = 45;
    } else if (camMode === 'director') {
      var D = directorUpdate(dt), bp = ballObj.position, fc = carObjs[D.focus], fp = fc.g.position, snap = camSnap, kk = 1, ang;
      var maxTurn = 2.6 * dt;
      if (D.shot === 'goal') {
        var gl = 0; for (var q = 0; q < game.goals.length; q++) if (game.goals[q][0] <= t) gl = game.goals[q];
        var sgn = gl && gl[1] === 0 ? 1 : -1, age = Math.max(0, (t - gl[0]) / game.hz);
        fov = 60; want.set(bp.x > 0 ? 1500 : -1500, 180 + age * 25, sgn * (L - 1900 + age * 160)); look.copy(bp); look.y = Math.max(120, bp.y);
        if (snap) camPos.copy(want); camPos.lerp(want, sm(dt, 6)); camTgt.lerp(look, snap ? 1 : sm(dt, 6));
      } else if (D.shot === 'wide') {
        // Third-person field shot (broadcast style): high on the sideline, looking across the pitch at the ball.
        fov = 40 * Math.max(1, Math.min(1.8, 1.55 / camera.aspect));
        look.set(bp.x * 0.5, 80 + bp.y * 0.5, Math.max(-4000, Math.min(4000, bp.z)));
        want.set(-(W + 900), 1900 + bp.y * 0.2, look.z * 0.8);
        camTgt.lerp(look, snap ? 1 : sm(dt, 2.5)); camPos.lerp(want, snap ? 1 : sm(dt, 2.0));
      } else {
        // Ball cam, an independent implementation of the game's model (see the report): the camera sits at the car plus a
        // YAW-ONLY offset (-distance horizontally toward away-from-ball, +height up), looks at the ball and is pitched by
        // the angle setting (-4 deg = slightly down). Distance grows a little with speed (stiffness < 1 pulls the camera
        // back). Yaw and height are low-passed so the swivel is smooth, and the turn rate is capped.
        var tb = _c.copy(bp).sub(fp), hl = Math.hypot(tb.x, tb.z), yaw;
        if (hl < 1) { var f0 = new T.Vector3(1, 0, 0).applyQuaternion(fc.g.quaternion); yaw = Math.atan2(f0.z, f0.x); } else yaw = Math.atan2(tb.z, tb.x);
        if (snap) { D.yaw = yaw; D.hgt = 150; } else {
          var dy = Math.atan2(Math.sin(yaw - D.yaw), Math.cos(yaw - D.yaw)); dy = Math.max(-5 * dt, Math.min(5 * dt, dy * sm(dt, 9)));
          D.yaw += dy; D.hgt += (150 - D.hgt) * sm(dt, 3);
        }
        var fv = carVel(D.focus, Math.min(Math.floor(t), game.frames - 1)), spd = Math.min(1, Math.hypot(fv[0], fv[1], fv[2]) / 2300);
        var dist = 330 * (1 + 0.55 * 0.3 * spd);
        want.set(fp.x - Math.cos(D.yaw) * dist, fp.y + D.hgt, fp.z - Math.sin(D.yaw) * dist);
        // keep the camera above the floor, below the ceiling and inside the walls
        want.x = Math.max(-W + 70, Math.min(W - 70, want.x)); want.z = Math.max(-L + 70, Math.min(L - 70, want.z)); want.y = Math.max(70, Math.min(H - 80, want.y));
        var dv = _c.copy(bp).lerp(fp, 0.2).sub(want).normalize(), hh = Math.hypot(dv.x, dv.z), ang = Math.atan2(dv.y, hh) - 4 * Math.PI / 180;
        ang = Math.max(-0.5, Math.min(0.30, ang));   // cap the upward aim so the car stays in frame under a high ball
        look.set(want.x + Math.cos(Math.atan2(dv.z, dv.x)) * Math.cos(ang) * 1000, want.y + Math.sin(ang) * 1000, want.z + Math.sin(Math.atan2(dv.z, dv.x)) * Math.cos(ang) * 1000);
        camPos.copy(want); camTgt.copy(look);
        fov = Math.max(50, Math.min(95, 2 * Math.atan(Math.tan(55 * Math.PI / 180) / camera.aspect) * 180 / Math.PI));
      }
      camSnap = false;
    } else if (camMode === 'debug') { fov = camera.fov;
    } else if (camMode === 'top') {
      var tf = Math.tan(21 * Math.PI / 180), asp = camera.aspect, h = Math.max(6400 / tf, 5300 / (tf * asp));
      camPos.set(0, h, 0); camTgt.set(0, 0, 0); camera.up.set(0, 0, 1);
    } else {
      var ballP = ballObj.position, car = carObjs[followCar];
      if (camMode === 'broadcast') {
        fov = 33 * Math.max(1, Math.min(1.9, 1.55 / camera.aspect));
        look.set(ballP.x * 0.55, 60 + ballP.y * 0.55, Math.max(-4300, Math.min(4300, ballP.z)));
        want.set(-(W + 250), 1500 + ballP.y * 0.25, look.z * 0.85);
        camTgt.lerp(look, camSnap ? 1 : sm(dt, 3.5)); camPos.lerp(want, camSnap ? 1 : sm(dt, 2.5));
      } else if (car) {
        var cpz = car.g.position, toBall = _c.copy(ballP).sub(cpz); toBall.y = 0;
        var fwd = new T.Vector3(1, 0, 0).applyQuaternion(car.g.quaternion); fwd.y = 0; if (fwd.lengthSq() < 1e-4) fwd.set(1, 0, 0); fwd.normalize();
        var dir = fwd; if (camMode === 'chase' && toBall.length() > 250) dir = toBall.normalize();
        dirSm.lerp(dir, camSnap ? 1 : sm(dt, 6)); if (dirSm.lengthSq() < 1e-3) dirSm.copy(fwd); var dn = dirSm.clone().normalize();
        if (camMode === 'chase') {
          fov = 62; want.copy(cpz).addScaledVector(dn, -640); want.y = Math.max(60, cpz.y + 280 + Math.min(300, ballP.y * 0.15));
          look.copy(cpz).lerp(ballP, 0.6); look.y = Math.max(60, cpz.y + (ballP.y - cpz.y) * 0.35 + 50);
        } else { fov = 66; want.copy(cpz).addScaledVector(dn, -430); want.y = cpz.y + 190; look.copy(cpz).addScaledVector(dn, 700); look.y = cpz.y + 40; }
        camPos.lerp(want, camSnap ? 1 : sm(dt, 9)); camTgt.lerp(look, camSnap ? 1 : sm(dt, 9));
      }
      camSnap = false;
    }
    if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * 0.15; camera.updateProjectionMatrix(); updScale(); }
    camera.position.copy(camPos); if (camera.position.y < 30) camera.position.y = 30;
    camera.lookAt(camTgt);
  }
  function updScale() { uScale = renderer.domElement.height / (2 * Math.tan(camera.fov * Math.PI / 360)); particles.material.uniforms.uScale.value = uScale; }
  function camSig() { return camera.position.x + camera.position.y * 3 + camera.position.z * 7 + (camTgt ? camTgt.x * 0.5 + camTgt.y * 0.3 + camTgt.z * 0.7 : 0); }
  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = Math.min((ts - (lastTs || ts)) / 1000, 0.1); lastTs = ts;
    if (!ready || !visible) return;
    if (playing) {
      t += dt * game.hz * speed;
      if (t >= game.frames - 1) { t = game.frames - 1; playing = false; $('play').textContent = 'Replay'; }
      applyFrame();
    }
    var prev = camSig();
    updateCamera(dt);
    if (playing || dirty || Math.abs(camSig() - prev) > 0.02) renderer.render(scene, camera);
    padObjs.forEach(function (p) {
      p.lvl += (p.target - p.lvl) * Math.min(1, dt * 10);
      p.gl.material.opacity = 0.12 + 0.88 * p.lvl; p.gl.material.color.copy(p.base).multiplyScalar(0.3 + 0.7 * p.lvl); if (p.beam) p.beam.material.opacity = 0.2 * p.lvl;
    });
    dirty = false;
  }
  function resize() {
    if (!renderer) return; var w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); updScale(); dirty = true;
  }

  /* ---------- UI ---------- */
  var pointers = new Map(), pinch = 0;
  function togglePlay() {
    if (!game || !ready) return;
    if (t >= game.frames - 1) t = 0;
    playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; lastTs = 0; $('bigplay').hidden = true;
  }
  function seek(nt) {
    nt = Math.max(0, Math.min(game.frames - 1, nt)); if (Math.abs(nt - t) > game.hz * 2) camSnap = true;
    t = nt; applyFrame();
  }
  function nextGoal(dir) {
    var g = game.goals, tgt = null;
    if (dir > 0) { for (var i = 0; i < g.length; i++) if (g[i][0] - 150 > t + 1) { tgt = g[i][0]; break; } }
    else { for (var j = g.length - 1; j >= 0; j--) if (g[j][0] - 150 < t - 60) { tgt = g[j][0]; break; } }
    if (tgt === null) tgt = dir > 0 ? game.frames - 1 + 150 : 150;
    seek(Math.max(0, tgt - 150)); // a few seconds before the goal, so the build-up is visible
  }
  function setCam(m) {
    camMode = m; camSnap = true; if (dirSm) dirSm.set(1, 0, 0);
    $('carWrap').style.display = (m === 'chase' || m === 'car') ? '' : 'none'; $('ftag').hidden = m !== 'director'; dir0.last = -1e9;
    Array.prototype.forEach.call($('cams').children, function (b) { b.classList.toggle('on', b.dataset.c === m); }); dirty = true;
  }
  var CAMS = ['director', 'broadcast', 'chase', 'car', 'orbit', 'top'];
  function bindUI() {
    $('play').onclick = togglePlay;
    $('prevg').onclick = function () { nextGoal(-1); }; $('nextg').onclick = function () { nextGoal(1); };
    $('scrub').oninput = function () { seek(parseFloat(this.value)); };
    $('speeds').onclick = function (e) { var s = e.target.dataset.s; if (!s) return; speed = parseFloat(s); Array.prototype.forEach.call(this.children, function (b) { b.classList.toggle('on', b.dataset.s === s); }); };
    $('cams').onclick = function (e) { if (e.target.dataset.c) setCam(e.target.dataset.c); };
    $('gameSel').onchange = function () { loadGame(parseInt(this.value, 10)).catch(function (e) { fail('Could not load that game (' + e.message + ').'); }); };
    $('carSel').onchange = function () { followCar = parseInt(this.value, 10); camSnap = true; dirty = true; };
    $('qual').onclick = function () { lowQ = !lowQ; applyQuality(); };
    $('full').onclick = function () { if (document.fullscreenElement) document.exitFullscreen(); else if (box.requestFullscreen) box.requestFullscreen(); };
    document.addEventListener('fullscreenchange', function () { setTimeout(resize, 60); });
    $('carWrap').style.display = 'none';
    var el = renderer.domElement, moved = false;
    el.addEventListener('click', function () { if (!moved) togglePlay(); });
    el.addEventListener('pointerdown', function (e) { el.setPointerCapture(e.pointerId); pointers.set(e.pointerId, [e.clientX, e.clientY]); moved = false; });
    function up(e) { pointers.delete(e.pointerId); pinch = 0; }
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('pointermove', function (e) {
      var pr = pointers.get(e.pointerId); if (!pr) return;
      if (pointers.size >= 2) { pointers.set(e.pointerId, [e.clientX, e.clientY]); var v = Array.from(pointers.values()), d = Math.hypot(v[0][0] - v[1][0], v[0][1] - v[1][1]); if (pinch) zoom((pinch - d) * 25); pinch = d; moved = true; return; }
      var dx = e.clientX - pr[0], dy = e.clientY - pr[1]; pointers.set(e.pointerId, [e.clientX, e.clientY]);
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      if (!moved) return;
      if (camMode !== 'orbit') setCam('orbit');
      orbit.th -= dx * 0.006; orbit.ph = Math.max(0.05, Math.min(1.5, orbit.ph + dy * 0.006));
      orbit.vth = Math.max(-2, Math.min(2, -dx * 0.4)); orbit.vph = Math.max(-1, Math.min(1, dy * 0.4)); dirty = true;
    });
    el.addEventListener('wheel', function (e) { e.preventDefault(); if (camMode !== 'orbit') setCam('orbit'); zoom(e.deltaY * 8); }, { passive: false });
    document.addEventListener('keydown', function (e) {
      var ae = document.activeElement, tag = (ae && ae.tagName) || '';
      if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && ae.type !== 'range')) return;
      if (!game || !ready || !(box.matches(':hover') || box.contains(ae) || document.fullscreenElement)) return;
      var k = e.key;
      if (k === ' ') { e.preventDefault(); togglePlay(); }
      else if (k === 'ArrowRight') { e.preventDefault(); seek(t + game.hz * (e.shiftKey ? 30 : 5)); }
      else if (k === 'ArrowLeft') { e.preventDefault(); seek(t - game.hz * (e.shiftKey ? 30 : 5)); }
      else if (k === 'n' || k === 'N') nextGoal(1); else if (k === 'p' || k === 'P') nextGoal(-1);
      else if (k === 'c' || k === 'C') setCam(CAMS[(CAMS.indexOf(camMode) + 1) % CAMS.length]);
      else if (k === '0' || k === 'd' || k === 'D') setCam('director'); else if (k >= '1' && k <= '5') setCam(CAMS[+k]);
      else if (k === '+' || k === '=') cycleSpeed(1); else if (k === '-') cycleSpeed(-1);
    });
  }
  function cycleSpeed(d) {
    var kids = Array.prototype.slice.call($('speeds').children), i = kids.findIndex(function (b) { return b.classList.contains('on'); });
    kids[Math.max(0, Math.min(kids.length - 1, i + d))].click();
  }
  function zoom(d) { orbit.r = Math.max(1500, Math.min(26000, orbit.r + d)); dirty = true; }

  // test hook (harmless): lets automated checks drive the viewer
  window.TerminalViewer = {
    seek: function (s) { if (game) seek(s * game.hz); }, cam: setCam, play: togglePlay, speed: function (s) { speed = s; }, start: start,
    scan: function (step) { var g = game, out = [], prevS = null, prevF = -1; for (var f = 0; f < g.frames; f += step) { t = f; applyFrame(); updateCamera(step / g.hz); var d = dir0; if (d.shot !== prevS || (d.shot === 'ball' && d.focus !== prevF)) out.push([+(f / g.hz).toFixed(1), d.shot, d.focus]); prevS = d.shot; prevF = d.focus; } return out; },
    gm: function () { return game; },
    ballPos: function () { return ballObj.position.toArray(); },
    dir: function () { return { focus: dir0.focus, shot: dir0.shot }; },
    state: function () { return { t: t, ready: ready, game: game && game.id, mode: camMode, playing: playing, low: lowQ }; },
    low: function (v) { lowQ = !!v; if (renderer) applyQuality(); }, car: function (c) { followCar = c; camSnap = true; },
    dbg: function (p, l, f) { camMode = 'debug'; camPos.set(p[0], p[1], p[2]); camTgt.set(l[0], l[1], l[2]); camera.fov = f || 40; camera.updateProjectionMatrix(); dirty = true; },
    carPos: function (c) { return carObjs[c].g.position.toArray(); },
    load: function (i) { return loadGame(i); },
    probe: function () { var c = carObjs[0]; if (!c) return null; var f = new T.Vector3(1, 0, 0).applyQuaternion(c.g.quaternion); return { pos: c.g.position.toArray(), fwd: f.toArray() }; }
  };
})();
