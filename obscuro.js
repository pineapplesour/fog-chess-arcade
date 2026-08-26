// Obscuro-lite — 논문 "General search techniques without common knowledge ...
// superhuman Fog of War chess" (arXiv 2506.01242, ICLR 2026)의 브라우저 근사.
//
// 원 논문: 관측과 일치하는 정보집합 위에서 리그렛 최소화 탐색을 돌리되,
//          각 행동을 Stockfish 평가로 초기화해 수렴을 안정화.
// 이 구현: 관측·기물 재고와 일관된 보드 K개를 신념 가중으로 샘플링하고,
//          각 샘플을 Stockfish(WASM) MultiPV로 평가한 뒤 수별로
//          "평균 - λ·표준편차 - 결측 페널티"로 집계해 착수한다.
//          (풀 리그렛 루프 대신 1-스텝 집계 — 사람 상대 실시간용)
//
// 안개 준수: 입력은 (내 기물, 내 시야 안 내용, 내가 잡아서 아는 적 재고)뿐이다.
// 실보드 훔쳐보기 없음. 잡을 수 있는 "보이는" 적 킹은 엔진 없이 즉시 잡는다.

(function () {
  'use strict';

  const VAL = { p: 100, n: 315, b: 330, r: 500, q: 900, k: 20000 };
  const FILES = 'abcdefgh';

  /* ---------------- Stockfish 워커 풀 (1개, 순차 사용) ---------------- */
  class SF {
    constructor(url) {
      this.url = url;
      this.w = null;
      this.ready = false;
      this.queue = Promise.resolve();
    }
    boot() {
      if (this.w) return this.readyP;
      this.w = new Worker(this.url);
      this.lines = [];
      this.readyP = new Promise((res) => {
        this.w.onmessage = (e) => {
          const s = String(e.data);
          if (this._sink) this._sink(s);
          if (s === 'readyok' && this._readyRes) { const r = this._readyRes; this._readyRes = null; r(); }
          if (s === 'uciok') { this.w.postMessage('setoption name Threads value 1'); this.w.postMessage('isready'); this._readyRes = () => { this.ready = true; res(); }; }
        };
        this.w.postMessage('uci');
      });
      return this.readyP;
    }
    // fen 하나를 MultiPV로 평가해 {move: cp} 맵 반환
    evalFen(fen, { movetimeMs = 120, multipv = 8, depthCap = 12 } = {}) {
      this.queue = this.queue.then(() => new Promise((resolve) => {
        const scores = {};
        let done = false;
        const finish = () => { if (!done) { done = true; this._sink = null; resolve(scores); } };
        this._sink = (s) => {
          if (s.startsWith('info ')) {
            const mMv = s.match(/ multipv (\d+).*? score (cp|mate) (-?\d+).*? pv ([a-h][1-8][a-h][1-8][qrbn]?)/);
            if (mMv) {
              const kind = mMv[2], v = parseInt(mMv[3]);
              const cp = kind === 'mate' ? (v > 0 ? 10000 - v * 10 : -10000 - v * 10) : v;
              scores[mMv[4]] = cp;
            }
          } else if (s.startsWith('bestmove')) finish();
        };
        this.w.postMessage('setoption name MultiPV value ' + multipv);
        this.w.postMessage('position fen ' + fen);
        this.w.postMessage(`go movetime ${movetimeMs} depth ${depthCap}`);
        setTimeout(finish, movetimeMs + 1500); // 안전망
      }));
      return this.queue;
    }
  }

  /* ---------------- Obscuro-lite 본체 ---------------- */
  class ObscuroBot {
    constructor(engineUrl) {
      this.sf = new SF(engineUrl);
      this.color = 'black';
      this.belief = null;        // 마지막 목격 기반 신념 (칸 → 적 기물 or null)
      this.inventory = null;     // 적 잔여 재고 {p,n,b,r,q,k}
      this.cfg = { samples: 12, movetimeMs: 110, multipv: 10, lambda: 0.5, missPenalty: 140 };
    }
    boot() { return this.sf.boot(); }
    newGame(color, cfg) {
      this.color = color;
      Object.assign(this.cfg, cfg || {});
      this.belief = null;
      this.inventory = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
    }
    enemyIs(ch) { return ch !== '.' && ((ch === ch.toUpperCase()) ? 'white' : 'black') !== this.color; }
    ensureBelief() {
      if (this.belief) return;
      this.belief = Array.from({ length: 8 }, () => Array(8).fill(null));
      const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
      if (this.color === 'black') { for (let c = 0; c < 8; c++) { this.belief[7][c] = back[c].toUpperCase(); this.belief[6][c] = 'P'; } }
      else { for (let c = 0; c < 8; c++) { this.belief[0][c] = back[c]; this.belief[1][c] = 'p'; } }
    }
    observe(engine) {
      this.ensureBelief();
      const vis = engine.getVisibleSet(this.color);
      vis.forEach(k => {
        const [r, c] = k.split(',').map(Number);
        const ch = engine.board[r][c];
        this.belief[r][c] = this.enemyIs(ch) ? ch : null;
      });
    }
    noteCaptureOfEnemy(pieceChar) { // 내가 잡은 적 기물 → 재고 차감
      const t = (pieceChar || '').toLowerCase();
      if (this.inventory && this.inventory[t] > 0) this.inventory[t] -= 1;
    }
    noteSquare(engine, r, c) { // 내 기물이 잡힌 자리 = 잡은 적 기물 위치 공개
      this.ensureBelief();
      const ch = engine.board[r][c];
      if (this.enemyIs(ch)) this.belief[r][c] = ch;
    }

    // 관측·재고와 일관된 완전 보드 1개 샘플링
    sampleBoard(engine, vis) {
      const b = Array.from({ length: 8 }, () => Array(8).fill('.'));
      const enemyWhite = this.color === 'black';
      // 1) 내 기물 + 보이는 적 기물(확정)
      const need = Object.assign({}, this.inventory);
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const ch = engine.board[r][c];
        if (ch === '.') continue;
        const mine = ((ch === ch.toUpperCase()) ? 'white' : 'black') === this.color;
        if (mine) b[r][c] = ch;
        else if (vis.has(`${r},${c}`)) { b[r][c] = ch; const t = ch.toLowerCase(); if (need[t] > 0) need[t] -= 1; }
      }
      // 2) 비가시 신념 위치를 확률적으로 채택 (85%)
      const empties = [];
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        if (b[r][c] !== '.' || vis.has(`${r},${c}`)) continue;   // 보이는 빈 칸엔 못 놓는다
        const bel = this.belief[r][c];
        if (bel && need[bel.toLowerCase()] > 0 && Math.random() < 0.85) {
          b[r][c] = bel; need[bel.toLowerCase()] -= 1;
        } else empties.push([r, c]);
      }
      // 3) 남은 재고를 그럴듯한 빈 비가시 칸에 배치 (적 진영 가중)
      const weight = ([r, c], t) => {
        let w = 1;
        const homeRow = enemyWhite ? 7 : 0;
        w += Math.max(0, 3 - Math.abs(r - (enemyWhite ? 6 : 1))) * (t === 'p' ? 1.2 : 0.4);
        if (t === 'k') w += Math.max(0, 2.5 - Math.abs(r - homeRow)) * 2;
        if (t === 'p' && (r === 0 || r === 7)) return 0;   // 폰은 끝행 불가
        return w;
      };
      const place = (t) => {
        const ch = enemyWhite ? t.toUpperCase() : t;
        let tot = 0; const ws = empties.map(e => { const w = b[e[0]][e[1]] === '.' ? weight(e, t) : 0; tot += w; return w; });
        if (tot <= 0) return false;
        let x = Math.random() * tot;
        for (let i = 0; i < empties.length; i++) { x -= ws[i]; if (x <= 0 && ws[i] > 0) { b[empties[i][0]][empties[i][1]] = ch; return true; } }
        return false;
      };
      for (const t of ['k', 'q', 'r', 'r', 'b', 'b', 'n', 'n', 'p', 'p', 'p', 'p', 'p', 'p', 'p', 'p']) {
        if (need[t] > 0) { if (place(t)) need[t] -= 1; }
      }
      // 킹이 어디에도 못 들어갔으면 실패 → null
      const kCh = enemyWhite ? 'K' : 'k';
      let hasK = false;
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (b[r][c] === kCh) hasK = true;
      if (this.inventory.k > 0 && !hasK) return null;
      return b;
    }

    boardToFen(b, sideToMove) {
      const rows = [];
      for (let r = 0; r < 8; r++) {
        let s = '', e = 0;
        for (let c = 0; c < 8; c++) {
          const ch = b[r][c];
          if (ch === '.') e++;
          else { if (e) { s += e; e = 0; } s += ch; }
        }
        if (e) s += e;
        rows.push(s || '8');
      }
      return `${rows.join('/')} ${sideToMove === 'white' ? 'w' : 'b'} - - 0 1`;
    }

    // 표준 체스로 성립 안 하는 샘플(상대편 킹이 이미 잡히는 위치 등) 사전 처리
    myKingCaptureMove(engine, b) {
      // 샘플 b에서 즉시 킹을 먹는 내 합법수(실보드 기준 합법)가 있으면 반환
      const kCh = (this.color === 'white') ? 'k' : 'K';
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const ch = engine.board[r][c];
        if (ch === '.' || ((ch === ch.toUpperCase()) ? 'white' : 'black') !== this.color) continue;
        for (const m of engine.generatePseudoLegalMovesForSquare(r, c)) {
          if (b[m.row][m.col] === kCh) return { from: { row: r, col: c }, to: { row: m.row, col: m.col }, promotion: 'queen' };
        }
      }
      return null;
    }

    uciToMove(u) {
      const c1 = FILES.indexOf(u[0]), r1 = 8 - parseInt(u[1]);
      const c2 = FILES.indexOf(u[2]), r2 = 8 - parseInt(u[3]);
      return { from: { row: r1, col: c1 }, to: { row: r2, col: c2 }, promotion: u[4] ? ({ q: 'queen', r: 'rook', b: 'bishop', n: 'knight' }[u[4]] || 'queen') : undefined };
    }
    moveToUci(m) { return FILES[m.from.col] + (8 - m.from.row) + FILES[m.to.col] + (8 - m.to.row); }

    async chooseMove(engine, onProgress) {
      await this.boot();
      this.observe(engine);
      const vis = engine.getVisibleSet(this.color);
      // 0) 보이는 적 킹 즉시 캡처
      const kCh = (this.color === 'white') ? 'k' : 'K';
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const ch = engine.board[r][c];
        if (ch === '.' || ((ch === ch.toUpperCase()) ? 'white' : 'black') !== this.color) continue;
        for (const m of engine.generatePseudoLegalMovesForSquare(r, c)) {
          if (engine.board[m.row][m.col] === kCh) return { from: { row: r, col: c }, to: { row: m.row, col: m.col }, promotion: 'queen' };
        }
      }
      // 실보드 기준 내 합법수 (착수 후보 전체)
      const legal = new Set();
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
        const ch = engine.board[r][c];
        if (ch === '.' || ((ch === ch.toUpperCase()) ? 'white' : 'black') !== this.color) continue;
        for (const m of engine.generatePseudoLegalMovesForSquare(r, c)) {
          legal.add(this.moveToUci({ from: { row: r, col: c }, to: { row: m.row, col: m.col } }));
        }
      }
      if (!legal.size) return null;
      // 1) 샘플 K개 평가
      const K = this.cfg.samples;
      const agg = {};   // uci → [cp,...]
      let used = 0;
      for (let i = 0; i < K * 2 && used < K; i++) {
        const b = this.sampleBoard(engine, vis);
        if (!b) continue;
        const kc = this.myKingCaptureMove(engine, b);
        if (kc) {   // 이 샘플에선 적 킹이 잡힌다 → 해당 수에 초대형 보너스
          const u = this.moveToUci(kc);
          (agg[u] = agg[u] || []).push(9000);
          used++;
          continue;
        }
        const fen = this.boardToFen(b, this.color);
        const scores = await this.sf.evalFen(fen, { movetimeMs: this.cfg.movetimeMs, multipv: this.cfg.multipv });
        for (const [u, cp] of Object.entries(scores)) {
          if (!legal.has(u.slice(0, 4))) continue;   // 실보드 합법수만
          const key = u.length > 4 ? u.slice(0, 4) : u;
          (agg[key] = agg[key] || []).push(cp);
        }
        used++;
        if (onProgress) onProgress(used, K);
      }
      // 2) 집계: 평균 − λ·표준편차 − 결측 페널티
      let bestU = null, bestScore = -Infinity;
      for (const [u, arr] of Object.entries(agg)) {
        const mean = arr.reduce((a, x) => a + x, 0) / arr.length;
        const sd = Math.sqrt(arr.reduce((a, x) => a + (x - mean) * (x - mean), 0) / arr.length);
        const miss = Math.max(0, used - arr.length);
        const s = mean - this.cfg.lambda * sd - this.cfg.missPenalty * (miss / Math.max(used, 1));
        if (s > bestScore) { bestScore = s; bestU = u; }
      }
      if (!bestU) {   // 엔진이 아무것도 못 준 극단 케이스 → 임의 합법수
        const arr = [...legal];
        bestU = arr[(Math.random() * arr.length) | 0];
      }
      return this.uciToMove(bestU);
    }
  }

  window.ObscuroBot = ObscuroBot;
})();
