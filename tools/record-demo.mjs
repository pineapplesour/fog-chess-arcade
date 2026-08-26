// 데모 영상 녹화 — 실제 플레이를 스크립트로 재현해 webm으로 뽑는다.
// 사용: node tools/record-demo.mjs <출력폴더> [url]
import { createRequire } from 'module';
const require = createRequire('/home/pineapple/kb-goalguard/x.js');
const { chromium } = require('playwright');

const outDir = process.argv[2] || '/tmp/fog-demo';
const url = process.argv[3] || 'http://localhost:8943/';

const browser = await chromium.launch({
  headless: true,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars'],
});
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  recordVideo: { dir: outDir, size: { width: 1280, height: 720 } },
});
const page = await ctx.newPage();
page.on('pageerror', e => console.error('[err]', e.message.slice(0, 140)));
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction('window.__ready3d === true', null, { timeout: 40000 });
await page.waitForTimeout(2600);           // 판이 서는 걸 보여준다

const clickSquare = async (row, col, h = 0.3) => {
  const p = JSON.parse(await page.evaluate(`JSON.stringify(window.__game.ui.squareToScreen(${row},${col},${h}))`));
  await page.mouse.move(p.x, p.y, { steps: 12 });   // 커서가 움직이는 게 보이도록
  await page.waitForTimeout(320);
  await page.mouse.click(p.x, p.y);
};
const myTurn = () => page.waitForFunction(
  'window.__game.engine.turn === window.__game.playerColor || !window.__game.isPlaying',
  null, { timeout: 40000 });

// 플레이어 쪽은 신념 탐색 봇이 고르고, 그 수를 실제 마우스 클릭으로 둔다.
// (무작위로 두면 교전이 안 붙어서 포획/폭발 장면이 안 나온다)
await page.evaluate(`window.__game.bot.newGame(window.__game.playerColor, {depth:2, noise:18})`);
const playOne = async (preferCapture = true) => {
  const mv = JSON.parse(await page.evaluate(`(() => {
    const G = window.__game;
    if (!G.isPlaying || G.engine.turn !== G.playerColor) return 'null';
    const all = [];
    for (let r=0;r<8;r++) for (let c=0;c<8;c++){
      const p = G.engine.getPiece(r,c);
      if (p && p.color === G.playerColor) all.push(...G.engine.getLegalMovesForPiece(r,c));
    }
    if (!all.length) return 'null';
    const caps = all.filter(m => G.engine.board[m.to.row][m.to.col] !== '.');
    if (${preferCapture} && caps.length) return JSON.stringify(caps[0]);
    const m = G.bot.chooseMove(G.engine);
    return JSON.stringify(m || all[Math.floor(Math.random()*all.length)]);
  })()`));
  if (!mv) return false;
  await clickSquare(mv.from.row, mv.from.col, 0.35);
  await page.waitForTimeout(500);            // 이동 가능 칸 하이라이트를 보여준다
  await clickSquare(mv.to.row, mv.to.col, 0.08);
  await myTurn();
  await page.waitForTimeout(650);
  return true;
};

// 1) 초반 몇 수 — 안개가 걷히고 다시 덮이는 걸 보여준다
for (let i = 0; i < 3; i++) { if (!await playOne(false)) break; }

// 2) 시야 조작 — 카메라를 낮췄다가 되돌린다
await page.mouse.move(640, 400);
await page.mouse.down({ button: 'middle' });
for (let i = 0; i < 22; i++) { await page.mouse.move(640 - i * 6, 400 + i * 5); await page.waitForTimeout(28); }
await page.waitForTimeout(700);
for (let i = 22; i >= 0; i--) { await page.mouse.move(640 - i * 6, 400 + i * 5); await page.waitForTimeout(24); }
await page.mouse.up({ button: 'middle' });
await page.waitForTimeout(600);

// 3) 조명탄 — 적진 한복판을 밝힌다
await page.keyboard.press('KeyF');
await page.waitForTimeout(700);
await clickSquare(2, 4, 0.08);
await page.waitForTimeout(2000);

// 4) 남은 대국 — 교전이 붙고 폭발/콤보가 나올 때까지
let caps = 0;
for (let i = 0; i < 34; i++) {
  const alive = await page.evaluate('window.__game.isPlaying');
  if (!alive) break;
  if (!await playOne(true)) break;
  const sc = await page.evaluate('window.__game.score');
  if (sc > 0 && caps === 0) { caps = 1; await page.waitForTimeout(900); }   // 첫 폭발은 좀 더 보여준다
  if (sc >= 200 && i > 16) break;
}
await page.waitForTimeout(3400);            // 종료 카드 또는 마지막 상황
console.log('final score', await page.evaluate('window.__game.score'));

await ctx.close();                          // 영상 flush
await browser.close();
console.log('recorded to', outDir);
