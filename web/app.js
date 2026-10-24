import * as THREE from 'three';

/* ============================================================
   Connection globe — 3D
   ============================================================ */
const R = 1;
const DISP = 0.03;              // relief height
const SURF = R + DISP * 0.55;    // altitude where arcs start
const COL = { in: new THREE.Color('#0e9fa6'), out: new THREE.Color('#ff5a36') };
const CAM_Z = 5.4;

const params = new URLSearchParams(location.search);
const $ = (s) => document.querySelector(s);

/* ---------------- renderer / scene ---------------- */
const canvas = $('#scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 0, CAM_Z);

// lights: warm key top-left, lavender fill, blue rim back-right
const key = new THREE.DirectionalLight(0xfff8f2, 3.4);
key.position.set(-4.5, 3.2, 3.6);
scene.add(key);
scene.add(new THREE.HemisphereLight(0xffffff, 0xc4c3ef, 1.15));
const rim = new THREE.DirectionalLight(0x6f80ff, 2.2);
rim.position.set(5, -1.2, -2.5);
scene.add(rim);
const bounce = new THREE.DirectionalLight(0xd9d2ff, 0.5);
bounce.position.set(2, -4, 3);
scene.add(bounce);

const world = new THREE.Group();
scene.add(world);

/* ---------------- globe ---------------- */
const loader = new THREE.TextureLoader();
const glowUniform = { value: params.has('glow') ? parseFloat(params.get('glow')) || 0 : 1 };
const loadTex = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));

async function buildGlobe() {
  const [hTex, nTex, aoTex, gTex] = await Promise.all([
    loadTex('tex/height.png'), loadTex('tex/normal.jpg'), loadTex('tex/ao.png'), loadTex('tex/glow.png'),
  ]);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  for (const t of [hTex, nTex, aoTex, gTex]) {
    t.colorSpace = THREE.NoColorSpace;
    t.anisotropy = aniso;
    t.wrapS = THREE.RepeatWrapping;
  }
  const geo = new THREE.SphereGeometry(R, 720, 360);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xfbfbfe,
    roughness: 0.9,
    metalness: 0.0,
    displacementMap: hTex,
    displacementScale: params.has('nodisp') ? 0 : DISP,
    normalMap: nTex,
    normalScale: new THREE.Vector2(1.9, 1.9),
    aoMap: aoTex,
    aoMapIntensity: 0.9,
  });
  // translucent lavender edge (fresnel) + glow under the land, seen from the light side
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uRim = { value: new THREE.Color('#9aa6ff') };
    sh.uniforms.uRimW = { value: new THREE.Color('#eef0ff') };
    sh.uniforms.uGlowMap = { value: gTex };
    sh.uniforms.uGlowCol = { value: new THREE.Color('#6f80ff') };
    sh.uniforms.uGlowDir = { value: new THREE.Vector3(0.85, -0.3, 0.42).normalize() };
    sh.uniforms.uGlowStr = glowUniform;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim; uniform vec3 uRimW; uniform sampler2D uGlowMap; uniform vec3 uGlowCol; uniform vec3 uGlowDir; uniform float uGlowStr;')
      .replace('#include <opaque_fragment>', `
        vec3 Vd = normalize(vViewPosition);
        float ndv = clamp(dot(normal, Vd), 0.0, 1.0);
        float fr = pow(1.0 - ndv, 3.0);
        float side = smoothstep(-0.6, 0.9, normalize(vNormal).x - normalize(vNormal).y * 0.3);
        vec3 rimCol = mix(uRimW, uRim, side);
        outgoingLight = mix(outgoingLight, rimCol * 1.02, fr * 0.6 * (0.35 + 0.65 * side));
        outgoingLight += uRim * pow(1.0 - ndv, 6.0) * 0.35 * side;
        // glow: light leaking from under the continents onto the sea, only on the side facing uGlowDir
        float gm = texture2D(uGlowMap, vNormalMapUv).r;
        float gSide = smoothstep(-0.45, 0.75, dot(normalize(vNormal), uGlowDir));
        float gk = gm * gSide * (0.8 + 1.4 * fr) * uGlowStr;
        outgoingLight = mix(outgoingLight, uGlowCol, clamp(gk * 1.25, 0.0, 0.88));
        outgoingLight += uGlowCol * gk * gk * 0.35;
        #include <opaque_fragment>`);
  };
  const globe = new THREE.Mesh(geo, mat);
  world.add(globe);

  // subtle halo
  const haloMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide,
    uniforms: { uCol: { value: new THREE.Color('#8f9cff') } },
    vertexShader: `varying vec3 vN; varying vec3 vV;
      void main(){ vec4 mv = modelViewMatrix*vec4(position,1.); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uCol; varying vec3 vN; varying vec3 vV;
      void main(){ float d = dot(vN, vV); float a = pow(clamp(-d / 0.42, 0., 1.), 2.2); // back face: max near globe, 0 at the edge
        float side = smoothstep(-0.6, 0.9, vN.x - vN.y*0.3);
        gl_FragColor = vec4(uCol, a * 0.22 * (0.15 + side));
        #include <colorspace_fragment>
      }`,
  });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.09, 96, 48), haloMat);
  scene.add(halo);
  return globe;
}

