# -*- coding: utf-8 -*-
"""Run one real stereo vocal chunk through the Karaoke ONNX and save stems."""
from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf

CHUNK = 485_100
SAMPLE_RATE = 44_100


def rms(value: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(value, dtype=np.float64))))


def correlation(a: np.ndarray, b: np.ndarray) -> float:
    aa, bb = a.reshape(-1).astype(np.float64), b.reshape(-1).astype(np.float64)
    return float(np.dot(aa, bb) / (np.linalg.norm(aa) * np.linalg.norm(bb) + 1e-12))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()

    with sf.SoundFile(args.input) as source:
        if source.samplerate != SAMPLE_RATE or source.channels != 2:
            raise RuntimeError(f"expected stereo 44.1kHz input, got {source.channels}ch {source.samplerate}Hz")
        source.seek(int(args.start * SAMPLE_RATE))
        audio = source.read(CHUNK, dtype="float32", always_2d=True)
    if len(audio) < CHUNK:
        audio = np.pad(audio, ((0, CHUNK - len(audio)), (0, 0)))
    mix = audio.T[None].copy()

    providers = [p for p in ("CUDAExecutionProvider", "CPUExecutionProvider") if p in ort.get_available_providers()]
    session = ort.InferenceSession(str(args.model), providers=providers)
    sources = session.run(None, {"mix": mix})[0]
    if sources.shape != (1, 2, 2, CHUNK):
        raise RuntimeError(f"unexpected output shape {sources.shape}")
    lead, backing = sources[0, 0], sources[0, 1]
    reconstruction = lead + backing

    mix_rms = max(rms(mix[0]), 1e-12)
    metrics = {
        "providers": providers,
        "mix_rms": rms(mix[0]),
        "lead_rms": rms(lead),
        "backing_rms": rms(backing),
        "lead_energy_ratio": rms(lead) / mix_rms,
        "backing_energy_ratio": rms(backing) / mix_rms,
        "reconstruction_error": rms(mix[0] - reconstruction) / mix_rms,
        "lead_mix_correlation": correlation(lead, mix[0]),
        "backing_mix_correlation": correlation(backing, mix[0]),
        "lead_backing_correlation": correlation(lead, backing),
    }
    for key, value in metrics.items():
        print(f"{key}: {value}")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    sf.write(args.output_dir / "input_vocal.wav", mix[0].T, SAMPLE_RATE, subtype="FLOAT")
    sf.write(args.output_dir / "lead_source0.wav", lead.T, SAMPLE_RATE, subtype="FLOAT")
    sf.write(args.output_dir / "backing_source1.wav", backing.T, SAMPLE_RATE, subtype="FLOAT")
    sf.write(args.output_dir / "reconstructed.wav", reconstruction.T, SAMPLE_RATE, subtype="FLOAT")


if __name__ == "__main__":
    main()
