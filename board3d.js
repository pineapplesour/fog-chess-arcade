// Board3D — 안개 체스의 VHS 3D 프레젠테이션.
// "감시 카메라가 내려다보는 야간 전장 테이블" — 안개는 칸 위에 실제로 서 있는
// 반투명 기둥이고, 시야가 열리면 안개가 걷힌다. 렌더는 저해상 내부 버퍼에
// AGC 자동노출 → 렌즈(배럴/색수차/모션블러) → YIQ VHS 신호열화 → 잔상 순서로
// 통과한다 (vhs-village-1996 / over-the-top에서 검증된 파이프라인 이식).
import * as THREE from './js/three.module.js';

const IW = 640, IH = 480;

function n1(t, s) {
  return Math.sin(t * 1.7 + s * 12.9) * 0.55 + Math.sin(t * 3.1 + s * 71.3) * 0.3 + Math.sin(t * 6.7 + s * 31.7) * 0.15;
}

class Board3D {
  constructor(engine) {
    this.engine = engine;
    this.selectedSquare = null;
    this.onMove = null;
    this.playerColor = 'white';
    this.isEnabled = false;
    this.visibleSet = new Set();
    this.flareSet = new Set();
    this.showVisOnlyOnTurn = false;
    this.hud = { score: 0, combo: 0, diff: '' };
    this.bannerText = ''; this.bannerT = 0;
    this.trackBurst = 1.2;
    this.revealMode = false;
    this._initGL();
    this._initScene();
    this._initPost();
    this._bindInput();
    this.setupBoard();
    this._animate = this._animate.bind(this);
    this.clock = new THREE.Clock();
    this.simT = 0;
    requestAnimationFrame(this._animate);
  }

  /* ---------------------------------- GL ---------------------------------- */
  _initGL() {
    this.canvas = document.getElementById('c3d');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(1);
    const fit = () => {
      const box = this.canvas.parentElement.getBoundingClientRect();
      let w = box.width, h = Math.round(w * 3 / 4);
      const maxH = window.innerHeight - 24;
      if (h > maxH) { h = maxH; w = Math.round(h * 4 / 3); }
      this.renderer.setSize(w, h, false);
      this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    };
    window.addEventListener('resize', fit); setTimeout(fit, 0); fit();
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x11140f, 0.055);
    this.camera = new THREE.PerspectiveCamera(52, 4 / 3, 0.1, 80);
    // 낮고 가까운 시점 — 판에 눈을 붙이고 안개 너머를 넘겨다보는 자세
    this.camRig = { yaw: 0, pitch: 0, dist: 7.1, height: 3.05, drift: 0, look: 0.5 };
    this.userYaw = 0; this.userPitch = 0;