/* ---------------- coordinates ---------------- */
const D2R = Math.PI / 180;
function ll2v(lat, lon, r = 1) {
  const la = lat * D2R, lo = lon * D2R;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

/* ---------------- globe rotation ---------------- */
const view = { lon: 0, lat: 0.25, vLon: 0, vLat: 0, zoom: CAM_Z, zoomT: CAM_Z, auto: true, idle: 0, anim: null };
function focusOn(lat, lon, ms = 1400) {
  // bring (lat, lon) to screen center, slightly below
  let tLon = -Math.PI / 2 - lon * D2R;
  const tLat = THREE.MathUtils.clamp(lat * D2R - 0.12, -1.25, 1.25);
  // shortest way round
  while (tLon - view.lon > Math.PI) tLon -= 2 * Math.PI;
  while (tLon - view.lon < -Math.PI) tLon += 2 * Math.PI;
  view.anim = { from: { lon: view.lon, lat: view.lat }, to: { lon: tLon, lat: tLat }, t0: performance.now(), ms };
  view.vLon = view.vLat = 0;
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: 0 };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  view.anim = null; view.idle = 0;
});
canvas.addEventListener('pointermove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY; mouse.dirty = true;
  if (!drag) return;
  const k = 0.0042 * (view.zoom / CAM_Z);
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX; drag.y = e.clientY; drag.moved += Math.abs(dx) + Math.abs(dy);
  view.lon += dx * k; view.lat = THREE.MathUtils.clamp(view.lat + dy * k, -1.3, 1.3);
  view.vLon = dx * k; view.vLat = dy * k;
  view.idle = 0;
});
const endDrag = (e) => {
  if (!drag) return;
  const click = drag.moved < 4;
  drag = null; canvas.classList.remove('dragging');
  if (click && hovered) { pinned = hovered === pinned ? null : hovered; if (pinned) focusOn(pinned.lat, pinned.lon); }
  else if (click) pinned = null;
};
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('pointerleave', () => { mouse.x = -1e4; mouse.dirty = true; });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  view.zoomT = THREE.MathUtils.clamp(view.zoomT * Math.exp(e.deltaY * 0.0012), 2.2, 9);
  view.idle = 0;
}, { passive: false });

/* ---------------- arcs & markers ---------------- */
const arcVS = `
  varying float vS; varying vec3 vN; varying vec3 vV;
  void main(){ vS = uv.x; vec4 mv = modelViewMatrix*vec4(position,1.);
    vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`;
const arcFS = `
  uniform vec3 uColor; uniform float uTime; uniform float uDraw; uniform float uAlpha;
  uniform float uSeed; uniform float uHi; uniform float uDim;
  varying float vS; varying vec3 vN; varying vec3 vV;
  void main(){
    if (vS > uDraw) discard;
    float p = fract(uTime * 0.38 + uSeed);
    float k = p - vS; if (k < 0.0) k += 1.0;
    float tail = 0.24;
    float comet = k < tail ? pow(1.0 - k / tail, 1.6) : 0.0;
    float head = smoothstep(0.012, 0.0, abs(vS - p));
    float edge = smoothstep(0.0, 0.035, vS) * smoothstep(1.0, 0.965, vS);
    float shade = 0.75 + 0.25 * clamp(dot(vN, vV), 0.0, 1.0);
    vec3 c = uColor * shade;
    c = mix(c, uColor * 0.55 + 0.45, head * 0.6);
    float a = (0.34 + 0.66 * comet + 0.3 * uHi) * mix(1.0, edge, 0.6);
    a = clamp(a, 0.0, 1.0) * uAlpha * mix(1.0, 0.22, uDim);
    gl_FragColor = vec4(c, a);
    #include <colorspace_fragment>
  }`;

