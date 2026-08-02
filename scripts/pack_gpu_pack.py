#!/usr/bin/env python3
"""GPU 가속 팩을 GitHub 릴리즈용 분할 zip + 매니페스트로 묶는다.

팩 원본(~3.8GB의 NVIDIA 런타임 DLL)은 GitHub 릴리즈 에셋 1개(2GB 한도)에 담기지
않으므로, 압축 후 각 파트가 한도 아래가 되도록 여러 zip으로 쪼갠다. 앱은
manifest.json을 읽어 파트들을 내려받아 검증(sha256)하고 팩 폴더에 풀어 넣는다.

사용법:
    python scripts/pack_gpu_pack.py \
        --src "%LOCALAPPDATA%/LiveMRManager/tools/gpu" \
        --out dist/gpu-pack \
        --base-url https://github.com/Temmis2077/OSW/releases/download/gpu-pack-v1

그 다음 out 폴더의 part_*.zip 과 manifest.json 을 gpu-pack-v1 태그에 업로드한다.
manifest.json 의 URL은 gpu_pack.rs 의 GPU_PACK_MANIFEST_URL 과 일치해야 한다.
"""
import argparse
import hashlib
import json
import os
import sys
import zipfile

# is_installed() / required_dlls() 와 맞춘 최소 검증 목록.
REQUIRED_DLLS = [
    "nvinfer_10.dll",
    "nvinfer_plugin_10.dll",
    "nvonnxparser_10.dll",
    "nvinfer_builder_resource_10.dll",
    "cudnn64_9.dll",
    "cublas64_12.dll",
    "cublasLt64_12.dll",
]

# 파트당 목표 원본 크기(압축 전). deflate ~70% 를 감안해 압축 후 한도(2GB) 아래로.
DEFAULT_TARGET_BYTES = 2_400_000_000


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def bin_pack(files, target):
    """(name, size) 목록을 각 그룹 합이 target 아래가 되도록 그리디 분배."""
    files = sorted(files, key=lambda x: x[1], reverse=True)
    groups = []
    for name, size in files:
        placed = False
        for g in groups:
            if g["size"] + size <= target or not g["files"]:
                g["files"].append(name)
                g["size"] += size
                placed = True
                break
        if not placed:
            groups.append({"files": [name], "size": size})
    return groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="GPU 팩 폴더(설치된 DLL 위치)")
    ap.add_argument("--out", required=True, help="파트/매니페스트 출력 폴더")
    ap.add_argument("--base-url", required=True, help="파트가 올라갈 릴리즈 에셋 기본 URL")
    ap.add_argument("--target-bytes", type=int, default=DEFAULT_TARGET_BYTES)
    args = ap.parse_args()

    src = os.path.expandvars(args.src)
    if not os.path.isdir(src):
        print(f"[!] 소스 폴더 없음: {src}", file=sys.stderr)
        return 1

    dlls = [f for f in os.listdir(src) if f.lower().endswith(".dll")]
    if not dlls:
        print(f"[!] DLL 없음: {src}", file=sys.stderr)
        return 1

    missing = [d for d in REQUIRED_DLLS if d not in dlls]
    if missing:
        print(f"[!] 경고: 필수 DLL 누락 — {', '.join(missing)}", file=sys.stderr)

    files = [(f, os.path.getsize(os.path.join(src, f))) for f in dlls]
    total = sum(s for _, s in files)
    print(f"[i] DLL {len(files)}개, 원본 {total/2**30:.2f} GB")

    groups = bin_pack(files, args.target_bytes)
    print(f"[i] {len(groups)}개 파트로 분할")

    os.makedirs(args.out, exist_ok=True)
    base = args.base_url.rstrip("/")
    parts = []
    for i, g in enumerate(groups):
        part_name = f"gpu_pack.part{i + 1}.zip"
        part_path = os.path.join(args.out, part_name)
        print(f"[i] {part_name} 압축 중 ({len(g['files'])}개, {g['size']/2**30:.2f} GB)…")
        with zipfile.ZipFile(part_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
            for fn in g["files"]:
                z.write(os.path.join(src, fn), arcname=fn)
        size = os.path.getsize(part_path)
        digest = sha256_file(part_path)
        print(f"    -> {size/2**30:.2f} GB  sha256={digest[:16]}…")
        parts.append({
            "name": part_name,
            "url": f"{base}/{part_name}",
            "size": size,
            "sha256": digest,
        })

    manifest = {
        "schema": 1,
        "parts": parts,
        "dlls": REQUIRED_DLLS,
    }
    man_path = os.path.join(args.out, "manifest.json")
    with open(man_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    comp_total = sum(p["size"] for p in parts)
    print(f"\n[✓] 완료 — 압축 합계 {comp_total/2**30:.2f} GB, 매니페스트: {man_path}")
    print(f"    이제 {args.out} 의 part_*.zip 과 manifest.json 을 릴리즈에 업로드하세요.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
