/* Terminal replay viewer: plays back recorded bot games (positions only).
   World = RocketSim coordinates (x, y, z up; left-handed). Three.js is right-handed with y up,
   so we map world (x,y,z) -> three (x,z,y). That swap is a reflection, which un-mirrors the
   left-handed world: blue (team 0) attacks +y, steer +1 turns toward -x. */
(function () {
  'use strict';
  var THREE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
  var $ = function (id) { return document.getElementById(id); };
  var stage = $('stage'), msg = $('msg');
  var T, renderer, scene, camera, ballMesh, carObjs = [], padMeshes = [], trail, trailPos, trailCol;
  var game = null, t = 0, playing = false, speed = 1, camMode = 'orbit', followCar = 0, lastTs = 0;
  var orbit = { th: 0.0, ph: 0.9, r: 9500 }, free = { p: null, yaw: 0, pitch: -0.3 };
  var keys = {}, dirty = true, index = [];
  var TRAIL = 36;

  function loadScript(src, cb, err) {
    var s = document.createElement('script'); s.src = src; s.onload = cb; s.onerror = err; document.head.appendChild(s);
  }
  function fail(m) { msg.hidden = false; msg.textContent = m; }

  // Start loading three.js only when the viewer is near the screen (cheap phones, fast first paint).
  var started = false;
  function start() {
    if (started) return; started = true;
    fetch('data/index.json').then(function (r) { return r.json(); }).then(function (j) { index = j; });
    loadScript(THREE_SRC, init, function () { fail('Could not load three.js from the CDN. The clips below still work.'); });
  }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (e, o) { if (e[0].isIntersecting) { o.disconnect(); start(); } }, { rootMargin: '400px' }).observe(stage);
  } else start();

  function P(x, y, z) { return new T.Vector3(x, z, y); } // world -> three

  function init() {
    T = window.THREE;
    try {
      renderer = new T.WebGLRenderer({ antialias: window.devicePixelRatio < 2, powerPreference: 'low-power' });
    } catch (e) { return fail('WebGL is not available in this browser. The clips below still work.'); }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    stage.insertBefore(renderer.domElement, stage.firstChild);
    scene = new T.Scene(); scene.background = new T.Color(0x0a0e16);
    camera = new T.PerspectiveCamera(55, 16 / 9, 20, 40000);
    scene.add(new T.AmbientLight(0xffffff, 0.75));
    var dl = new T.DirectionalLight(0xffffff, 0.6); dl.position.set(2000, 6000, -1500); scene.add(dl);
    buildArena(); buildBall();
    trailPos = new Float32Array(TRAIL * 3); trailCol = new Float32Array(TRAIL * 3);
    var tg = new T.BufferGeometry();
    tg.setAttribute('position', new T.BufferAttribute(trailPos, 3)); tg.setAttribute('color', new T.BufferAttribute(trailCol, 3));
    trail = new T.Line(tg, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
    trail.frustumCulled = false; scene.add(trail);
    bindUI(); resize(); window.addEventListener('resize', resize);
    var wait = setInterval(function () { // index.json may still be loading
      if (!index.length) return; clearInterval(wait);
      index.forEach(function (g, i) { var o = document.createElement('option'); o.value = i; o.textContent = g.label + ' (' + g.seconds + ' s)'; $('gameSel').appendChild(o); });
      loadGame(0);
    }, 50);
    requestAnimationFrame(loop);
  }

  /* ---------------- procedural arena (simple geometry only) ---------------- */
  function quad(a, b, h, z0, color, op) { // vertical wall between world (x,y) points a and b
    var v = [a[0], a[1], z0, b[0], b[1], z0, b[0], b[1], h, a[0], a[1], z0, b[0], b[1], h, a[0], a[1], h], p = [];
    for (var i = 0; i < v.length; i += 3) p.push(v[i], v[i + 2], v[i + 1]);
    var g = new T.BufferGeometry(); g.setAttribute('position', new T.BufferAttribute(new Float32Array(p), 3));
    var m = new T.Mesh(g, new T.MeshBasicMaterial({ color: color, transparent: true, opacity: op, side: T.DoubleSide, depthWrite: false }));
    scene.add(m);
    var pts = [P(a[0], a[1], z0), P(b[0], b[1], z0), P(b[0], b[1], h), P(a[0], a[1], h), P(a[0], a[1], z0)];
    scene.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: color, transparent: true, opacity: 0.55 })));
  }
  function buildArena() {
    var W = 4096, L = 5120, C = 1152, H = 2044, GW = 893, GH = 642.775, GD = 880;
    var wc = 0x6f86b0;
    // floor (octagon footprint with chamfered corners)
    var fp = [[W, -(L - C)], [W, L - C], [W - C, L], [-(W - C), L], [-W, L - C], [-W, -(L - C)], [-(W - C), -L], [W - C, -L]];
    var sh = new T.Shape(); fp.forEach(function (p, i) { if (i) sh.lineTo(p[0], p[1]); else sh.moveTo(p[0], p[1]); });
    var fg = new T.ShapeGeometry(sh), pa = fg.attributes.position;
    for (var i = 0; i < pa.count; i++) { var y = pa.getY(i); pa.setXYZ(i, pa.getX(i), 0, y); } // (x,y,0) -> three (x,0,y)
    scene.add(new T.Mesh(fg, new T.MeshBasicMaterial({ color: 0x0f2a1c, side: T.DoubleSide })));
    // team-coloured goal zones on the floor
    [[-1, 0x1f4f8f], [1, 0x8f5a1f]].forEach(function (s) {
      var g = new T.PlaneGeometry(2 * GW, 900); g.rotateX(-Math.PI / 2);
      var m = new T.Mesh(g, new T.MeshBasicMaterial({ color: s[1], transparent: true, opacity: 0.5 })); m.position.set(0, 2, s[0] * (L - 450)); scene.add(m);
    });
    // walls: octagon edges, back walls leave the goal opening
    for (var k = 0; k < fp.length; k++) {
      var a = fp[k], b = fp[(k + 1) % fp.length];
      if (Math.abs(a[1]) === L && Math.abs(b[1]) === L) { // back wall: two pieces + lintel
        var sy = a[1] > 0 ? 1 : -1, lo = Math.min(a[0], b[0]), hi = Math.max(a[0], b[0]);
        quad([lo, sy * L], [-GW, sy * L], H, 0, wc, 0.12); quad([GW, sy * L], [hi, sy * L], H, 0, wc, 0.12);
        quad([-GW, sy * L], [GW, sy * L], H, GH, wc, 0.12);
      } else quad(a, b, H, 0, wc, 0.12);
    }
    // goals
    [[-1, 0x2f7fe0], [1, 0xe58a2a]].forEach(function (s) {
      var sy = s[0], d = L + GD, c = s[1];
      quad([-GW, sy * L], [-GW, sy * d], GH, 0, c, 0.22); quad([GW, sy * L], [GW, sy * d], GH, 0, c, 0.22);
      quad([-GW, sy * d], [GW, sy * d], GH, 0, c, 0.3);
      var pts = [P(-GW, sy * L, GH), P(-GW, sy * d, GH), P(GW, sy * d, GH), P(GW, sy * L, GH)];
      scene.add(new T.Line(new T.BufferGeometry().setFromPoints(pts), new T.LineBasicMaterial({ color: c })));
    });
    // markings: centre line and circle
    var ln = new T.LineBasicMaterial({ color: 0x3a7a58 });
    scene.add(new T.Line(new T.BufferGeometry().setFromPoints([P(-W, 0, 3), P(W, 0, 3)]), ln));
    var cp = []; for (var j = 0; j <= 64; j++) cp.push(P(Math.cos(j / 64 * 6.2832) * 1000, Math.sin(j / 64 * 6.2832) * 1000, 3));
    scene.add(new T.Line(new T.BufferGeometry().setFromPoints(cp), ln));
  }
  function buildBall() {
    ballMesh = new T.Group();
    ballMesh.add(new T.Mesh(new T.SphereGeometry(92.75, 20, 14), new T.MeshLambertMaterial({ color: 0xf2f4f8 })));
    ballMesh.add(new T.Mesh(new T.SphereGeometry(94, 10, 7), new T.MeshBasicMaterial({ color: 0x24324a, wireframe: true })));
    scene.add(ballMesh);
  }
  function makeCar(team) {
    var col = team === 0 ? 0x2f8bff : 0xff8a1f;
    var g = new T.Group();
    // Octane hitbox: length 120.5 (local X fwd), height 38.7 (Y up), width 86.7 (Z); offset 13.88 fwd, 20.75 up
    var body = new T.Mesh(new T.BoxGeometry(120.5, 38.7, 86.7), new T.MeshLambertMaterial({ color: col }));
    body.position.set(13.88, 20.75, 0); g.add(body);
    var nose = new T.Mesh(new T.BoxGeometry(14, 10, 60), new T.MeshBasicMaterial({ color: 0xffffff }));
    nose.position.set(13.88 + 60, 22, 0); g.add(nose); // white strip marks the front
    var roof = new T.Mesh(new T.BoxGeometry(50, 8, 66), new T.MeshLambertMaterial({ color: 0x10151f }));
    roof.position.set(5, 20.75 + 22, 0); g.add(roof);
    var ring = new T.Mesh(new T.RingGeometry(60, 75, 24), new T.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.0, side: T.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 4; g.add(ring); g.userData.ring = ring;
    scene.add(g); return g;
  }

  /* ---------------- game loading ---------------- */
  function loadGame(i) {
    msg.hidden = false; msg.textContent = 'Loading game…'; playing = false; $('play').textContent = 'Play';
    fetch(index[i].file).then(function (r) { return r.json(); }).then(function (g) {
      prep(g); game = g; t = 0;
      carObjs.forEach(function (c) { scene.remove(c); }); carObjs = [];
      g.team.forEach(function (tm) { carObjs.push(makeCar(tm)); });
      padMeshes.forEach(function (m) { scene.remove(m); }); padMeshes = [];
      g.padPos.forEach(function (p, k) {
        var big = g.padBig[k];
        var m = new T.Mesh(new T.CylinderGeometry(big ? 140 : 55, big ? 140 : 55, 8, 14), new T.MeshBasicMaterial({ color: big ? 0xffc23c : 0xffe08a, transparent: true }));
        m.position.copy(P(p[0], p[1], 8)); scene.add(m); padMeshes.push(m);
      });
      var cs = $('carSel'); cs.innerHTML = ''; var nb = 0, no = 0;
      g.team.forEach(function (tm, c) { var o = document.createElement('option'); o.value = c; o.textContent = tm === 0 ? 'Terminal ' + (++nb) + ' (blue)' : g.opp + (g.team.length > 2 ? ' ' + (++no) : '') + ' (orange)'; cs.appendChild(o); });
      followCar = 0; cs.value = 0;
      $('scrub').max = g.frames - 1; $('scrub').value = 0;
      $('oppName').textContent = g.opp; $('gameNote').textContent = g.note + ' Time shown is the length of the excerpt.';
      $('hud').hidden = false; msg.hidden = true; $('banner').hidden = true;
      $('gameSel').value = i; dirty = true; applyFrame();
    }).catch(function () { fail('Could not load that game.'); });
  }
  function prep(g) { // quaternions from forward/up (reflected into three space)
    var C = g.team.length, F = g.frames;
    g.q = []; g.pos = [];
    for (var c = 0; c < C; c++) {
      var q = new Float32Array(F * 4), p = new Float32Array(F * 3), d = g.cars[c];
      var m = new T.Matrix4(), f = new T.Vector3(), u = new T.Vector3(), z = new T.Vector3(), qq = new T.Quaternion();
      for (var i = 0; i < F; i++) {
        var o = i * 9;
        p[i * 3] = d[o]; p[i * 3 + 1] = d[o + 2]; p[i * 3 + 2] = d[o + 1];
        f.set(d[o + 3], d[o + 5], d[o + 4]); u.set(d[o + 6], d[o + 8], d[o + 7]);
        z.crossVectors(f, u).normalize(); u.crossVectors(z, f).normalize();
        m.makeBasis(f, u, z); qq.setFromRotationMatrix(m);
        if (i && q[(i - 1) * 4] * qq.x + q[(i - 1) * 4 + 1] * qq.y + q[(i - 1) * 4 + 2] * qq.z + q[(i - 1) * 4 + 3] * qq.w < 0) { qq.x = -qq.x; qq.y = -qq.y; qq.z = -qq.z; qq.w = -qq.w; }
        q[i * 4] = qq.x; q[i * 4 + 1] = qq.y; q[i * 4 + 2] = qq.z; q[i * 4 + 3] = qq.w;
      }
      g.q.push(q); g.pos.push(p);
    }
    // pad availability per frame from initial state + toggle events
    g.padAt = []; var cur = g.pad0.slice(), e = 0;
    for (var i2 = 0; i2 < F; i2++) { while (e < g.padEv.length && g.padEv[e][0] <= i2) { cur[g.padEv[e][1]] = g.padEv[e][2]; e++; } g.padAt.push(cur.slice()); }
  }

  /* ---------------- per-frame update ---------------- */
  var q1, q2, tmpV;
  function applyFrame() {
    if (!game) return;
    var g = game, F = g.frames, i = Math.min(Math.floor(t), F - 2), a = Math.min(t - i, 1);
    if (F < 2) { i = 0; a = 0; }
    var j = Math.min(i + 1, F - 1);
    var b = g.ball;
    ballMesh.position.set(b[i * 3] + (b[j * 3] - b[i * 3]) * a, b[i * 3 + 2] + (b[j * 3 + 2] - b[i * 3 + 2]) * a, b[i * 3 + 1] + (b[j * 3 + 1] - b[i * 3 + 1]) * a);
    if (!q1) { q1 = new T.Quaternion(); q2 = new T.Quaternion(); tmpV = new T.Vector3(); }
    for (var c = 0; c < carObjs.length; c++) {
      var o = carObjs[c], p = g.pos[c], q = g.q[c];
      o.visible = !(g.demo[c][i] && g.demo[c][j]);
      o.position.set(p[i * 3] + (p[j * 3] - p[i * 3]) * a, p[i * 3 + 1] + (p[j * 3 + 1] - p[i * 3 + 1]) * a, p[i * 3 + 2] + (p[j * 3 + 2] - p[i * 3 + 2]) * a);
      q1.set(q[i * 4], q[i * 4 + 1], q[i * 4 + 2], q[i * 4 + 3]); q2.set(q[j * 4], q[j * 4 + 1], q[j * 4 + 2], q[j * 4 + 3]);
      o.quaternion.copy(q1).slerp(q2, a);
      o.userData.ring.material.opacity = (camMode === 'follow' || camMode === 'ball') && c === followCar ? 0.8 : 0;
    }
    var pad = g.padAt[i];
    for (var k = 0; k < padMeshes.length; k++) padMeshes[k].material.opacity = pad[k] ? 0.95 : 0.15;
    // ball trail: last TRAIL frames at 30 Hz
    for (var n = 0; n < TRAIL; n++) {
      var fi = Math.max(0, i - (TRAIL - 1 - n)), w = n / (TRAIL - 1);
      trailPos[n * 3] = b[fi * 3]; trailPos[n * 3 + 1] = b[fi * 3 + 2]; trailPos[n * 3 + 2] = b[fi * 3 + 1];
      trailCol[n * 3] = 0.9 * w; trailCol[n * 3 + 1] = 0.95 * w; trailCol[n * 3 + 2] = w;
    }
    trail.geometry.attributes.position.needsUpdate = true; trail.geometry.attributes.color.needsUpdate = true;
    // HUD
    var s = [0, 0], over = null;
    g.goals.forEach(function (gl) { if (t >= gl[0] - 1e-6) { s[gl[1]]++; over = gl[1]; } });
    $('s0').textContent = s[0]; $('s1').textContent = s[1];
    var sec = t / g.hz; $('timeTxt').textContent = Math.floor(sec / 60) + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60).toFixed(1);
    var bn = $('banner');
    if (over !== null) { bn.hidden = false; bn.textContent = 'GOAL - ' + (over === 0 ? 'Terminal' : g.opp); bn.style.color = over === 0 ? '#5db4ff' : '#ffb35e'; } else bn.hidden = true;
    $('scrub').value = t;
    dirty = true;
  }
  function updateCamera(dt) {
    var asp = camera.aspect;
    camera.up.set(0, 1, 0);
    if (camMode === 'orbit') {
      var th = orbit.th, ph = orbit.ph, r = orbit.r;
      // default th=0 puts the camera behind the blue goal (negative y) looking toward orange
      camera.position.set(Math.sin(th) * Math.cos(ph) * r, Math.sin(ph) * r, -Math.cos(th) * Math.cos(ph) * r + 0);
      camera.lookAt(0, 300, 0);
    } else if (camMode === 'free') {
      var cp = Math.cos(free.pitch);
      var dir = new T.Vector3(Math.sin(free.yaw) * cp, Math.sin(free.pitch), Math.cos(free.yaw) * cp);
      var sp = 2500 * dt, right = new T.Vector3().crossVectors(dir, new T.Vector3(0, 1, 0)).normalize();
      if (keys.w) free.p.addScaledVector(dir, sp); if (keys.s) free.p.addScaledVector(dir, -sp);
      if (keys.d) free.p.addScaledVector(right, sp); if (keys.a) free.p.addScaledVector(right, -sp);
      if (keys.e) free.p.y += sp; if (keys.q) free.p.y -= sp;
      camera.position.copy(free.p); camera.lookAt(free.p.clone().add(dir));
    } else if (camMode === 'top') {
      var tf = Math.tan(camera.fov * Math.PI / 360);
      var h = Math.max(5700 / tf, 4700 / (tf * asp));
      camera.position.set(0, h, 0); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 0);
    } else if (game) {
      var car = carObjs[followCar]; if (!car) return;
      var fwd = new T.Vector3(1, 0, 0).applyQuaternion(car.quaternion); fwd.y = 0; if (fwd.lengthSq() < 1e-4) fwd.set(1, 0, 0); fwd.normalize();
      var target = car.position.clone(), want;
      if (camMode === 'follow') {
        want = target.clone().addScaledVector(fwd, -520).add(new T.Vector3(0, 230, 0));
        camera.position.lerp(want, Math.min(1, dt * 8)); camera.lookAt(target.clone().addScaledVector(fwd, 500).add(new T.Vector3(0, 60, 0)));
      } else {
        var toBall = ballMesh.position.clone().sub(target); toBall.y = 0; if (toBall.lengthSq() < 1) toBall.copy(fwd); toBall.normalize();
        want = target.clone().addScaledVector(toBall, -520).add(new T.Vector3(0, 260, 0));
        camera.position.lerp(want, Math.min(1, dt * 8)); camera.lookAt(ballMesh.position);
      }
    }
  }
  function loop(ts) {
    var dt = Math.min((ts - (lastTs || ts)) / 1000, 0.1); lastTs = ts;
    if (playing && game) {
      t += dt * game.hz * speed;
      if (t >= game.frames - 1) { t = game.frames - 1; playing = false; $('play').textContent = 'Replay'; }
      applyFrame();
    }
    if (camMode === 'free' && (keys.w || keys.a || keys.s || keys.d || keys.q || keys.e)) dirty = true;
    if (camMode === 'follow' || camMode === 'ball') dirty = true;
    if (dirty && renderer) { updateCamera(dt); renderer.render(scene, camera); dirty = false; }
    requestAnimationFrame(loop);
  }
  function resize() {
    var w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); dirty = true;
  }

  /* ---------------- UI ---------------- */
  function setCam(m) {
    if (m === 'free' && camMode !== 'free') { free.p = camera.position.clone(); var d = new T.Vector3(); camera.getWorldDirection(d); free.yaw = Math.atan2(d.x, d.z); free.pitch = Math.asin(d.y); }
    if (m === 'follow' || m === 'ball') camera.position.set(0, 2500, -6000);
    camMode = m; $('carWrap').style.display = (m === 'follow' || m === 'ball') ? '' : 'none';
    Array.prototype.forEach.call($('cams').children, function (b) { b.classList.toggle('on', b.dataset.c === m); });
    applyFrame();
  }
  function bindUI() {
    $('play').onclick = function () {
      if (!game) return;
      if (t >= game.frames - 1) t = 0;
      playing = !playing; $('play').textContent = playing ? 'Pause' : 'Play'; lastTs = 0;
    };
    $('scrub').oninput = function () { t = parseFloat(this.value); applyFrame(); };
    $('speeds').onclick = function (e) { var s = e.target.dataset.s; if (!s) return; speed = parseFloat(s); Array.prototype.forEach.call(this.children, function (b) { b.classList.toggle('on', b.dataset.s === s); }); };
    $('cams').onclick = function (e) { if (e.target.dataset.c) setCam(e.target.dataset.c); };
    $('gameSel').onchange = function () { loadGame(parseInt(this.value, 10)); };
    $('carSel').onchange = function () { followCar = parseInt(this.value, 10); applyFrame(); };
    $('carWrap').style.display = 'none';
    var el = renderer.domElement, ptrs = {}, pinch = 0;
    el.addEventListener('pointerdown', function (e) { el.setPointerCapture(e.pointerId); ptrs[e.pointerId] = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', function (e) { delete ptrs[e.pointerId]; pinch = 0; });
    el.addEventListener('pointercancel', function (e) { delete ptrs[e.pointerId]; pinch = 0; });
    el.addEventListener('pointermove', function (e) {
      var pr = ptrs[e.pointerId]; if (!pr) return;
      var ids = Object.keys(ptrs);
      if (ids.length >= 2) { // pinch
        ptrs[e.pointerId] = [e.clientX, e.clientY];
        var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) zoom((pinch - d) * 8); pinch = d; return;
      }
      var dx = e.clientX - pr[0], dy = e.clientY - pr[1]; ptrs[e.pointerId] = [e.clientX, e.clientY];
      if (camMode === 'orbit') { orbit.th -= dx * 0.006; orbit.ph = Math.max(0.05, Math.min(1.5, orbit.ph + dy * 0.006)); }
      else if (camMode === 'free') { free.yaw -= dx * 0.005; free.pitch = Math.max(-1.5, Math.min(1.5, free.pitch - dy * 0.005)); }
      dirty = true;
    });
    el.addEventListener('wheel', function (e) { e.preventDefault(); zoom(e.deltaY * 4); }, { passive: false });
    window.addEventListener('keydown', function (e) { var k = e.key.toLowerCase(); if ('wasdqe'.indexOf(k) >= 0 && k.length === 1 && camMode === 'free' && document.activeElement.tagName !== 'SELECT') keys[k] = true; });
    window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
  }
  function zoom(d) {
    if (camMode === 'orbit') orbit.r = Math.max(1500, Math.min(16000, orbit.r + d));
    else if (camMode === 'free') { var dir = new T.Vector3(); camera.getWorldDirection(dir); free.p.addScaledVector(dir, -d); }
    dirty = true;
  }
})();