const ringGeo = new THREE.RingGeometry(0.72, 1.0, 48);
const dotGeo = new THREE.CircleGeometry(1, 24);
const hitGeo = new THREE.SphereGeometry(1, 10, 8);

function surfaceObj(mesh, normal, r) {
  mesh.position.copy(normal).multiplyScalar(r);
  mesh.lookAt(normal.clone().multiplyScalar(r * 2));
  return mesh;
}

const arcs = new Map();   // key -> arc
let home = null, homeObj = null;
let filter = 'all', search = '', showLan = false, paused = false;
let hovered = null, pinned = null, hlRowKey = null;

function arcPoints(a, b, n = 72) {
  const ang = a.angleTo(b);
  const lift = 0.035 + 0.2 * Math.pow(ang / Math.PI, 0.9);
  const pts = [];
  const sinA = Math.sin(ang) || 1e-6;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w1 = Math.sin((1 - t) * ang) / sinA, w2 = Math.sin(t * ang) / sinA;
    const v = a.clone().multiplyScalar(w1).add(b.clone().multiplyScalar(w2)).normalize();
    pts.push(v.multiplyScalar(SURF + lift * Math.sin(Math.PI * t)));
  }
  return pts;
}

function arcRadius(count) { return 0.0032 + 0.0014 * Math.log2(1 + count); }

function makeArc(g) {
  const hv = ll2v(home.lat, home.lon), rv = ll2v(g.lat, g.lon);
  const [a, b] = g.dir === 'out' ? [hv, rv] : [rv, hv];   // always source -> destination
  const curve = new THREE.CatmullRomCurve3(arcPoints(a, b));
  const radius = arcRadius(g.items.length);
  const mat = new THREE.ShaderMaterial({
    vertexShader: arcVS, fragmentShader: arcFS, transparent: true, depthWrite: false,
    uniforms: {
      uColor: { value: COL[g.dir] }, uTime: { value: 0 }, uDraw: { value: 0 }, uAlpha: { value: 1 },
      uSeed: { value: Math.random() }, uHi: { value: 0 }, uDim: { value: 0 },
    },
  });
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 96, radius, 8, false), mat);
  tube.renderOrder = 2;
  world.add(tube);

  // marker at the remote end
  const n = rv.clone();
  const dot = surfaceObj(new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: COL[g.dir], transparent: true, depthWrite: false })), n, R + DISP + 0.002);
  dot.scale.setScalar(0.011);
  const ring = surfaceObj(new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: COL[g.dir], transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })), n, R + DISP + 0.003);
  ring.scale.setScalar(0.01);
  const hit = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.copy(n).multiplyScalar(R + DISP); hit.scale.setScalar(0.03);
  world.add(dot, ring, hit);
  const arc = { ...g, tube, mat, dot, ring, hit, radius, born: performance.now(), dying: 0, normal: n };
  tube.userData.arc = arc; hit.userData.arc = arc;
  return arc;
}

function disposeArc(a) {
  world.remove(a.tube, a.dot, a.ring, a.hit);
  a.tube.geometry.dispose(); a.mat.dispose(); a.dot.material.dispose(); a.ring.material.dispose(); a.hit.material.dispose();
}

