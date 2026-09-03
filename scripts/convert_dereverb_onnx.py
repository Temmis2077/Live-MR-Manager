# -*- coding: utf-8 -*-
"""
anvuew/dereverb_mel_band_roformer (Mel-Band RoFormer, num_stems=1 'noreverb')
→ ONNX (opset 17), STFT/iSTFT를 실수 conv 연산으로 그래프에 내장.

앱 인터페이스(Deux와 동일):
  입력  mix     [1, 2, 352800] float32
  출력  sources [1, 2, 2, 352800]  (stem0 = dry/디리버브, stem1 = mix - dry)

검증 단계:
  1) ConvSTFT vs torch.stft, ConvISTFT vs torch.istft (수치 패리티)
  2) ExportWrapper(실수 재구현) vs 원본 MelBandRoformer.forward (전체 모델 패리티)
  3) ONNX Runtime vs PyTorch wrapper (내보내기 패리티)
"""
import math
import sys
import inspect
import yaml
import torch
import torch.nn.functional as F
from torch import nn
from einops import rearrange

torch.manual_seed(0)
DEVICE = "cpu"
CHUNK = 352800

# ---------------------------------------------------------------- Conv STFT
class ConvSTFT(nn.Module):
    """torch.stft(center=True, reflect pad, onesided, normalized=False) 동치.
    출력: real [B, F, T], imag [B, F, T]"""

    def __init__(self, n_fft: int, hop: int, win_length: int):
        super().__init__()
        self.n_fft, self.hop = n_fft, hop
        window = torch.hann_window(win_length)
        if win_length < n_fft:  # torch.stft는 window를 n_fft로 중앙 패딩
            pad = (n_fft - win_length) // 2
            window = F.pad(window, (pad, n_fft - win_length - pad))
        freqs = n_fft // 2 + 1
        n = torch.arange(n_fft, dtype=torch.float64)
        k = torch.arange(freqs, dtype=torch.float64)[:, None]
        ang = 2.0 * math.pi * k * n / n_fft
        wr = (torch.cos(ang) * window.double()).float()   # [F, N]
        wi = (-torch.sin(ang) * window.double()).float()
        # conv1d weight: [out=2F, in=1, kernel=N]
        self.register_buffer("weight", torch.cat([wr, wi], 0).unsqueeze(1))
        self.freqs = freqs

    def forward(self, x):  # x: [B, T]
        x = F.pad(x.unsqueeze(1), (self.n_fft // 2, self.n_fft // 2), mode="reflect")
        out = F.conv1d(x, self.weight, stride=self.hop)   # [B, 2F, frames]
        return out[:, : self.freqs], out[:, self.freqs :]

# --------------------------------------------------------------- Conv iSTFT
class ConvISTFT(nn.Module):
    """torch.istft(center=True, onesided, normalized=False, length=(T-1)*hop) 동치.
    고정 프레임 수(static chunk)를 전제로 윈도 정규화 포락선을 상수로 내장."""

    def __init__(self, n_fft: int, hop: int, win_length: int, frames: int):
        super().__init__()
        self.n_fft, self.hop = n_fft, hop
        self.out_len = (frames - 1) * hop
        window = torch.hann_window(win_length)
        if win_length < n_fft:
            pad = (n_fft - win_length) // 2
            window = F.pad(window, (pad, n_fft - win_length - pad))
        freqs = n_fft // 2 + 1
        n = torch.arange(n_fft, dtype=torch.float64)
        k = torch.arange(freqs, dtype=torch.float64)[:, None]
        coef = torch.full((freqs, 1), 2.0 / n_fft, dtype=torch.float64)
        coef[0] = coef[-1] = 1.0 / n_fft   # DC/Nyquist는 켤레 짝 없음
        ang = 2.0 * math.pi * k * n / n_fft
        br = (coef * torch.cos(ang) * window.double()).float()   # irfft·window
        bi = (-coef * torch.sin(ang) * window.double()).float()
        # conv_transpose1d weight: [in=2F, out=1, kernel=N] → overlap-add
        self.register_buffer("weight", torch.cat([br, bi], 0).unsqueeze(1))
        # 윈도 제곱 overlap-add 정규화 포락선(상수) + center 트리밍 위치
        total = (frames - 1) * hop + n_fft
        env = torch.zeros(total, dtype=torch.float64)
        w2 = (window.double() ** 2)
        for t in range(frames):
            env[t * hop : t * hop + n_fft] += w2
        start = n_fft // 2
        env = env[start : start + self.out_len].clamp(min=1e-11).float()
        self.register_buffer("env", env)
        self.start = start

    def forward(self, real, imag):  # [B, F, T] 각각
        x = torch.cat([real, imag], 1)
        y = F.conv_transpose1d(x, self.weight, stride=self.hop).squeeze(1)  # [B, total]
        y = y[:, self.start : self.start + self.out_len]
        return y / self.env

# ------------------------------------------------------------ Export wrapper
class ExportWrapper(nn.Module):
    """MelBandRoformer.forward를 complex 없이 재구현(추론 전용, batch=1)."""

    def __init__(self, model, chunk: int, all_stems: bool = False):
        super().__init__()
        self.model = model
        self.all_stems = all_stems
        kw = model.stft_kwargs
        n_fft, hop, win = kw["n_fft"], kw["hop_length"], kw["win_length"]
        assert not kw["normalized"]
        frames = chunk // hop + 1  # center=True
        self.stft = ConvSTFT(n_fft, hop, win)
        self.istft = ConvISTFT(n_fft, hop, win, frames)
        self.audio_channels = model.audio_channels

        # 밴드 합산 → 주파수 평균을 상수 행렬 곱으로 (scatter_add 대체).
        fi = model.freq_indices                     # [Fb] (stereo 인터리브 인덱스)
        f_total = (n_fft // 2 + 1) * self.audio_channels
        A = torch.zeros(f_total, fi.numel())
        A[fi, torch.arange(fi.numel())] = 1.0
        denom = model.num_bands_per_freq.repeat_interleave(self.audio_channels).clamp(min=1e-8)
        self.register_buffer("band_sum", (A / denom[:, None]).contiguous())
        self.register_buffer("freq_indices", fi)
        # zero_dc: (f s) 배열에서 f=0에 해당하는 앞 S개 행을 0으로.
        # 축은 [1, f_total, 1] — [B, f_total, T]와 곱해지므로 f축에 맞춰야 한다.
        # ([f_total,1,1]로 두면 브로드캐스팅이 [f,f,t]로 폭발한다.)
        dc_mask = torch.ones(1, f_total, 1)
        if getattr(model, "zero_dc", True):
            dc_mask[:, : self.audio_channels, :] = 0.0
        self.register_buffer("dc_mask", dc_mask)

    def forward(self, mix):  # [1, 2, T]
        m = self.model
        B, S, T = mix.shape
        flat = mix.reshape(B * S, T)
        re, im = self.stft(flat)                     # [B*S, F, T']
        # 'b s f t c 병합' → (f s) 인터리브: [B, F*S, T', 2]와 동일한 배치로.
        re = rearrange(re, "(b s) f t -> b (f s) t", b=B)
        im = rearrange(im, "(b s) f t -> b (f s) t", b=B)

        # 밴드 추출 → band_split 입력 'b t (f c)'
        xr = torch.index_select(re, 1, self.freq_indices)
        xi = torch.index_select(im, 1, self.freq_indices)
        x = torch.stack([xr, xi], -1)                # [B, Fb, T', 2]
        x = rearrange(x, "b f t c -> b t (f c)")
        x = m.band_split(x)

        for block in m.layers:
            time_tr, freq_tr = block[-2], block[-1]
            x = rearrange(x, "b t f d -> (b f) t d")
            x = time_tr(x)
            x = rearrange(x, "(b f) t d -> (b t) f d", b=B)
            x = freq_tr(x)
            x = rearrange(x, "(b t) f d -> b t f d", b=B)

        estimates = []
        estimators = m.mask_estimators if self.all_stems else m.mask_estimators[:1]
        for estimator in estimators:
            mask = estimator(x)                     # [B, T', Fb*2]
            mask = rearrange(mask, "b t (f c) -> b f t c", c=2)
            mr, mi = mask[..., 0], mask[..., 1]

            # 밴드 마스크를 주파수로 평균(상수 행렬) 후 complex 곱 (실수 전개)
            mr = torch.einsum("gf,bft->bgt", self.band_sum, mr)
            mi = torch.einsum("gf,bft->bgt", self.band_sum, mi)
            or_ = (re * mr - im * mi) * self.dc_mask
            oi_ = (re * mi + im * mr) * self.dc_mask

            # (f s) → 채널 분리 후 iSTFT
            or_ = rearrange(or_, "b (f s) t -> (b s) f t", s=S)
            oi_ = rearrange(oi_, "b (f s) t -> (b s) f t", s=S)
            estimates.append(self.istft(or_, oi_).reshape(B, S, T))

        if self.all_stems:
            return torch.stack(estimates, dim=1)     # [B, stems, channels, T]
        dry = estimates[0]
        return torch.stack([dry, mix - dry], dim=1)  # [B, 2(stems), channels, T]

# ----------------------------------------------------------------- Pipeline
def main():
    sys.path.insert(0, ".")
    from models.bs_roformer.mel_band_roformer import MelBandRoformer

    with open("config.yaml", encoding="utf-8") as f:
        cfg = yaml.load(f, Loader=yaml.UnsafeLoader)["model"]
    cfg["flash_attn"] = False  # sdpa 대신 einsum 경로(수치 동일, export 안전)
    sig = inspect.signature(MelBandRoformer.__init__).parameters
    kwargs = {k: v for k, v in cfg.items() if k in sig}
    dropped = [k for k in cfg if k not in sig]
    print("[1/6] 모델 구성", kwargs.keys(), "| 무시:", dropped)
    model = MelBandRoformer(**kwargs)

    print("[2/6] 체크포인트 로드")
    sd = torch.load("model.ckpt", map_location="cpu", weights_only=True)
    if isinstance(sd, dict) and "state_dict" in sd:
        sd = sd["state_dict"]
    missing, unexpected = model.load_state_dict(sd, strict=False)
    print("   missing:", len(missing), missing[:5])
    print("   unexpected:", len(unexpected), unexpected[:5])
    assert not missing, "state_dict 불일치 — 아키텍처 파라미터 확인 필요"
    model.eval()

    kw = model.stft_kwargs
    n_fft, hop, win = kw["n_fft"], kw["hop_length"], kw["win_length"]

    print("[3/6] STFT/iSTFT conv 패리티")
    x = torch.randn(2, CHUNK)
    w = torch.hann_window(win)
    ref = torch.stft(x, **kw, window=w, return_complex=True)
    cs = ConvSTFT(n_fft, hop, win)
    r, i = cs(x)
    e1 = max((r - ref.real).abs().max().item(), (i - ref.imag).abs().max().item())
    rec_ref = torch.istft(ref, **kw, window=w, return_complex=False)
    ci = ConvISTFT(n_fft, hop, win, ref.shape[-1])
    rec = ci(ref.real, ref.imag)
    e2 = (rec - rec_ref).abs().max().item()
    print(f"   stft max err {e1:.3e} | istft max err {e2:.3e}")
    assert e1 < 2e-3 and e2 < 2e-5, "conv STFT/iSTFT 패리티 실패"

    print("[4/6] 전체 모델 패리티 (wrapper vs 원본 forward)")
    wrapper = ExportWrapper(model, CHUNK).eval()
    mix = torch.randn(1, 2, CHUNK) * 0.3
    with torch.no_grad():
        ref_dry = model(mix)              # [1, 2, T]
        out = wrapper(mix)                # [1, 2, 2, T]
    diff = (out[:, 0] - ref_dry).abs()
    denom = ref_dry.abs().mean().item()
    print(f"   dry max abs err {diff.max().item():.3e} | mean {diff.mean().item():.3e} | ref mean|x| {denom:.3e}")
    assert diff.max().item() < 5e-3, "wrapper 패리티 실패"

    print("[5/6] ONNX export (opset 17)")
    out_path = "dereverb_mel_band_roformer.onnx"
    torch.onnx.export(
        wrapper, (mix,), out_path,
        input_names=["mix"], output_names=["sources"],
        opset_version=17, do_constant_folding=True, dynamo=False,
    )

    print("[6/6] ONNX Runtime 패리티")
    import onnxruntime as ort
    sess = ort.InferenceSession(out_path, providers=["CPUExecutionProvider"])
    got = sess.run(None, {"mix": mix.numpy()})[0]
    d = abs(torch.from_numpy(got) - out).max().item()
    print(f"   ort vs torch max err {d:.3e}")
    assert d < 2e-3, "ONNX 패리티 실패"

    import os
    print("DONE:", out_path, f"{os.path.getsize(out_path)/1e6:.1f} MB")

if __name__ == "__main__":
    main()
