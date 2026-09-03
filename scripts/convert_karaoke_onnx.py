# -*- coding: utf-8 -*-
"""becruily Mel-Band RoFormer Karaoke checkpoint -> OSW RawWaveform ONNX.

The checkpoint contains two independently trained mask estimators. Both are
exported in their original order instead of deriving stem 1 as a residual.

Output contract:
  mix     float32 [1, 2, 485100]
  sources float32 [1, 2, 2, 485100]
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
import sys
import types
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch

from convert_dereverb_onnx import ExportWrapper

CHUNK = 485_100
PROGRESS_PATH = Path(__file__).with_name("karaoke_onnx_progress.log")


def mark(message: str) -> None:
    line = f"{__import__('datetime').datetime.now().isoformat(timespec='seconds')} {message}"
    print(line, flush=True)
    PROGRESS_PATH.write_text(line + "\n", encoding="utf-8")


MODEL_KWARGS = dict(
    dim=384,
    depth=6,
    stereo=True,
    num_stems=2,
    time_transformer_depth=1,
    freq_transformer_depth=1,
    num_bands=60,
    dim_head=64,
    heads=8,
    attn_dropout=0.0,
    ff_dropout=0.0,
    flash_attn=False,
    dim_freqs_in=1025,
    sample_rate=44_100,
    stft_n_fft=2048,
    stft_hop_length=441,
    stft_win_length=2048,
    stft_normalized=False,
    mask_estimator_depth=2,
    multi_stft_resolution_loss_weight=1.0,
    multi_stft_resolutions_window_sizes=(4096, 2048, 1024, 512, 256),
    multi_stft_hop_size=147,
    multi_stft_normalized=False,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _slaney_mel_filter(*, sr: int, n_fft: int, n_mels: int, **_kwargs) -> np.ndarray:
    """librosa.filters.mel defaults, reduced to the matrix used for band indices."""
    def hz_to_mel(freq):
        freq = np.asarray(freq, dtype=np.float64)
        mel = freq / (200.0 / 3.0)
        log_region = freq >= 1000.0
        mel[log_region] = 15.0 + np.log(freq[log_region] / 1000.0) / (np.log(6.4) / 27.0)
        return mel

    def mel_to_hz(mel):
        mel = np.asarray(mel, dtype=np.float64)
        freq = mel * (200.0 / 3.0)
        log_region = mel >= 15.0
        freq[log_region] = 1000.0 * np.exp((np.log(6.4) / 27.0) * (mel[log_region] - 15.0))
        return freq

    fft_freqs = np.fft.rfftfreq(n_fft, d=1.0 / sr)
    mel_min, mel_max = hz_to_mel(np.array([0.0, sr / 2.0]))
    mel_frequencies = mel_to_hz(np.linspace(mel_min, mel_max, n_mels + 2))
    fdiff = np.diff(mel_frequencies)
    ramps = mel_frequencies[:, None] - fft_freqs[None, :]
    weights = np.maximum(
        0.0,
        np.minimum(-ramps[:-2] / fdiff[:-1, None], ramps[2:] / fdiff[1:, None]),
    )
    # Slaney area normalization does not alter the positive/non-positive mask,
    # but applying it keeps this a numeric drop-in replacement.
    weights *= (2.0 / (mel_frequencies[2:n_mels + 2] - mel_frequencies[:n_mels]))[:, None]
    return weights.astype(np.float32)


def load_model(checkpoint: Path):
    mark("load_model: importing architecture")
    from accelerate import init_empty_weights
    # Import the two RoFormer source files directly. Importing them through the
    # audio_separator top-level package initializes its full application stack
    # and can take many minutes in embedded environments.
    roformer_dir = Path(sys.executable).parent.parent / "Lib" / "site-packages" / "audio_separator" / "separator" / "uvr_lib_v5" / "roformer"
    fake_librosa = types.ModuleType("librosa")
    fake_filters = types.ModuleType("librosa.filters")
    fake_filters.mel = _slaney_mel_filter
    fake_librosa.filters = fake_filters
    sys.modules["librosa"] = fake_librosa
    sys.modules["librosa.filters"] = fake_filters
    package_name = "_osw_roformer"
    package = types.ModuleType(package_name)
    package.__path__ = [str(roformer_dir)]
    sys.modules[package_name] = package
    for module_name in ("attend", "mel_band_roformer"):
        full_name = f"{package_name}.{module_name}"
        spec = importlib.util.spec_from_file_location(full_name, roformer_dir / f"{module_name}.py")
        if spec is None or spec.loader is None:
            raise RuntimeError(f"cannot load {module_name} from {roformer_dir}")
        module = importlib.util.module_from_spec(spec)
        sys.modules[full_name] = module
        spec.loader.exec_module(module)
    MelBandRoformer = sys.modules[f"{package_name}.mel_band_roformer"].MelBandRoformer

    # This checkpoint has roughly 430M parameters. Constructing every Linear
    # layer normally initializes 1.7GB of random weights only to overwrite them
    # immediately, which takes many minutes on CPU. Keep parameters on the meta
    # device while preserving the small non-persistent frequency buffers on CPU,
    # then assign checkpoint tensors directly.
    mark("load_model: constructing meta model")
    with init_empty_weights(include_buffers=False):
        model = MelBandRoformer(**MODEL_KWARGS)
    mark("load_model: reading checkpoint")
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    if isinstance(state, dict) and "state_dict" in state:
        state = state["state_dict"]
    mark("load_model: assigning state_dict")
    model.load_state_dict(state, strict=True, assign=True)
    mark("load_model: ready")
    return model.eval()


def parity(model, wrapper, mix, device: str) -> torch.Tensor:
    model = model.to(device)
    wrapper = wrapper.to(device)
    sample = mix.to(device)
    with torch.inference_mode():
        expected = model(sample)
        actual = wrapper(sample)
    if expected.ndim == 3:
        expected = expected.unsqueeze(1)
    diff = (expected - actual).abs()
    print(
        "[3/6] PyTorch wrapper parity:",
        f"shape={tuple(actual.shape)} max={diff.max().item():.3e}",
        f"mean={diff.mean().item():.3e}",
    )
    if diff.max().item() >= 5e-3:
        raise RuntimeError("PyTorch wrapper parity failed")
    return actual.detach().cpu()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--skip-ort", action="store_true")
    args = parser.parse_args()

    args.checkpoint = args.checkpoint.resolve()
    args.output = args.output.resolve()
    if not args.checkpoint.is_file():
        raise FileNotFoundError(args.checkpoint)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    print("[1/6] checkpoint", args.checkpoint)
    print("      bytes", args.checkpoint.stat().st_size, "sha256", sha256(args.checkpoint))
    model = load_model(args.checkpoint)
    print("[2/6] strict state_dict load OK; estimators", len(model.mask_estimators))
    if len(model.mask_estimators) != 2:
        raise RuntimeError(f"expected 2 mask estimators, got {len(model.mask_estimators)}")

    torch.manual_seed(20260812)
    mix = torch.randn(1, 2, CHUNK, dtype=torch.float32) * 0.03
    wrapper = ExportWrapper(model, CHUNK, all_stems=True).eval()
    expected = parity(model, wrapper, mix, args.device)

    # Export on CPU. The legacy exporter is used because the graph contains a
    # fixed-size real-valued STFT/iSTFT implementation and does not require
    # onnxscript.
    model.cpu()
    wrapper.cpu()
    mix = mix.cpu()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print("[4/6] exporting", args.output)
    torch.onnx.export(
        wrapper,
        (mix,),
        str(args.output),
        input_names=["mix"],
        output_names=["sources"],
        opset_version=17,
        do_constant_folding=True,
        dynamo=False,
    )
    print("[5/6] ONNX bytes", args.output.stat().st_size, "sha256", sha256(args.output))

    if not args.skip_ort:
        providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
        session = ort.InferenceSession(str(args.output), providers=providers)
        info = session.get_inputs()[0], session.get_outputs()[0]
        print("      contract", info[0].name, info[0].shape, "->", info[1].name, info[1].shape)
        got = session.run(None, {"mix": mix.numpy()})[0]
        error = float(np.max(np.abs(got - expected.numpy())))
        print("[6/6] ONNX Runtime parity", providers, f"max={error:.3e}")
        if error >= 2e-3:
            raise RuntimeError("ONNX Runtime parity failed")
    else:
        print("[6/6] ONNX Runtime parity skipped")

    print("DONE", args.output)


if __name__ == "__main__":
    # Make the sibling conversion module importable when launched elsewhere.
    sys.path.insert(0, os.path.dirname(__file__))
    main()