function buildHome() {
  if (homeObj) { world.remove(homeObj.group); }
  if (!home || home.lat == null) return;
  const n = ll2v(home.lat, home.lon);
  const group = new THREE.Group();
  const ink = new THREE.Color('#2c2f4a');
  const core = surfaceObj(new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: ink, depthWrite: false, transparent: true })), n, R + DISP + 0.004);
  core.scale.setScalar(0.016);
  const halo = surfaceObj(new THREE.Mesh(dotGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, depthWrite: false, transparent: true, opacity: 0.9 })), n, R + DISP + 0.0035);
  halo.scale.setScalar(0.026);
  const rings = [0, 1, 2].map(() => {
    const m = surfaceObj(new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: ink, transparent: true, depthWrite: false, side: THREE.DoubleSide })), n, R + DISP + 0.003);
    group.add(m); return m;
  });
  group.add(halo, core);
  world.add(group);
  homeObj = { group, rings, normal: n };
}

/* ---------------- data: grouping & sync ---------------- */
let snapshot = { conns: [], stats: {} };
let lastIds = new Set();
let newIds = new Set();

function visibleConn(c) {
  if (c.lan && !showLan) return false;
  if (filter !== 'all' && c.dir !== filter) return false;
  if (search) {
    const s = `${c.proc} ${c.rip} ${c.rport} ${c.city || ''} ${c.country || ''} ${c.host || ''}`.toLowerCase();
    if (!s.includes(search)) return false;
  }
  return true;
}

function groupKey(c) { return `${c.dir}|${c.lat.toFixed(1)},${c.lon.toFixed(1)}`; }

function syncArcs() {
  if (!home || home.lat == null) return;
  const groups = new Map();
  for (const c of snapshot.conns) {
    if (c.lan || c.lat == null) continue;
    const k = groupKey(c);
    if (!groups.has(k)) groups.set(k, { key: k, dir: c.dir, lat: c.lat, lon: c.lon, city: c.city, region: c.region, country: c.country, cc: c.cc, items: [] });
    groups.get(k).items.push(c);
  }
  const now = performance.now();
  for (const [k, g] of groups) {
    const ex = arcs.get(k);
    if (!ex || ex.dying) {
      if (ex) disposeArc(ex);
      const a = makeArc(g); arcs.set(k, a);
    } else {
      ex.items = g.items;
      const r = arcRadius(g.items.length);
      if (Math.abs(r - ex.radius) > 0.0006) {   // rebuild tube if thickness changed
        ex.tube.geometry.dispose();
        ex.tube.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(arcPoints(...(ex.dir === 'out' ? [homeObj.normal, ex.normal] : [ex.normal, homeObj.normal]))), 96, r, 8, false);
        ex.radius = r;
      }
    }
  }
  for (const [k, a] of arcs) if (!groups.has(k) && !a.dying) a.dying = now;
  applyVisibility();
}

function applyVisibility() {
  for (const a of arcs.values()) {
    const vis = a.items.some(visibleConn);
    a.visible = vis;
  }
}