    const key = new THREE.DirectionalLight(0xcfd6c2, 1.5);
    key.position.set(5, 11, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -7; key.shadow.camera.right = 7;
    key.shadow.camera.top = 7; key.shadow.camera.bottom = -7;
    key.shadow.camera.near = 3; key.shadow.camera.far = 30;
    key.shadow.bias = -0.0005;
    this.scene.add(key);
    this.scene.add(new THREE.HemisphereLight(0x3d443b, 0x100e0b, 0.6));
    this.scene.add(new THREE.AmbientLight(0x1e201c, 0.42));
    // 천천히 도는 탐조등
    this.sweep = new THREE.SpotLight(0xd8e0c8, 34, 30, 0.42, 0.55, 1.4);
    this.sweep.position.set(0, 12, 0);
    this.sweep.castShadow = false;
    const sweepTgt = new THREE.Object3D(); this.scene.add(sweepTgt);
    this.sweep.target = sweepTgt; this.sweepTgt = sweepTgt;
    this.scene.add(this.sweep);

    // 테이블/받침
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(10.4, 0.9, 10.4),
      new THREE.MeshStandardMaterial({ color: 0x241f18, roughness: 0.9 }));
    plinth.position.y = -0.57; plinth.receiveShadow = true;
    this.scene.add(plinth);
    const rim = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.16, 9.2),
      new THREE.MeshStandardMaterial({ color: 0x3a332a, roughness: 0.8 }));
    rim.position.y = -0.09; rim.receiveShadow = true;
    this.scene.add(rim);
    // 바닥 어둠
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80),
      new THREE.MeshStandardMaterial({ color: 0x0c0e0a, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2; ground.position.y = -1.02; ground.receiveShadow = true;
    this.scene.add(ground);

    this.groups = {
      tiles: new THREE.Group(), pieces: new THREE.Group(), fog: new THREE.Group(),
      marks: new THREE.Group(),
    };
    Object.values(this.groups).forEach(g => this.scene.add(g));
    this.raycaster = new THREE.Raycaster();
  }

  sq2pos(row, col) { return { x: col - 3.5, z: row - 3.5 }; }

  /* ------------------------------ FX 텍스처/입자 ---------------------------- */
  _fxTex(kind) {
    this._fxCache = this._fxCache || {};
    if (this._fxCache[kind]) return this._fxCache[kind];
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    if (kind === 'flash') {
      const gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
      gr.addColorStop(0, 'rgba(255,246,214,1)');
      gr.addColorStop(0.3, 'rgba(255,196,110,0.8)');
      gr.addColorStop(1, 'rgba(255,150,50,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    } else if (kind === 'smoke') {
      const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
      gr.addColorStop(0, 'rgba(180,180,172,0.55)');
      gr.addColorStop(0.6, 'rgba(150,150,144,0.22)');
      gr.addColorStop(1, 'rgba(140,140,134,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    } else if (kind === 'dust') {
      const gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
      gr.addColorStop(0, 'rgba(200,196,180,0.42)');
      gr.addColorStop(1, 'rgba(190,186,170,0)');
      g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    }
    const t = new THREE.CanvasTexture(cv);
    this._fxCache[kind] = t;
    return t;
  }

  _spawnFx(obj, vel, life, opts = {}) {
    this._fx = this._fx || [];
    this.scene.add(obj);
    this._fx.push(Object.assign({ o: obj, vel, life, age: 0, grow: 0, spin: null, gravity: -9 }, opts));
  }

  _updateFx(dt) {
    if (!this._fx) return;
    for (let i = this._fx.length - 1; i >= 0; i--) {
      const p = this._fx[i];
      p.age += dt;
      if (p.age >= p.life) { this.scene.remove(p.o); this._fx.splice(i, 1); continue; }
      p.o.position.addScaledVector(p.vel, dt);
      p.vel.y += p.gravity * dt;
      if (p.o.position.y < 0.16 && p.gravity < 0) { p.o.position.y = 0.16; p.vel.y *= -0.35; p.vel.x *= 0.6; p.vel.z *= 0.6; }
      if (p.spin) { p.o.rotation.x += p.spin.x * dt; p.o.rotation.y += p.spin.y * dt; p.o.rotation.z += p.spin.z * dt; }
      const k = p.age / p.life;
      if (p.grow) p.o.scale.multiplyScalar(1 + p.grow * dt);
      if (p.o.material) p.o.material.opacity = (p.op0 !== undefined ? p.op0 : 1) * (1 - k * k);
      if (p.o.isSprite && p.rise) p.o.position.y += p.rise * dt;
    }
  }

  /* --------------------------------- 폭발 ---------------------------------- */
  explode(row, col, big = 1) {
    const p = this.sq2pos(row, col);
    const at = new THREE.Vector3(p.x, 0.34, p.z);
    // 섬광
    const flash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._fxTex('flash'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 1,
    }));
    flash.position.copy(at); flash.scale.setScalar(0.7 * big);
    this._spawnFx(flash, new THREE.Vector3(0, 0.2, 0), 0.32, { grow: 7 * big, gravity: 0, op0: 1 });
    // 파편
    for (let i = 0; i < 14; i++) {
      const s = 0.05 + Math.random() * 0.07;
      const d = new THREE.Mesh(new THREE.BoxGeometry(s, s, s),
        new THREE.MeshStandardMaterial({ color: i % 3 ? 0x2b2724 : 0x6b5f4d, roughness: 0.9 }));
      d.position.copy(at);
      d.castShadow = true;
      const a = Math.random() * 6.28, sp = 1.4 + Math.random() * 2.6 * big;
      this._spawnFx(d, new THREE.Vector3(Math.cos(a) * sp * 0.6, 2.2 + Math.random() * 2.4 * big, Math.sin(a) * sp * 0.6), 1.1 + Math.random() * 0.5, {
        spin: new THREE.Vector3((Math.random() - .5) * 14, (Math.random() - .5) * 14, (Math.random() - .5) * 14),
      });
    }
    // 불티
    for (let i = 0; i < 10; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this._fxTex('flash'), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.9, color: 0xffb457,
      }));
      sp.position.copy(at); sp.scale.setScalar(0.1);
      const a = Math.random() * 6.28;
      this._spawnFx(sp, new THREE.Vector3(Math.cos(a) * 2.4, 1.6 + Math.random() * 2.6, Math.sin(a) * 2.4), 0.6 + Math.random() * 0.4, { gravity: -5, op0: 0.9 });
    }
    // 연기
    for (let i = 0; i < 5; i++) {
      const sm = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._fxTex('smoke'), transparent: true, depthWrite: false, opacity: 0.5 }));
      sm.position.copy(at).add(new THREE.Vector3((Math.random() - .5) * 0.4, i * 0.12, (Math.random() - .5) * 0.4));
      sm.scale.setScalar(0.5 + i * 0.15);
      this._spawnFx(sm, new THREE.Vector3((Math.random() - .5) * 0.5, 0.7 + Math.random() * 0.5, (Math.random() - .5) * 0.5), 1.6 + Math.random() * 0.6, { grow: 1.6, gravity: 0.3, op0: 0.5 });
    }
    // 섬광 라이트
    if (!this._boomLight) {
      this._boomLight = new THREE.PointLight(0xffb060, 0, 12, 2);
      this.scene.add(this._boomLight);
    }
    this._boomLight.position.copy(at).add(new THREE.Vector3(0, 0.5, 0));
    this._boomLight.intensity = 26 * big;
    this._boomT = 1;
    this.kick(0.75 * big);
    this.trackBurst = Math.max(this.trackBurst, 0.9 * big);
  }

  /* ------------------------- 월드 공간 점수 팝업 --------------------------- */
  worldPopup(row, col, text, color = '#ffd76a') {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 96;
    const g = cv.getContext('2d');
    g.font = "bold 54px 'Courier New', monospace";
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 7; g.strokeStyle = 'rgba(8,10,6,0.85)';
    g.strokeText(text, 128, 50);
    g.fillStyle = color;
    g.fillText(text, 128, 50);
    const tex = new THREE.CanvasTexture(cv);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 1 }));
    const p = this.sq2pos(row, col);
    sp.position.set(p.x, 0.9, p.z);
    sp.scale.set(1.5, 0.56, 1);
    sp.renderOrder = 20;
    this._spawnFx(sp, new THREE.Vector3(0, 0.9, 0), 1.25, { gravity: -0.5, op0: 1 });
  }

  setupBoard() {
    // 타일
    this.tiles = [];
    const matL = new THREE.MeshStandardMaterial({ color: 0x7d7666, roughness: 0.85 });
    const matD = new THREE.MeshStandardMaterial({ color: 0x3f3a30, roughness: 0.9 });
    for (let r = 0; r < 8; r++) {
      this.tiles.push([]);
      for (let c = 0; c < 8; c++) {
        const light = (r + c) % 2 === 0;
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.97, 0.14, 0.97), (light ? matL : matD).clone());
        const p = this.sq2pos(r, c);
        m.position.set(p.x, 0.07, p.z);
        m.receiveShadow = true;
        m.userData = { row: r, col: c, base: light ? 0x7d7666 : 0x3f3a30 };
        this.groups.tiles.add(m);
        this.tiles[r].push(m);
      }
    }
    // 안개 기둥 (칸마다 하나, 보이면 opacity→0)
    this.fogBlocks = [];
    const fogGeo = new THREE.BoxGeometry(0.99, 1.12, 0.99);
    for (let r = 0; r < 8; r++) {
      this.fogBlocks.push([]);
      for (let c = 0; c < 8; c++) {
        const fm = new THREE.MeshStandardMaterial({
          color: 0x4a5347, roughness: 1, transparent: true, opacity: 0.68, depthWrite: false,
        });
        const f = new THREE.Mesh(fogGeo, fm);
        const p = this.sq2pos(r, c);
        f.position.set(p.x, 0.7, p.z);
        f.userData = { phase: Math.random() * 6.28, target: 0.68 };
        f.renderOrder = 5;
        this.groups.fog.add(f);
        this.fogBlocks[r].push(f);
      }
    }
    this.refreshFog();
    this.renderPieces();
  }

  /* -------------------------------- 기물 빌더 ------------------------------ */
  _pieceMat(color) {
    return new THREE.MeshStandardMaterial({
      color: color === 'white' ? 0xcfc6ae : 0x1f1d18,
      roughness: color === 'white' ? 0.55 : 0.4,
      metalness: 0.08,
    });
  }
  _buildPiece(type, color) {
    const g = new THREE.Group();
    const m = this._pieceMat(color);
    const add = (geo, y, sx = 1, sy = 1, sz = 1, rx = 0, rz = 0) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.y = y; mesh.scale.set(sx, sy, sz); mesh.rotation.x = rx; mesh.rotation.z = rz;
      mesh.castShadow = true;
      g.add(mesh); return mesh;
    };
    add(new THREE.CylinderGeometry(0.3, 0.34, 0.12, 14), 0.06);       // 공통 받침
    switch (type) {
      case 'pawn':
        add(new THREE.CylinderGeometry(0.13, 0.24, 0.3, 10), 0.25);
        add(new THREE.SphereGeometry(0.16, 10, 8), 0.52);
        break;
      case 'rook':
        add(new THREE.CylinderGeometry(0.21, 0.26, 0.5, 10), 0.36);
        add(new THREE.CylinderGeometry(0.26, 0.26, 0.1, 10), 0.65);
        for (let i = 0; i < 4; i++) {
          const b = add(new THREE.BoxGeometry(0.1, 0.12, 0.1), 0.76);
          b.position.x = Math.cos(i * Math.PI / 2) * 0.18;
          b.position.z = Math.sin(i * Math.PI / 2) * 0.18;
        }
        break;
      case 'knight':
        add(new THREE.CylinderGeometry(0.17, 0.25, 0.34, 10), 0.28);
        add(new THREE.BoxGeometry(0.2, 0.42, 0.3), 0.62, 1, 1, 1, 0.5);
        add(new THREE.BoxGeometry(0.18, 0.18, 0.26), 0.82, 1, 1, 1, 0.15);
        break;
      case 'bishop':
        add(new THREE.CylinderGeometry(0.14, 0.25, 0.4, 10), 0.3);
        add(new THREE.ConeGeometry(0.19, 0.5, 10), 0.72);
        add(new THREE.SphereGeometry(0.06, 8, 6), 1.0);
        break;
      case 'queen':
        add(new THREE.CylinderGeometry(0.16, 0.27, 0.5, 10), 0.36);
        add(new THREE.ConeGeometry(0.24, 0.5, 10), 0.82);
        for (let i = 0; i < 5; i++) {
          const s = add(new THREE.SphereGeometry(0.05, 6, 5), 1.06);
          s.position.x = Math.cos(i * Math.PI * 2 / 5) * 0.14;
          s.position.z = Math.sin(i * Math.PI * 2 / 5) * 0.14;
        }
        break;
      case 'king':
        add(new THREE.CylinderGeometry(0.18, 0.28, 0.56, 10), 0.4);
        add(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 10), 0.73);
        add(new THREE.BoxGeometry(0.07, 0.3, 0.07), 0.95);
        add(new THREE.BoxGeometry(0.22, 0.07, 0.07), 1.0);
        break;
    }
    return g;
  }

  renderPieces() {
    // 전부 다시 그린다 (32개 이하 — 충분히 싸다)
    while (this.groups.pieces.children.length) {
      const ch = this.groups.pieces.children.pop();
      this.groups.pieces.remove(ch);
    }
    this.pieceAt = {};
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const piece = this.engine.getPiece(r, c);
      if (!piece) continue;
      const isOwn = piece.color === this.playerColor;
      if (!(isOwn || this.revealMode || this.visibleSet.has(`${r},${c}`))) continue;
      const g = this._buildPiece(piece.type, piece.color);
      const p = this.sq2pos(r, c);
      g.position.set(p.x, 0.14, p.z);
      g.userData = { row: r, col: c };
      this.groups.pieces.add(g);
      this.pieceAt[`${r},${c}`] = g;
    }
  }

  refreshFog() {
    if (this.showVisOnlyOnTurn && this.engine.turn !== this.playerColor) return;
    const vis = this.engine.getVisibleSet(this.playerColor);
    this.flareSet.forEach(k => vis.add(k));
    this.visibleSet = vis;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const f = this.fogBlocks[r][c];
      const seen = this.revealMode || vis.has(`${r},${c}`);
      f.userData.target = seen ? 0 : 0.68;
    }
    this._rebuildLastMarks();   // 시야가 바뀌면 흔적도 다시 판정한다
  }

  revealAll() {
    this.revealMode = true;
    const all = new Set();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) all.add(`${r},${c}`);
    this.visibleSet = all;
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) this.fogBlocks[r][c].userData.target = 0;
    this.renderPieces();
  }

  /* ------------------------------ 하이라이트 ------------------------------- */
  _mark(row, col, color, y = 0.16, scale = 0.42) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(scale, scale, 0.03, 14),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, depthWrite: false }));
    const p = this.sq2pos(row, col);
    m.position.set(p.x, y, p.z);
    m.renderOrder = 3;
    this.groups.marks.add(m);
    return m;
  }
  highlightMoves(row, col) {
    this.clearHighlights();
    this._sel = this._mark(row, col, 0x9fd0ff, 0.16, 0.5);
    const moves = this.engine.getLegalMovesForPiece(row, col);
    moves.forEach(mv => this._mark(mv.to.row, mv.to.col, 0xf2e28a, 0.16, 0.2));
  }
  clearSelection() { this.selectedSquare = null; this.clearHighlights(); }
  clearHighlights() {
    while (this.groups.marks.children.length) {
      const ch = this.groups.marks.children.pop();
      this.groups.marks.remove(ch);
    }
    if (this._lastMarks) this._lastMarks.forEach(m => this.groups.marks.add(m));
  }
  clearLastMoveHighlight() { this._lastMarks = null; this._lastMoveSq = null; this.clearHighlights(); }
  // 안개 준수: 내가 볼 수 없는 칸에는 흔적을 남기지 않는다.
  // (이걸 빼먹으면 상대가 둔 자리가 안개 속에서도 드러나 게임이 무너진다)
  highlightLastMove(from, to) {
    this._lastMoveSq = { from, to };
    this._rebuildLastMarks();
  }
  _rebuildLastMarks() {
    if (this._lastMarks) this._lastMarks.forEach(m => this.groups.marks.remove(m));
    this._lastMarks = null;
    const sq = this._lastMoveSq;
    if (!sq) return;
    const seen = (r, c) => this.revealMode || this.visibleSet.has(`${r},${c}`);
    const marks = [];
    if (seen(sq.from.row, sq.from.col)) marks.push(this._mark(sq.from.row, sq.from.col, 0x86a34c, 0.155, 0.46));
    if (seen(sq.to.row, sq.to.col)) marks.push(this._mark(sq.to.row, sq.to.col, 0x86a34c, 0.155, 0.46));
    this._lastMarks = marks.length ? marks : null;
  }
  pulseSquare(row, col, color = 0xff4433) {
    const m = this._mark(row, col, color, 0.17, 0.5);
    m.material.opacity = 0.8;
    setTimeout(() => { this.groups.marks.remove(m); }, 1200);
  }

  // 스스륵 미끄러져 가서 쿵 내려앉는다 — 착지 순간 onImpact 호출
  async animateMove(move, onImpact) {
    const { from, to } = move;
    this.highlightLastMove(from, to);
    const g = this.pieceAt[`${from.row},${from.col}`];
    if (!g) { if (onImpact) onImpact(); return; }
    const a = this.sq2pos(from.row, from.col), b = this.sq2pos(to.row, to.col);
    const dist = Math.hypot(b.x - a.x, b.z - a.z);
    const glideMs = 210 + dist * 34;      // 멀수록 조금 더 길게 미끄러진다
    const dropMs = 130;
    const t0 = performance.now();
    // 1) 살짝 들려서 미끄러진다 (ease-in-out)
    await new Promise(res => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / glideMs);
        const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
        g.position.x = a.x + (b.x - a.x) * e;
        g.position.z = a.z + (b.z - a.z) * e;
        g.position.y = 0.14 + Math.sin(k * Math.PI) * 0.16 + 0.06 * (1 - Math.abs(k * 2 - 1));
        g.rotation.z = Math.sin(k * Math.PI) * 0.06 * (b.x > a.x ? -1 : 1);
        if (k < 1) requestAnimationFrame(step); else res();
      };
      step();
    });
    // 2) 쿵 — 내려찍고 눌렸다 펴진다
    const tD = performance.now();
    if (onImpact) setTimeout(onImpact, dropMs * 0.55);
    await new Promise(res => {
      const step = () => {
        const k = Math.min(1, (performance.now() - tD) / dropMs);
        const drop = 1 - Math.pow(1 - k, 3);
        g.position.y = 0.14 + 0.2 * (1 - drop);
        const squash = k < 0.55 ? 1 : 1 - Math.sin((k - 0.55) / 0.45 * Math.PI) * 0.13;
        g.scale.set(1 + (1 - squash) * 0.7, squash, 1 + (1 - squash) * 0.7);
        g.rotation.z *= 0.82;
        if (k < 1) requestAnimationFrame(step);
        else { g.scale.set(1, 1, 1); g.rotation.z = 0; g.position.y = 0.14; res(); }
      };
      step();
    });
    // 착지 먼지
    for (let i = 0; i < 5; i++) {
      const d = new THREE.Sprite(new THREE.SpriteMaterial({ map: this._fxTex('dust'), transparent: true, depthWrite: false, opacity: 0.34 }));
      d.position.set(b.x + (Math.random() - .5) * 0.3, 0.18, b.z + (Math.random() - .5) * 0.3);
      d.scale.setScalar(0.22);
      const ang = Math.random() * 6.28;
      this._spawnFx(d, new THREE.Vector3(Math.cos(ang) * 0.5, 0.25, Math.sin(ang) * 0.5), 0.5, { grow: 2.2, gravity: 0.2, op0: 0.34 });
    }
    this.kick(0.16);
  }

  kick(v = 0.4) { this.trackBurst = Math.max(this.trackBurst, v); this.camRig.drift = 0.12; }
  setHUD(h) { Object.assign(this.hud, h); }
  banner(text, dur = 2.4) { this.bannerText = text; this.bannerT = dur; }

  squareToScreen(row, col, h = 0.35) {
    const p = this.sq2pos(row, col);
    const v = new THREE.Vector3(p.x, h, p.z).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + (v.x * 0.5 + 0.5) * rect.width, y: rect.top + (-v.y * 0.5 + 0.5) * rect.height };
  }

  /* --------------------------------- 입력 ---------------------------------- */
  _bindInput() {
    // 가운데 버튼 드래그 = 시야 이동
    this.canvas.addEventListener('contextmenu', e => e.preventDefault());
    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 1 && e.button !== 2) return;
      e.preventDefault();
      this._drag = { x: e.clientX, y: e.clientY };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.style.cursor = 'grabbing';
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      this.userYaw = Math.max(-0.95, Math.min(0.95, this.userYaw - dx * 0.005));
      this.userPitch = Math.max(-0.06, Math.min(0.85, this.userPitch + dy * 0.0035));
    });
    const endDrag = (e) => {
      if (!this._drag) return;
      this._drag = null;
      this.canvas.style.cursor = '';
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    this.canvas.addEventListener('pointerup', endDrag);
    this.canvas.addEventListener('pointercancel', endDrag);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.camRig.dist = Math.max(4.2, Math.min(11, this.camRig.dist + e.deltaY * 0.004));
    }, { passive: false });

    this.canvas.addEventListener('click', (e) => {
      const hit = this._pick(e);
      if (!hit) return;
      const { row, col } = hit;
      if (this._flareHook && this._flareHook(row, col)) return;
      if (!this.isEnabled || this.engine.turn !== this.playerColor) return;
      const piece = this.engine.getPiece(row, col);
      if (this.selectedSquare) {
        if (piece && piece.color === this.playerColor && !(this.selectedSquare.row === row && this.selectedSquare.col === col)) {
          this.selectedSquare = { row, col };
          this.highlightMoves(row, col);
          return;
        }
        const moves = this.engine.getLegalMovesForPiece(this.selectedSquare.row, this.selectedSquare.col);
        const cands = moves.filter(m => m.to.row === row && m.to.col === col);
        this.clearSelection();
        if (cands.length && this.onMove) {
          this.onMove(cands.find(m => m.promotion === 'queen') || cands[0]);
        }
      } else if (piece && piece.color === this.playerColor) {
        this.selectedSquare = { row, col };
        this.highlightMoves(row, col);
      }
    });
  }
  _pick(e) {
    const rect = this.canvas.getBoundingClientRect();
    let nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    let ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    // 배럴 왜곡 역보정 (포스트에서 0.5+cc*(1+0.055r²+0.04r⁴))
    const r2 = (nx * nx + ny * ny) * 0.25;
    const f = 1 - 0.055 * r2 - 0.04 * r2 * r2;
    nx *= f; ny *= f;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const hits = this.raycaster.intersectObjects([...this.groups.tiles.children, ...this.groups.pieces.children], true);
    for (const h of hits) {
      let o = h.object;
      while (o && o.userData.row === undefined) o = o.parent;
      if (o && o.userData.row !== undefined) return { row: o.userData.row, col: o.userData.col };
    }
    return null;
  }
  setFlareHook(fn) { this._flareHook = fn; }
  setPlayerColor(color) { this.playerColor = color; this.revealMode = false; this.refreshFog(); this.renderPieces(); }
  enable() { this.isEnabled = true; }
  disable() { this.isEnabled = false; this.clearSelection(); }
  getSquareElement() { return null; }

  /* ------------------------------ VHS 포스트 ------------------------------- */
  _initPost() {
    const mk = (w, h, o = {}) => new THREE.WebGLRenderTarget(w, h, Object.assign({
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, depthBuffer: false,
    }, o));
    this.rtScene = mk(IW, IH, { depthBuffer: true });
    this.rtA = mk(IW, IH);
    this.rtB = mk(IW, IH, { type: THREE.UnsignedByteType });
    this.rtP1 = mk(IW, IH, { type: THREE.UnsignedByteType });
    this.rtP2 = mk(IW, IH, { type: THREE.UnsignedByteType });
    this.rtMeter = mk(16, 12, { type: THREE.UnsignedByteType });
    this.pp = { read: this.rtP1, write: this.rtP2 };
    this.passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.passScene = new THREE.Scene();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.passMesh = new THREE.Mesh(geo, null);
    this.passMesh.frustumCulled = false;
    this.passScene.add(this.passMesh);
    const VS = `varying vec2 vUv; void main(){ vUv = position.xy*0.5+0.5; gl_Position = vec4(position.xy,0.,1.); }`;
    this.meterMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null } }, vertexShader: VS,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tIn;
        void main(){ vec3 a=vec3(0.); for(int i=0;i<4;i++) for(int j=0;j<4;j++)
          a+=texture2D(tIn, vUv+(vec2(float(i),float(j))-1.5)*vec2(1./64.,1./48.)).rgb;
          a*=(1./16.); a=a/(a+1.0); gl_FragColor=vec4(a,1.); }`,
    });
    this.camMat = new THREE.ShaderMaterial({
      uniforms: {
        tIn: { value: null }, tOSD: { value: null },
        uExposure: { value: 1 }, uWB: { value: new THREE.Vector3(1, 1, 1) }, uTime: { value: 0 },
        uMot: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: VS,
      fragmentShader: `
        varying vec2 vUv; uniform sampler2D tIn, tOSD;
        uniform float uExposure, uTime; uniform vec3 uWB; uniform vec2 uMot;
        vec3 smp(vec2 uv){ return texture2D(tIn, uv).rgb; }
        void main(){
          vec2 cc = vUv - 0.5;
          float r2 = dot(cc, cc);
          vec2 uv = clamp(0.5 + cc * (1.0 + 0.055*r2 + 0.04*r2*r2), 0.0, 1.0);
          float ca = 0.0009 + r2*0.002;
          vec3 c = vec3(0.0);
          for (int i=-1;i<=1;i++){ vec2 mo=uMot*(float(i)*0.5);
            c.r+=smp(uv+mo+cc*ca).r; c.g+=smp(uv+mo).g; c.b+=smp(uv+mo-cc*ca).b; }
          c/=3.0;
          float soft = clamp(r2*2.4,0.0,1.0)*0.5;
          if (soft>0.01){ vec2 px=vec2(1.0/640.0,1.0/480.0)*(1.0+soft*2.6);
            vec3 b=c*0.4;
            b+=smp(uv+vec2(px.x,0.))*0.15+smp(uv-vec2(px.x,0.))*0.15;
            b+=smp(uv+vec2(0.,px.y))*0.15+smp(uv-vec2(0.,px.y))*0.15;
            c=mix(c,b,soft); }
          c *= uExposure; c *= uWB;
          c = c/(c+0.42)*1.42;
          c = pow(max(c,0.0), vec3(1.1));
          float l = dot(c, vec3(0.299,0.587,0.114));
          c = mix(vec3(l), c, 0.78);
          c *= vec3(1.03, 1.04, 0.95);         // 야시경 느낌의 옅은 녹색기
          c = pow(clamp(c,0.0,1.0), vec3(1.0/2.2));
          vec4 osd = texture2D(tOSD, vUv);
          c = mix(c, osd.rgb, osd.a);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    this.vhsMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, uTime: { value: 0 }, uPan: { value: 0 }, uTrack: { value: 0 }, uNoise: { value: 0.85 } },
      vertexShader: VS,
      fragmentShader: `
        varying vec2 vUv; uniform sampler2D tIn; uniform float uTime, uPan, uTrack, uNoise;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
        vec3 rgb2yiq(vec3 c){ return vec3(dot(c,vec3(0.299,0.587,0.114)),dot(c,vec3(0.596,-0.274,-0.322)),dot(c,vec3(0.211,-0.523,0.312))); }
        vec3 yiq2rgb(vec3 y){ return vec3(y.x+0.956*y.y+0.621*y.z, y.x-0.272*y.y-0.647*y.z, y.x-1.106*y.y+1.703*y.z); }
        float lum(vec2 uv){ return rgb2yiq(texture2D(tIn, uv).rgb).x; }
        void main(){
          float line = floor(vUv.y*480.0);
          float t = floor(uTime*29.97);
          float wave = sin(vUv.y*4.7+uTime*2.2)*(0.00045+uTrack*0.0016);
          float jit = wave + (hash(vec2(line,t))-0.5)*(0.0008+uTrack*0.005);
          float band = smoothstep(0.0,1.0,uTrack)*step(0.93,hash(vec2(floor(vUv.y*24.0),t)))*0.012;
          vec2 uv = vec2(vUv.x + jit + band, vUv.y);
          float odd = mod(line,2.0);
          uv.x += odd*(uPan*0.45+0.0004);
          float hs = smoothstep(0.035,0.0,vUv.y);
          uv.x += hs*(0.006+(hash(vec2(t,7.0))-0.5)*0.012);
          float px = 1.0/640.0;
          float y0=lum(uv), yl=lum(uv-vec2(px,0.)), yr=lum(uv+vec2(px,0.));
          float ysoft = y0*0.5+(yl+yr)*0.25;
          float yring = ysoft+(y0-(yl+yr)*0.5)*0.4;
          vec2 cuv = uv + vec2(0.003,0.0);
          vec3 acc=vec3(0.0); float wsum=0.0;
          for (int i=-3;i<=3;i++){ float w=1.0-abs(float(i))*0.21;
            acc+=rgb2yiq(texture2D(tIn,cuv+vec2(float(i)*px*2.2,0.0)).rgb)*w; wsum+=w; }
          acc/=wsum;
          vec3 yiq=vec3(yring, acc.y, acc.z);
          float gf=hash(vUv*vec2(640.0,480.0)+vec2(t*13.7,t*7.3))-0.5;
          float gs=hash(vec2(floor(vUv.x*96.0)*3.1+t,line))-0.5;
          float g=gf*0.6+gs*0.4;
          float dk=1.0-clamp(yiq.x,0.0,1.0);
          yiq.x += g*(0.014+0.06*dk*dk)*uNoise;
          yiq.y += (hash(vUv*211.0+t)-0.5)*0.018*uNoise;
          yiq.z += (hash(vUv*173.0-t)-0.5)*0.018*uNoise;
          yiq.y*=0.94; yiq.z*=0.7;
          yiq.x = yiq.x*0.96+0.02;
          float dropLine = hash(vec2(line,t*0.5));
          if (dropLine > 0.9988 - uTrack*0.004){
            float seg = hash(vec2(floor(vUv.x*9.0), line+t));
            yiq.x = mix(yiq.x, 0.9, step(0.55,seg)*0.85);
            yiq.y*=0.2; yiq.z*=0.2; }
          yiq.x += hs*(hash(vUv*vec2(600.0,40.0)+t)-0.5)*0.5;
          yiq.x = mix(yiq.x, 0.05, hs*0.22);
          vec3 c = clamp(yiq2rgb(yiq),0.0,1.0);
          c = c*0.965 + vec3(0.026,0.03,0.02);
          gl_FragColor = vec4(c,1.0);
        }`,
    });
    this.tempMat = new THREE.ShaderMaterial({
      uniforms: { tCur: { value: null }, tPrev: { value: null }, uPersist: { value: 0.3 } },
      vertexShader: VS,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tCur,tPrev; uniform float uPersist;
        void main(){ gl_FragColor = vec4(mix(texture2D(tCur,vUv).rgb, texture2D(tPrev,vUv).rgb, uPersist),1.0); }`,
    });
    this.outMat = new THREE.ShaderMaterial({
      uniforms: { tIn: { value: null }, uWob: { value: new THREE.Vector2() } },
      vertexShader: VS,
      fragmentShader: `varying vec2 vUv; uniform sampler2D tIn; uniform vec2 uWob;
        void main(){ vec3 c=texture2D(tIn, vUv+uWob).rgb;
          float r2=dot(vUv-0.5,vUv-0.5); c*=1.0-r2*0.4; gl_FragColor=vec4(c,1.0); }`,
    });
    // OSD
    this.osdCv = document.createElement('canvas'); this.osdCv.width = IW; this.osdCv.height = IH;
    this.osdCtx = this.osdCv.getContext('2d');
    this.osdTex = new THREE.CanvasTexture(this.osdCv);
    this.meterBuf = new Uint8Array(16 * 12 * 4);
    this.exposure = 1; this.exposureV = 0;
    this.prevCamYaw = 0; this.prevCamPitch = 0;
  }

  _drawOSD(t) {
    const g = this.osdCtx, KF = "'Malgun Gothic','Noto Sans CJK KR',sans-serif";
    g.clearRect(0, 0, IW, IH);
    const ivory = 'rgba(235,240,220,0.92)';
    const dim = 'rgba(235,240,220,0.55)';
    g.shadowColor = 'rgba(10,14,8,0.9)'; g.shadowBlur = 2; g.shadowOffsetX = 1.5; g.shadowOffsetY = 1.5;

    // 좌상단 — REC / 카메라 라벨
    g.font = "bold 17px 'Courier New', monospace"; g.textAlign = 'left';
    if (t % 1.2 < 0.8) { g.fillStyle = 'rgba(235,80,60,0.95)'; g.fillText('●', 24, 36); }
    g.fillStyle = ivory; g.fillText('REC', 44, 36);
    g.font = "12px 'Courier New', monospace"; g.fillStyle = dim;
    g.fillText('SURV CAM 02 · 눈 감고 킹 따기', 24, 54);

    // 우상단 — 상대 / 조명탄
    g.textAlign = 'right';
    g.font = "bold 13px 'Courier New', monospace"; g.fillStyle = dim;
    g.fillText(`OPPONENT: ${this.hud.diff || 'OBSCURO'}`, IW - 24, 34);
    if (this.hud.flares !== undefined) {
      g.font = `bold 13px ${KF}`;
      g.fillStyle = this.hud.flares > 0 ? 'rgba(240,214,120,0.9)' : 'rgba(235,240,220,0.35)';
      g.fillText(`조명탄 ${'▮'.repeat(this.hud.flares)}${'▯'.repeat(Math.max(0, 3 - this.hud.flares))}  [F]`, IW - 24, 54);
    }

    // 우하단 — 날짜/시각
    const d = new Date();
    g.font = "bold 15px 'Courier New', monospace"; g.fillStyle = ivory;
    g.fillText(`${d.getFullYear()}. ${String(d.getMonth() + 1).padStart(2, '0')}. ${String(d.getDate()).padStart(2, '0')}`, IW - 24, IH - 44);
    g.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`, IW - 24, IH - 22);

    // 좌하단 — 점수 / 콤보
    g.textAlign = 'left';
    g.font = "bold 27px 'Courier New', monospace"; g.fillStyle = ivory;
    g.fillText(String(this.hud.score || 0), 24, IH - 24);
    g.font = `11px ${KF}`; g.fillStyle = dim;
    g.fillText('SCORE', 24, IH - 48);
    if (this.hud.combo >= 2) {
      g.font = "bold 19px 'Courier New', monospace";
      g.fillStyle = t % 0.5 < 0.32 ? 'rgba(255,150,80,0.95)' : 'rgba(255,150,80,0.6)';
      g.fillText(`×${this.hud.combo}`, 24 + g.measureText(String(this.hud.score || 0)).width + 46, IH - 24);
    }

    // 제한시계 — 화면 하단 가장자리 띠
    if (this.hud.clockK !== undefined && this.hud.clockK !== null) {
      const k = Math.max(0, Math.min(1, this.hud.clockK));
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(235,240,220,0.12)'; g.fillRect(0, IH - 5, IW, 4);
      g.fillStyle = k < 0.25 ? 'rgba(230,70,50,0.9)' : (k < 0.5 ? 'rgba(235,170,60,0.85)' : 'rgba(150,190,120,0.75)');
      g.fillRect(0, IH - 5, IW * k, 4);
      g.shadowBlur = 2;
    }

    // 중앙 배너 (차례 알림 등)
    if (this.bannerT > 0 && !this.endCard) {
      const a = Math.min(1, this.bannerT / 0.4);
      g.textAlign = 'center';
      g.font = `bold 30px ${KF}`;
      g.fillStyle = `rgba(235,240,220,${0.95 * a})`;
      g.fillText(this.bannerText, IW / 2, IH * 0.2);
    }

    // 종료 카드 — 테이프 라벨 스타일, 결과만
    if (this.endCard) {
      const k = Math.min(1, (this.endCardT || 0) / 0.5);
      g.shadowBlur = 0;
      g.fillStyle = `rgba(8,9,7,${0.55 * k})`;
      g.fillRect(0, 0, IW, IH);
      const boxW = 300, boxH = 108, bx = (IW - boxW) / 2, by = IH * 0.36;
      g.fillStyle = `rgba(214,210,186,${0.93 * k})`;
      g.fillRect(bx, by, boxW, boxH);
      g.fillStyle = `rgba(30,30,24,${0.9 * k})`;
      g.font = "11px 'Courier New', monospace"; g.textAlign = 'left';
      g.fillText('TAPE END', bx + 16, by + 24);
      g.font = `bold 46px ${KF}`; g.textAlign = 'center';
      g.fillStyle = this.endCard === 'win' ? `rgba(28,30,22,${k})` : `rgba(120,28,22,${k})`;
      g.fillText(this.endCard === 'win' ? '승 리' : '패 배', IW / 2, by + 74);
      g.font = `12px ${KF}`; g.fillStyle = `rgba(235,240,220,${0.6 * k})`;
      if ((this.endCardT || 0) > 1.6) g.fillText('아무 키나 눌러 다시', IW / 2, by + boxH + 34);
    }
    g.shadowBlur = 0; g.shadowOffsetX = 0; g.shadowOffsetY = 0;
    this.osdTex.needsUpdate = true;
  }

  showEnd(kind) { this.endCard = kind; this.endCardT = 0; }
  clearEnd() { this.endCard = null; this.endCardT = 0; }

  _runPass(mat, target) {
    this.passMesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.passScene, this.passCam);
  }

  _animate() {
    requestAnimationFrame(this._animate);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.simT += dt;
    const t = this.simT;
    if (this.bannerT > 0) this.bannerT -= dt;
    if (this.endCard) this.endCardT = (this.endCardT || 0) + dt;
    // 카메라: 플레이어 진영 쪽 고정 감시 카메라 + 미세 드리프트
    const side = this.playerColor === 'white' ? 1 : -1;
    this.camRig.drift = Math.max(0, this.camRig.drift - dt * 0.4);
    // 손으로 잡은 카메라: 사용자 조작(중클릭 드래그) + 미세 흔들림
    const yaw = this.userYaw + n1(t * 0.11, 3) * 0.03 + this.camRig.drift * n1(t * 6, 9) * 0.35;
    const pitch = this.userPitch;
    const dist = this.camRig.dist * (1 - pitch * 0.28) + n1(t * 0.07, 5) * 0.14;
    const height = this.camRig.height + pitch * 6.2 + n1(t * 0.09, 7) * 0.09;
    this.camera.position.set(
      Math.sin(yaw) * dist * side,
      height,
      Math.cos(yaw) * dist * side);
    this.camera.lookAt(n1(t * 0.13, 11) * 0.08, this.camRig.look - pitch * 0.5, 0);
    this.camera.rotation.z += 0.003 + n1(t * 0.5, 13) * 0.005 + this.camRig.drift * n1(t * 7, 15) * 0.018;
    // 탐조등 순회
    this.sweepTgt.position.set(Math.cos(t * 0.13) * 3.4, 0, Math.sin(t * 0.17) * 3.4);
    // 폭발 잔광 + 입자
    if (this._boomLight) {
      this._boomT = Math.max(0, (this._boomT || 0) - dt * 3.2);
      this._boomLight.intensity *= Math.max(0, this._boomT);
    }
    this._updateFx(dt);
    // 안개 살아있기
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const f = this.fogBlocks[r][c];
      const u = f.userData;
      const cur = f.material.opacity;
      f.material.opacity = cur + (u.target - cur) * (1 - Math.exp(-dt / 0.16));
      if (f.material.opacity > 0.01) {
        f.visible = true;
        f.scale.y = 1 + Math.sin(t * 0.8 + u.phase) * 0.06;
        f.position.y = 0.7 + Math.sin(t * 0.5 + u.phase * 1.7) * 0.03;
        f.material.opacity *= (1 + Math.sin(t * 1.1 + u.phase) * 0.08);
      } else f.visible = false;
    }
    /* 씬 → 측광 → 렌즈 → VHS → 잔상 → 출력 */
    this.renderer.setRenderTarget(this.rtScene);
    this.renderer.render(this.scene, this.camera);
    this.meterMat.uniforms.tIn.value = this.rtScene.texture;
    this._runPass(this.meterMat, this.rtMeter);
    this.renderer.readRenderTargetPixels(this.rtMeter, 0, 0, 16, 12, this.meterBuf);
    let lsum = 0;
    for (let i = 0; i < 192; i++) {
      const r = this.meterBuf[i * 4] / 255, g2 = this.meterBuf[i * 4 + 1] / 255, b = this.meterBuf[i * 4 + 2] / 255;
      lsum += (r / Math.max(1 - r, 0.01)) * 0.3 + (g2 / Math.max(1 - g2, 0.01)) * 0.5 + (b / Math.max(1 - b, 0.01)) * 0.2;
    }
    const targetExp = Math.max(0.35, Math.min(1.45, 0.42 / Math.max(lsum / 192, 0.04)));
    this.exposureV += (targetExp - this.exposure) * 14 * dt - this.exposureV * 5.6 * dt;
    this.exposure += this.exposureV * dt;
    this._drawOSD(t);
    this.camMat.uniforms.tIn.value = this.rtScene.texture;
    this.camMat.uniforms.tOSD.value = this.osdTex;
    this.camMat.uniforms.uExposure.value = this.exposure;
    this.camMat.uniforms.uWB.value.set(1 + n1(t * 0.07, 8) * 0.03, 1, 1 + n1(t * 0.055, 9) * 0.04);
    this.camMat.uniforms.uTime.value = t;
    {
      const cy = this.camera.rotation.y, cp = this.camera.rotation.x;
      let mx = (cy - this.prevCamYaw) * 1.4, my = (cp - this.prevCamPitch) * 1.4;
      mx = Math.max(-0.02, Math.min(0.02, mx)); my = Math.max(-0.015, Math.min(0.015, my));
      this.camMat.uniforms.uMot.value.set(mx, my);
      this.prevCamYaw = cy; this.prevCamPitch = cp;
    }
    this._runPass(this.camMat, this.rtA);
    this.trackBurst = Math.max(0, this.trackBurst - dt * 0.8);
    if (Math.random() < dt / 20) this.trackBurst = Math.max(this.trackBurst, 0.35 + Math.random() * 0.4);
    this.vhsMat.uniforms.tIn.value = this.rtA.texture;
    this.vhsMat.uniforms.uTime.value = t;
    this.vhsMat.uniforms.uPan.value = 0;
    this.vhsMat.uniforms.uTrack.value = Math.min(this.trackBurst, 1);
    this._runPass(this.vhsMat, this.rtB);
    this.tempMat.uniforms.tCur.value = this.rtB.texture;
    this.tempMat.uniforms.tPrev.value = this.pp.read.texture;
    this._runPass(this.tempMat, this.pp.write);
    this.outMat.uniforms.tIn.value = this.pp.write.texture;
    this.outMat.uniforms.uWob.value.set(n1(t * 3.7, 11) * 0.001, n1(t * 4.1, 12) * 0.0007);
    this.renderer.setRenderTarget(null);
    this.passMesh.material = this.outMat;
    this.renderer.render(this.passScene, this.passCam);
    const sw = this.pp.read; this.pp.read = this.pp.write; this.pp.write = sw;
    if (!window.__ready3d && this.simT > 1) { window.__ready3d = true; window.__ready = true; }
  }
}

window.Board3D = Board3D;
window.dispatchEvent(new Event('board3d-ready'));
