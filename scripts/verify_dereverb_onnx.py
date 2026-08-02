# -*- coding: utf-8 -*-
"""실제 분리 보컬로 ONNX 디리버브 검증.

확인 목표:
  1) stem0가 '드라이(noreverb)'인가 — mix와 강한 상관 + 대부분의 에너지 보유.
     (stem0가 리버브였다면 상관이 낮고 에너지가 작아야 함)
  2) stem1(잔차=리버브)이 잔향답게 더 '늦게 붙는' 성분인가 — 보컬 정지 구간
     (무음 직후 꼬리)에서의 에너지 비율로 확인.
  3) stem0 + stem1 == mix (구성상 항등)
"""
import os, glob, sys
import numpy as np
import onnxruntime as ort
import librosa

CHUNK = 352800
SR = 44100

sep_candidates = [
    os.path.join(os.environ["LOCALAPPDATA"], identifier, "cache", "separated")
    for identifier in ("com.osw.desktop", "com.autumncolor77.live-mr-manager")
]
sep = next((path for path in sep_candidates if os.path.isdir(path)), sep_candidates[0])
cands = sorted(glob.glob(os.path.join(sep, "*", "vocal.wav"))) + sorted(glob.glob(os.path.join(sep, "*", "vocal.mp3")))
if not cands:
    print("검증용 보컬을 찾지 못함:", sep); sys.exit(1)

src = cands[0]
print("소스 보컬:", os.path.basename(os.path.dirname(src)))
y, _ = librosa.load(src, sr=SR, mono=False)
if y.ndim == 1:
    y = np.stack([y, y])
# 에너지가 있는 구간(노래 중간)을 골라 8초 청크
total = y.shape[1]
start = max(0, total // 3)
mix = y[:, start:start + CHUNK]
if mix.shape[1] < CHUNK:
    mix = np.pad(mix, ((0, 0), (0, CHUNK - mix.shape[1])))
mix = mix.astype(np.float32)[None]  # [1,2,T]
print(f"청크 RMS: {np.sqrt((mix**2).mean()):.5f}")

sess = ort.InferenceSession("dereverb_mel_band_roformer.onnx", providers=["CPUExecutionProvider"])
out = sess.run(None, {"mix": mix})[0]  # [1,2,2,T]
dry, rev = out[0, 0], out[0, 1]
m = mix[0]

def rms(a): return float(np.sqrt((a ** 2).mean()))
def corr(a, b):
    a, b = a.ravel(), b.ravel()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))

print(f"\nRMS      mix={rms(m):.5f}  stem0(dry)={rms(dry):.5f}  stem1(residue)={rms(rev):.5f}")
print(f"상관     stem0·mix={corr(dry, m):+.4f}   stem1·mix={corr(rev, m):+.4f}")
print(f"항등성   |(stem0+stem1)-mix| max={np.abs(dry + rev - m).max():.3e}")

# 잔향 꼬리 확인: 프레임 RMS로 '보컬이 끊긴 뒤' 구간에서 잔차 비율이 커지는지
hop = 4410  # 0.1s
fm = np.array([rms(m[:, i:i+hop]) for i in range(0, CHUNK - hop, hop)])
fd = np.array([rms(dry[:, i:i+hop]) for i in range(0, CHUNK - hop, hop)])
fr = np.array([rms(rev[:, i:i+hop]) for i in range(0, CHUNK - hop, hop)])
loud = fm > np.percentile(fm, 70)      # 노래하는 구간
quiet = (fm > np.percentile(fm, 15)) & (fm < np.percentile(fm, 40))  # 꼬리/틈
def ratio(mask):
    return float(fr[mask].mean() / (fd[mask].mean() + 1e-9))
print(f"\n잔차/드라이 비율  노래구간={ratio(loud):.3f}   조용한 꼬리구간={ratio(quiet):.3f}")
print("  (꼬리 비율이 노래 구간보다 크면 stem1이 잔향 성분 = stem0가 드라이라는 근거)")

verdict = corr(dry, m) > 0.9 and rms(dry) > rms(rev)
print("\n판정:", "stem0 = 드라이(디리버브) ✅" if verdict else "⚠️ stem0가 드라이가 아닐 수 있음 — vocal_source_index 재확인 필요")