/* ---------------- list & stats ---------------- */
const listEl = $('#list');
const fmtAge = (t) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - t));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
};
const flag = (cc) => (cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
const locText = (c) => (c.lan ? 'local network' : c.lat == null ? 'unknown location' : [c.city, c.country].filter(Boolean).join(', ') || '—');
const STATE = { ESTABLISHED: 'ACTIVE', SYN_SENT: 'SYN', TIME_WAIT: 'TIME_WAIT', CLOSE_WAIT: 'CLOSE_WAIT', NONE: 'UDP', '': '' };

function renderList() {
  const rows = snapshot.conns.filter(visibleConn).sort((a, b) => (b.first - a.first));
  const html = rows.slice(0, 400).map((c) => {
    const k = c.lan || c.lat == null ? '' : groupKey(c);
    return `<div class="row ${c.lan ? 'lan' : c.dir}${newIds.has(c.id) ? ' new' : ''}${k && k === hlRowKey ? ' hl' : ''}" data-k="${esc(k)}">
      <span class="bar"></span>
      <div class="main">
        <div class="p">${esc(c.proc)}</div>
        <div class="a">${c.dir === 'in' ? '←' : '→'} ${esc(c.rip)}:${c.rport}</div>
        <div class="loc">${flag(c.cc)} ${esc(locText(c))}</div>
      </div>
      <div class="meta"><div class="st">${esc(STATE[c.state] ?? c.state)}</div><div>${fmtAge(c.first)}</div></div>
    </div>`;
  }).join('');
  listEl.innerHTML = html || `<div class="empty">No connections match this filter.</div>`;
  const st = snapshot.stats || {};
  $('#list-foot').textContent = `${rows.length} shown · ${st.lan || 0} on local network${st.unknown ? ` · ${st.unknown} without location` : ''}`;

  const pub = snapshot.conns.filter((c) => !c.lan);
  $('#n-in').textContent = pub.filter((c) => c.dir === 'in').length;
  $('#n-out').textContent = pub.filter((c) => c.dir === 'out').length;
  $('#n-cc').textContent = new Set(pub.map((c) => c.cc).filter(Boolean)).size;
  $('#n-proc').textContent = new Set(snapshot.conns.map((c) => c.proc)).size;
}

listEl.addEventListener('mouseover', (e) => {
  const r = e.target.closest('.row'); hlRowKey = r?.dataset.k || null;
});
listEl.addEventListener('mouseleave', () => { hlRowKey = null; });
listEl.addEventListener('click', (e) => {
  const r = e.target.closest('.row'); const a = r && arcs.get(r.dataset.k);
  if (a) { pinned = a; focusOn(a.lat, a.lon); }
});

document.querySelectorAll('.seg button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x === b));
  filter = b.dataset.f; applyVisibility(); renderList();
}));
$('#search').addEventListener('input', (e) => { search = e.target.value.trim().toLowerCase(); applyVisibility(); renderList(); });
$('#show-lan').addEventListener('change', (e) => { showLan = e.target.checked; applyVisibility(); renderList(); });
$('#collapse').addEventListener('click', () => $('#panel').classList.toggle('collapsed'));
$('#btn-home').addEventListener('click', () => home?.lat != null && focusOn(home.lat, home.lon));
$('#btn-rotate').addEventListener('click', (e) => { view.auto = !view.auto; e.currentTarget.classList.toggle('on', view.auto); });
$('#btn-pause').addEventListener('click', (e) => { paused = !paused; e.currentTarget.classList.toggle('on', paused); if (!paused && pendingSnap) ingest(pendingSnap); });

/* ---------------- incoming data ---------------- */
let pendingSnap = null;
function ingest(snap) {
  if (paused) { pendingSnap = snap; return; }
  pendingSnap = null;
  const ids = new Set(snap.conns.map((c) => c.id));
  newIds = new Set([...ids].filter((i) => !lastIds.has(i)));
  if (lastIds.size === 0) newIds.clear();
  lastIds = ids;
  if (snap.home && (!home || snap.home.lat !== home.lat || snap.home.lon !== home.lon)) {
    const first = !home;
    home = snap.home; buildHome();
    for (const a of arcs.values()) disposeArc(a);
    arcs.clear();
    $('#home-text').textContent = home.lat == null ? 'unknown location — see config.json'
      : `${[home.city, home.country].filter(Boolean).join(', ') || 'my location'}${home.ip ? ` · ${home.ip}` : ''}`;
    if (first && home.lat != null) focusOn(home.lat, home.lon, 1800);
  }
  snapshot = snap;
  syncArcs();
  renderList();
}

function setStatus(kind, text) {
  $('#status-dot').className = `dot ${kind}`;
  $('#status-text').textContent = text;
}

function connect() {
  if (params.has('demo') || location.protocol === 'file:') return startDemo();
  let got = false;
  const es = new EventSource('events');
  const fallback = setTimeout(() => { if (!got) { es.close(); startDemo(); } }, 3000);
  es.onmessage = (e) => {
    if (!got) { got = true; clearTimeout(fallback); }
    setStatus('live', 'live · updates every 1s');
    ingest(JSON.parse(e.data));
  };
  es.onerror = () => { if (got) setStatus('off', 'disconnected — retrying…'); };
}

