import { createRequire } from 'module';
const require = createRequire('/home/pineapple/kb-goalguard/x.js');
const { chromium } = require('playwright');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let errs = 0;
page.on('pageerror', e => { errs++; console.error('[pageerror]', e.message.slice(0, 200)); });
await page.goto('http://localhost:8943/', { waitUntil: 'load' });
await page.waitForTimeout(600);
await page.click('#start-game');
await page.waitForTimeout(400);
for (let ply = 0; ply < 60; ply++) {
  const st = await page.evaluate(`(() => {
    const g = window.__game;
    if (!g.isPlaying) return { done: true, score: g.score, hist: g.engine.moveHistory.length };
    if (g.engine.turn !== g.playerColor) return { wait: true };
    // 플레이어 무작위 수 (포획 선호)
    const moves = [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const p = g.engine.getPiece(r, c);
      if (p && p.color === g.playerColor) moves.push(...g.engine.getLegalMovesForPiece(r, c));
    }
    if (!moves.length) return { stuck: true };
    const caps = moves.filter(m => { const t = g.engine.board[m.to.row][m.to.col]; return t !== '.' ; });
    const pick = (caps.length && Math.random() < 0.7 ? caps : moves)[Math.floor(Math.random() * (caps.length && Math.random() < 0.7 ? caps.length : moves.length))] || moves[0];
    g.onPlayerMove(pick);
    return { moved: true, hist: g.engine.moveHistory.length, score: g.score, combo: g.combo };
  })()`);
  if (st.done) { console.log('GAME-OVER hist=' + st.hist + ' score=' + st.score); break; }
  if (st.stuck) { console.log('NO-MOVES'); break; }
  if (st.moved && ply % 6 === 0) console.log('ply', ply, JSON.stringify(st));
  if (ply === 14) await page.screenshot({ path: process.argv[2] || '/tmp/fog-mid.png' });
  await page.waitForTimeout(st.wait ? 500 : 1400);
}
const fin = await page.evaluate(`JSON.stringify({ playing: window.__game.isPlaying, score: window.__game.score, hist: window.__game.engine.moveHistory.length, over: window.__game.engine.isGameOver() })`);
console.log('final', fin, 'pageErrors=' + errs);
await page.screenshot({ path: process.argv[3] || '/tmp/fog-end.png' });
await browser.close();
