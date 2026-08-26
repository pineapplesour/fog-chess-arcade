#!/usr/bin/env python3
"""녹화 중 기록한 사운드 이벤트(sfx.json)를 실제 오디오 트랙으로 합성한다.

게임은 Web Audio로 소리를 실시간 합성하는데 헤드리스 녹화로는 오디오가 안 잡힌다.
그래서 같은 성격의 소리를 같은 시각에 다시 만들어 영상에 붙인다.
사용: python3 tools/build-audio.py <sfx.json> <출력.wav> <길이초>
"""
import json
import sys

import numpy as np
from scipy.io import wavfile

SR = 44100


def env(n, attack=0.004, decay=0.12, curve=3.0):
    a = max(1, int(SR * attack))
    d = max(1, n - a)
    return np.concatenate([
        np.linspace(0, 1, a),
        (np.linspace(1, 0, d) ** curve),
    ])[:n]


def noise(n):
    return np.random.uniform(-1, 1, n)


def lowpass(x, cutoff):
    """1극 저역 통과 — 나무/천 같은 둔한 질감을 만든다."""
    a = np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc = (1 - a) * x[i] + a * acc
        y[i] = acc
    return y


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def tone(freq, dur, amp=0.3, kind="sine", decay=0.12, curve=3.0, slide=0.0):
    n = int(SR * dur)
    t = np.arange(n) / SR
    f = freq + slide * (t / max(dur, 1e-6))
    ph = 2 * np.pi * np.cumsum(f) / SR
    if kind == "sine":
        w = np.sin(ph)
    elif kind == "square":
        w = np.sign(np.sin(ph))
    elif kind == "saw":
        w = 2 * (ph / (2 * np.pi) % 1) - 1
    else:
        w = np.sin(ph)
    return w * env(n, decay=decay, curve=curve) * amp


def click(dur, cutoff, amp, curve=4.0):
    n = int(SR * dur)
    return lowpass(noise(n), cutoff) * env(n, attack=0.001, curve=curve) * amp


def mix(*parts):
    """길이가 다른 파형들을 가장 긴 것에 맞춰 더한다."""
    n = max(len(p) for p in parts)
    out = np.zeros(n)
    for p in parts:
        out[:len(p)] += p
    return out


def make(name, arg=None):
    """게임의 ArcadeFX 각 소리에 대응하는 파형."""
    if name == "move":                       # 나무 딸깍
        return mix(click(0.06, 2600, 0.22), tone(220, 0.05, 0.10, decay=0.04, curve=5))
    if name == "capture":                    # 낮은 톡 + 금속 여운
        return mix(
            click(0.16, 700, 0.42, curve=2.6),
            tone(180, 0.16, 0.16, decay=0.1, curve=2.5),
            tone(430, 0.13, 0.07, decay=0.08),
        )
    if name == "combo":                      # 상승 아르페지오
        n = int(arg) if arg else 2
        out = np.zeros(int(SR * 0.5))
        for i in range(min(3, max(2, n))):
            f = 523.25 * (2 ** ((i * 4 + min(n, 5) * 2) / 12))
            s = tone(f, 0.2, 0.13, kind="sine", decay=0.1, curve=2.5)
            off = int(SR * 0.075 * i)
            out[off:off + len(s)] += s[:len(out) - off]
        return out
    if name == "tick":                       # 시계 경고 비프
        return tone(1760, 0.05, 0.10, kind="sine", decay=0.03, curve=4)
    if name == "timeout":                    # 낮은 버저
        return tone(110, 0.45, 0.22, kind="square", decay=0.35, curve=1.6)
    if name == "kingCapture":                # 팡파레
        out = np.zeros(int(SR * 0.9))
        for i, f in enumerate([392, 523.25, 659.25]):
            s = tone(f, 0.35, 0.16, kind="saw", decay=0.25, curve=2.0)
            off = int(SR * 0.11 * i)
            out[off:off + len(s)] += s[:len(out) - off]
        return mix(out, click(0.2, 400, 0.3))
    if name == "win":
        out = np.zeros(int(SR * 1.1))
        for i, f in enumerate([523.25, 659.25, 783.99, 1046.5]):
            s = tone(f, 0.4, 0.13, decay=0.3, curve=2.2)
            off = int(SR * 0.13 * i)
            out[off:off + len(s)] += s[:len(out) - off]
        return out
    if name == "lose":
        out = np.zeros(int(SR * 1.1))
        for i, f in enumerate([392, 329.63, 261.63]):
            s = tone(f, 0.45, 0.14, kind="sine", decay=0.34, curve=2.0)
            off = int(SR * 0.17 * i)
            out[off:off + len(s)] += s[:len(out) - off]
        return out
    if name == "reveal":                     # 안개 걷힘 — 노이즈 스윕
        n = int(SR * 0.7)
        x = noise(n)
        sweep = lowpass(x, 900) * env(n, attack=0.06, decay=0.6, curve=1.6)
        return sweep * 0.16
    return None


def main():
    sfx_path, out_path, dur = sys.argv[1], sys.argv[2], float(sys.argv[3])
    # 헤드리스 렌더가 느리면 Playwright 영상은 실제 경과시간보다 짧게 압축된다.
    # 그래서 이벤트 시각에 (영상길이 / 실제경과) 배율을 걸어야 소리가 화면과 맞는다.
    scale = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0
    events = json.load(open(sfx_path))
    if isinstance(events, dict):
        wall_end = events.get("wallEnd")
        events = events["events"]
        if wall_end and len(sys.argv) <= 4:
            scale = dur / wall_end
    total = int(SR * dur)
    track = np.zeros(total + SR)

    # 바탕: 테이프 히스 + 낮은 방 울림. 화면이 감시 카메라니까 무음이면 오히려 어색하다.
    hiss = highpass(noise(len(track)), 3000) * 0.012
    hum = np.sin(2 * np.pi * 58 * np.arange(len(track)) / SR) * 0.006
    drift = 1 + 0.25 * np.sin(2 * np.pi * 0.07 * np.arange(len(track)) / SR)
    track += hiss * drift + hum

    placed = 0
    for e in events:
        if e["n"] in ("init", "__hooked"):
            continue
        s = make(e["n"], e.get("a"))
        if s is None:
            continue
        off = int(SR * e["t"] * scale)
        if off < 0 or off >= total:
            continue
        end = min(len(track), off + len(s))
        track[off:end] += s[:end - off]
        placed += 1

    track = track[:total]
    peak = np.max(np.abs(track))
    if peak > 0.95:
        track *= 0.95 / peak
    # 부드러운 페이드
    f = int(SR * 0.4)
    track[:f] *= np.linspace(0, 1, f)
    track[-f:] *= np.linspace(1, 0, f)
    wavfile.write(out_path, SR, (track * 32767).astype(np.int16))
    print(f"placed {placed} sounds (scale {scale:.3f}) -> {out_path}")


if __name__ == "__main__":
    main()