/* ---------------- demo mode (no server) ---------------- */
function startDemo() {
  setStatus('demo', 'demo — run server.py for real data');
  const H = { ip: '203.0.113.7', lat: 38.7223, lon: -9.1393, city: 'Lisbon', country: 'Portugal', cc: 'PT' };
  const places = [
    ['Frankfurt', 'Germany', 'DE', 50.11, 8.68], ['Paris', 'France', 'FR', 48.86, 2.35], ['Amsterdam', 'Netherlands', 'NL', 52.37, 4.9],
    ['Ashburn', 'United States', 'US', 39.04, -77.49], ['San Jose', 'United States', 'US', 37.34, -121.89], ['Seattle', 'United States', 'US', 47.61, -122.33],
    ['Dallas', 'United States', 'US', 32.78, -96.8], ['Miami', 'United States', 'US', 25.76, -80.19], ['New York', 'United States', 'US', 40.71, -74.0],
    ['London', 'United Kingdom', 'GB', 51.51, -0.13], ['Dublin', 'Ireland', 'IE', 53.35, -6.26], ['Bucharest', 'Romania', 'RO', 44.43, 26.1],
    ['Cluj-Napoca', 'Romania', 'RO', 46.77, 23.6], ['Tokyo', 'Japan', 'JP', 35.68, 139.69], ['Singapore', 'Singapore', 'SG', 1.35, 103.82],
    ['São Paulo', 'Brazil', 'BR', -23.55, -46.63], ['Sydney', 'Australia', 'AU', -33.87, 151.21], ['Montréal', 'Canada', 'CA', 45.5, -73.57],
    ['Stockholm', 'Sweden', 'SE', 59.33, 18.07], ['Mumbai', 'India', 'IN', 19.08, 72.88], ['Johannesburg', 'South Africa', 'ZA', -26.2, 28.05],
    ['Pointe-à-Pitre', 'Guadeloupe', 'GP', 16.24, -61.53], ['Bogotá', 'Colombia', 'CO', 4.71, -74.07], ['Seoul', 'South Korea', 'KR', 37.57, 126.98],
  ];
  const outProcs = [['chrome.exe', 443], ['msedge.exe', 443], ['Discord.exe', 443], ['steam.exe', 27036], ['Spotify.exe', 4070], ['OneDrive.exe', 443],
    ['svchost.exe', 443], ['Code.exe', 443], ['python.exe', 443], ['Teams.exe', 3478], ['thunderbird.exe', 993], ['git-remote-https.exe', 443]];
  const inProcs = [['qbittorrent.exe', 51413], ['sshd.exe', 22], ['nginx.exe', 8080], ['TeamViewer.exe', 5938]];
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const ip = () => `${2 + Math.floor(Math.random() * 220)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${1 + Math.floor(Math.random() * 254)}`;
  let conns = [];
  const add = (dir) => {
    const p = rnd(places); const [proc, port] = dir === 'out' ? rnd(outProcs) : rnd(inProcs);
    const now = Date.now() / 1000;
    const rp = dir === 'out' ? port : 1024 + Math.floor(Math.random() * 60000);
    const lp = dir === 'out' ? 49152 + Math.floor(Math.random() * 16000) : port;
    const r = ip();
    conns.push({ id: `TCP|192.168.1.20|${lp}|${r}|${rp}`, dir, proto: 'TCP', state: 'ESTABLISHED', lip: '192.168.1.20', lport: lp, rip: r, rport: rp,
      pid: 1000 + Math.floor(Math.random() * 9000), proc, first: now - Math.random() * 400, lan: false,
      lat: p[3] + (Math.random() - 0.5) * 0.3, lon: p[4] + (Math.random() - 0.5) * 0.3, city: p[0], country: p[1], cc: p[2], region: '', host: '' });
  };
  for (let i = 0; i < 26; i++) add('out');
  for (let i = 0; i < 5; i++) add('in');
  conns.push({ id: 'TCP|192.168.1.20|445|192.168.1.12|51022', dir: 'in', proto: 'TCP', state: 'ESTABLISHED', lip: '192.168.1.20', lport: 445, rip: '192.168.1.12', rport: 51022, pid: 4, proc: 'System', first: Date.now() / 1000 - 900, lan: true });
  const push = () => {
    const pub = conns.filter((c) => !c.lan);
    ingest({ t: Date.now() / 1000, home: H, conns: conns.slice(), stats: { in: pub.filter((c) => c.dir === 'in').length, out: pub.filter((c) => c.dir === 'out').length, lan: conns.length - pub.length, unknown: 0 } });
  };
  push();
  setInterval(() => {
    if (Math.random() < 0.55 && conns.length > 18) conns.splice(1 + Math.floor(Math.random() * (conns.length - 1)), 1);
    if (Math.random() < 0.6) add(Math.random() < 0.18 ? 'in' : 'out');
    push();
  }, 2200);
}

