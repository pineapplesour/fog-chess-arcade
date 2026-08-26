# 눈 감고 킹 따기

> 내 기물이 갈 수 있는 칸만 보인다. 체크메이트는 없다. 안개 속에서 상대 킹을 먼저 잡으면 이긴다.

**플레이:** https://pineapplesour.github.io/fog-chess-arcade/
(브라우저에서 바로 실행 — 설치·서버·API 키 불필요)

**데모 영상:** `media/demo.mp4` → https://pineapplesour.github.io/fog-chess-arcade/media/demo.mp4

---

## 무엇을 하는 게임인가

포그 오브 워 체스(Fog of War Chess)는 상대 기물이 안개에 가려진 체스 변형이다.
체크·체크메이트 개념이 없고, **킹을 실제로 잡아야** 끝난다. 정보가 승부를 가른다.

이 프로젝트는 그 변형을 두 방향으로 밀어붙인다.

1. **초인적 AI 계열의 브라우저 구현** — 논문 *General search techniques without common
   knowledge for imperfect-information games, and application to superhuman Fog of War chess*
   (arXiv:2506.01242, ICLR 2026)의 Obscuro가 쓴 접근, 즉 *관측과 일치하는 가상 보드 위에서
   탐색하고 각 후보를 체스 엔진 평가로 초기화*하는 구조를 브라우저에서 재현했다.
2. **아케이드화** — 수마다 흐르는 제한시계, 포획 콤보 배율, 조명탄 정찰, 감시카메라 VHS 화면.

## 조작

| 입력 | 동작 |
|---|---|
| 클릭 | 기물 선택 → 목적지 클릭으로 착수 |
| 조명탄 버튼 → 칸 클릭 | 원하는 5×5 구역을 한 턴 밝힌다 (난이도별 1~3발) |
| 제한시계 | 시간이 다하면 손이 미끄러져 임의의 수가 나간다 |

## 난이도

| 이름 | AI | 시계 | 조명탄 |
|---|---|---|---|
| 신병 | 신념 보드 1수 탐색 | 25초 | 3 |
| 고참 | 신념 보드 2수 탐색 | 15초 | 2 |
| 사령관 | 신념 보드 3수 탐색 | 10초 | 1 |
| **OBSCURO** | **신념 보드 샘플링 × Stockfish 16 (WASM) MultiPV 집계** | 20초 | 3 |

## AI 설계 — `obscuro.js`

AI는 사람과 **완전히 같은 안개 규칙** 아래 둔다. 실제 보드를 훔쳐보지 않는다.
입력은 (내 기물, 내 시야에 들어온 것, 내가 잡아서 알게 된 적 재고)뿐이다.

1. **신념(belief)** — 초기 배치에서 시작해, 매 턴 시야에 들어온 칸으로 갱신한다.
   보이는 칸이 비어 있으면 "여기엔 없다"는 정보로 남는다.
2. **샘플링** — 관측·재고와 모순되지 않는 완전한 가상 보드를 K개 만든다.
   비가시 칸에만 적 기물을 놓고, 남은 재고는 진영·기물 종류별 가중으로 배치한다.
3. **평가** — 각 샘플을 FEN으로 바꿔 **Stockfish 16 NNUE(WASM, 싱글스레드 내장)** 에
   MultiPV로 물어본다. 논문이 후보 행동을 엔진 평가로 초기화하는 것과 같은 자리다.
4. **집계** — 실제 보드에서 합법인 수만 남기고 `평균 − λ·표준편차 − 결측 페널티`로 점수화한다.
   여러 세계에서 고르게 좋은 수를 고르고, 한 세계에서만 대박인 도박수를 깎는다.
5. **킹 포획 처리** — 어떤 샘플에서 적 킹이 잡히면 그 수에 큰 보너스를 준다.
   실제로 보이는 킹은 엔진을 거치지 않고 즉시 잡는다.

원 논문은 리그렛 최소화를 반복하지만, 이 구현은 사람 상대 실시간을 위해
1-스텝 집계로 줄인 **근사**다. 논문 성능을 재현했다고 주장하지 않는다.

## 화면 — `board3d.js`

감시 카메라가 야간 전장 테이블을 내려다보는 화면이다. 안개는 UI 오버레이가 아니라
칸 위에 실제로 서 있는 반투명 기둥이고, 시야가 열리면 걷힌다.

렌더는 저해상 내부 버퍼를 다음 순서로 통과한다.

1. 3D 씬 (그림자, 순회 탐조등, 볼류메트릭 안개 기둥)
2. 자동 노출(AGC) — 16×12 측광, 2차계 오버슛
3. 렌즈 — 배럴 왜곡, 색수차, 팬 모션블러, 주변부 소프트
4. VHS 신호 — YIQ 분해, 루마 링잉, 크로마 지연·저역, 라인 타임베이스 지터,
   트래킹 버스트(포획 시 크게), 헤드스위칭 밴드, 드롭아웃
5. 잔상 합성 + 출력 비네트

포인터 좌표는 배럴 왜곡을 **역보정**해서 레이캐스트하므로, 화면이 휘어도 클릭 위치가 맞는다.

## 사운드 — `arcade-fx.js`

외부 오디오 파일 없이 Web Audio로 전부 합성한다. 이동/포획/콤보 아르페지오/시계 경고/
시간초과 버저/킹 포획 팡파레/승패 징글/안개 걷힘 스윕. **이 모듈은 Codex CLI가 구현했다**
(아래 참조).

## Codex 활용

사운드 시스템 `arcade-fx.js` 전체를 Codex CLI(`codex exec`, workspace-write 샌드박스)에
독립 작업으로 맡겼다. 인터페이스(`window.ArcadeFX`의 함수 10종, 마스터 게인, 노드 정리 규칙,
try/catch 격리)와 게임 이벤트 목록만 명세로 주고, 구현·문법 검증·오디오 노드 예약/정리
모의검증까지 Codex가 수행했다. 게임 본체 파일은 건드리지 않는 조건이었고 실제로 지켜졌다.

## 로컬 실행

```bash
python3 -m http.server 8943
# → http://localhost:8943/
```

검증 도구: `tools/playtest.mjs` (헤드리스 자동 대국 — `window.__game` 훅 사용)

## 구성

| 파일 | 역할 |
|---|---|
| `index.html` | 게임 규칙·안개 계산·아케이드 컨트롤러·UI |
| `board3d.js` | 3D 보드 + 감시카메라 VHS 렌더 파이프라인 |
| `obscuro.js` | 신념 샘플링 × Stockfish 집계 AI |
| `arcade-fx.js` | Web Audio 합성 사운드 (Codex 구현) |
| `engine/` | Stockfish 16 NNUE 싱글스레드 WASM 빌드 |
| `js/three.module.js` | three.js (로컬 번들) |

## 서드파티

- [three.js](https://threejs.org/) — MIT
- [Stockfish](https://stockfishchess.org/) / [stockfish.js](https://github.com/nmrugg/stockfish.js) — GPLv3
  (엔진 바이너리는 원 라이선스를 따른다)

## 참고 문헌

- *General search techniques without common knowledge for imperfect-information games,
  and application to superhuman Fog of War chess* — arXiv:[2506.01242](https://arxiv.org/abs/2506.01242), ICLR 2026