/* ---------------- hover / tooltip ---------------- */
const mouse = { x: -1e4, y: -1e4, dirty: false };
const ray = new THREE.Raycaster();
const tip = $('#tip');
let globeMesh = null;
const globeSphere = new THREE.Sphere(new THREE.Vector3(), R + DISP * 0.3);
let frameN = 0;

function pick() {
  if (drag) return null;
  const ndc = new THREE.Vector2((mouse.x / innerWidth) * 2 - 1, -(mouse.y / innerHeight) * 2 + 1);
  if (Math.abs(ndc.x) > 1.2) return null;
  ray.setFromCamera(ndc, camera);
  const objs = [];
  for (const a of arcs.values()) if (a.visible && !a.dying) objs.push(a.hit, a.tube);
  ray.params.Mesh = {};
  const hits = ray.intersectObjects(objs, false);
  if (!hits.length) return null;
  const gp = ray.ray.intersectSphere(globeSphere, new THREE.Vector3());
  const gDist = gp ? gp.distanceTo(ray.ray.origin) : Infinity;
  for (const h of hits) {
    if (h.distance > gDist + 0.03) continue;
    return h.object.userData.arc;
  }
  return null;
}

function showTip(a) {
  if (!a) { tip.hidden = true; return; }
  const items = a.items.filter(visibleConn);
  const procs = [...new Set(items.map((c) => c.proc))];
  tip.innerHTML = `
    <div class="t-head"><span class="sw ${a.dir}"></span>${a.dir === 'in' ? 'Inbound' : 'Outbound'} · ${esc(procs.slice(0, 3).join(', '))}${procs.length > 3 ? '…' : ''}</div>
    <div class="t-loc">${flag(a.cc)} ${esc([a.city, a.region, a.country].filter(Boolean).join(', '))}</div>
    ${items.slice(0, 7).map((c) => `<div class="t-item"><b>${esc(c.proc)}</b><span>${esc(c.rip)}:${c.rport}</span></div>`).join('')}
    ${items.length > 7 ? `<div class="t-item">+ ${items.length - 7} more</div>` : ''}
    ${items[0]?.host ? `<div class="t-host">${esc(items[0].host)}</div>` : ''}`;
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = mouse.x + 16, y = mouse.y + 16;
  if (x + w > innerWidth - 10) x = mouse.x - w - 16;
  if (y + h > innerHeight - 10) y = mouse.y - h - 16;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}

/* ---------------- HTML labels ---------------- */
const labelsEl = $('#labels');
const homeLbl = Object.assign(document.createElement('div'), { className: 'lbl3d home' });
const selLbl = Object.assign(document.createElement('div'), { className: 'lbl3d' });
labelsEl.append(homeLbl, selLbl);
const tmpV = new THREE.Vector3();
function placeLabel(el, normal, r, text) {
  if (!normal) { el.style.opacity = 0; return; }
  tmpV.copy(normal).multiplyScalar(r).applyMatrix4(world.matrixWorld);
  const facing = tmpV.clone().normalize().dot(camera.position.clone().sub(tmpV).normalize());
  tmpV.project(camera);
  el.textContent = text;
  el.style.opacity = facing > 0.15 ? 1 : 0;
  el.style.transform = `translate(${(tmpV.x * 0.5 + 0.5) * innerWidth}px, ${(-tmpV.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -160%)`;
}

/* ---------------- backdrop (CSS shadow & glow) ---------------- */
const glowEl = $('#glow'), shadowEl = $('#shadow');
function placeBackdrop() {
  const s = (CAM_Z / view.zoom) * (innerHeight / 900);
  glowEl.style.transform = `translate(${60 * s}px, ${30 * s}px) scale(${s})`;
  shadowEl.style.transform = `translate(${140 * s}px, ${170 * s}px) scale(${s})`;
}

/* ---------------- loop ---------------- */
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  // on narrow screens the camera backs off (see frame)
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
function frame() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const now = performance.now();

  // rotation
  if (view.anim) {
    const k = Math.min(1, (now - view.anim.t0) / view.anim.ms), e = ease(k);
    view.lon = view.anim.from.lon + (view.anim.to.lon - view.anim.from.lon) * e;
    view.lat = view.anim.from.lat + (view.anim.to.lat - view.anim.from.lat) * e;
    if (k >= 1) { view.anim = null; view.idle = 0; }
  } else if (!drag) {
    view.lon += view.vLon; view.lat = THREE.MathUtils.clamp(view.lat + view.vLat, -1.3, 1.3);
    view.vLon *= 0.93; view.vLat *= 0.93;
    view.idle += dt;
    if (view.auto && view.idle > 5 && !pinned) view.lon += dt * 0.045 * Math.min(1, (view.idle - 5) / 2);
  }
  world.rotation.set(view.lat, view.lon, 0, 'XYZ');
  view.zoom += (view.zoomT - view.zoom) * 0.12;
  camera.position.z = view.zoom * (camera.aspect < 0.8 ? 1.5 : 1);
  placeBackdrop();
  world.updateMatrixWorld();

  // hover
  if (mouse.dirty || (++frameN % 8 === 0 && !drag)) {
    hovered = pick(); mouse.dirty = false;
    canvas.classList.toggle('hovering', !!hovered);
    showTip(hovered);
  }
  const focus = hovered || pinned || (hlRowKey && arcs.get(hlRowKey)) || null;

  // arcs
  for (const [k, a] of arcs) {
    const u = a.mat.uniforms;
    u.uTime.value = t;
    const age = (now - a.born) / 1000;
    u.uDraw.value = Math.min(1, ease(Math.min(1, age / 1.1)) * 1.001);
    let alpha = a.visible ? 1 : 0;
    if (a.dying) {
      const d = (now - a.dying) / 800;
      alpha *= Math.max(0, 1 - d);
      if (d >= 1) { disposeArc(a); arcs.delete(k); continue; }
    }
    u.uAlpha.value += (alpha - u.uAlpha.value) * 0.15;
    const isF = focus === a;
    u.uHi.value += ((isF ? 1 : 0) - u.uHi.value) * 0.2;
    u.uDim.value += ((focus && !isF ? 1 : 0) - u.uDim.value) * 0.15;
    a.tube.visible = u.uAlpha.value > 0.01;
    a.dot.material.opacity = u.uAlpha.value * (1 - 0.7 * u.uDim.value);
    a.dot.visible = a.tube.visible;
    // ping on appearance (+ periodic echo)
    const ph = age < 1.6 ? age / 1.6 : ((t + a.mat.uniforms.uSeed.value * 4) % 4) / 1.6;
    const pk = Math.min(1, ph);
    a.ring.scale.setScalar(0.012 + pk * (age < 1.6 ? 0.07 : 0.035));
    a.ring.material.opacity = (1 - pk) * (age < 1.6 ? 0.9 : 0.45) * u.uAlpha.value * (1 - 0.8 * u.uDim.value);
    a.ring.visible = a.tube.visible && pk < 1;
  }

  // home marker
  if (homeObj) {
    homeObj.rings.forEach((m, i) => {
      const p = ((t * 0.45 + i / 3) % 1);
      m.scale.setScalar(0.018 + p * 0.07);
      m.material.opacity = (1 - p) * 0.5;
    });
    placeLabel(homeLbl, homeObj.normal, R + DISP + 0.005, home.city ? `You · ${home.city}` : 'You');
  } else homeLbl.style.opacity = 0;
  const lab = hovered ? null : (pinned || (hlRowKey && arcs.get(hlRowKey)));
  if (lab && !lab.dying) placeLabel(selLbl, lab.normal, R + DISP + 0.005, `${flag(lab.cc)} ${lab.city || lab.country || ''} · ${lab.items.length}`);
  else selLbl.style.opacity = 0;

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// re-render list periodically (connection ages)
setInterval(() => { if (!paused) renderList(); }, 5000);

buildGlobe().then((g) => {
  globeMesh = g;
  $('#loading').classList.add('done');
  connect();
}).catch((e) => {
  $('#loading').textContent = 'Could not load textures. Open the app through server.py (not directly from the file).';
  console.error(e);
});
requestAnimationFrame(frame);

// handle for debugging from the console
window.__radar = { arcs, world, camera, THREE };
