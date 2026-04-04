from __future__ import annotations

import argparse
import base64
import hashlib
import shutil
import json
import secrets
from pathlib import Path
from typing import Optional
import core_utils

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes


INPUT_DIR = Path("input")
DOCS_DIR = Path("docs")
ASSETS_DIR = DOCS_DIR / "assets"
CATALOG_PATH = DOCS_DIR / "catalog.json"
MANIFEST_SEC_PATH = DOCS_DIR / "manifest.sec.json"

PBKDF2_ITERATIONS = 200_000
MANIFEST_VERSION = 2

# 音频分片：每片不超过 2MB
AUDIO_SEGMENT_MAX_BYTES = 2 * 1024 * 1024

AUDIO_EXTS = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}

TEXT_EXTS = {
    ".lrc": "text/plain; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
}

IMAGE_EXTS = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
}

SUPPORTED_EXTS = {}
SUPPORTED_EXTS.update(AUDIO_EXTS)
SUPPORTED_EXTS.update(TEXT_EXTS)
SUPPORTED_EXTS.update(IMAGE_EXTS)


def b64e(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64d(text: str) -> bytes:
    return base64.b64decode(text.encode("ascii"))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def derive_key_from_password(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def encrypt_bytes_aes_gcm(key: bytes, plain: bytes) -> dict:
    nonce = secrets.token_bytes(12)
    cipher = AESGCM(key).encrypt(nonce, plain, None)
    return {
        "nonce": b64e(nonce),
        "ciphertext": cipher,
    }


def encrypt_manifest_payload(payload: dict, password: str) -> dict:
    salt = secrets.token_bytes(16)
    key = derive_key_from_password(password, salt)
    plain = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    enc = encrypt_bytes_aes_gcm(key, plain)
    return {
        "version": MANIFEST_VERSION,
        "kdf": {
            "name": "PBKDF2",
            "hash": "SHA-256",
            "iterations": PBKDF2_ITERATIONS,
            "salt": b64e(salt),
        },
        "cipher": {
            "name": "AES-GCM",
            "nonce": enc["nonce"],
            "ciphertext": b64e(enc["ciphertext"]),
        },
    }


def decrypt_manifest_payload(manifest_sec: dict, password: str) -> dict:
    kdf = manifest_sec["kdf"]
    if kdf["name"] != "PBKDF2":
        raise ValueError("Unsupported KDF")
    if int(kdf["iterations"]) != PBKDF2_ITERATIONS:
        raise ValueError("PBKDF2 iterations mismatch")

    salt = b64d(kdf["salt"])
    key = derive_key_from_password(password, salt)

    cipher = manifest_sec["cipher"]
    plain = AESGCM(key).decrypt(
        b64d(cipher["nonce"]),
        b64d(cipher["ciphertext"]),
        None,
    )
    return json.loads(plain.decode("utf-8"))


def load_json(path: Path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")

# def base_name(stem: str):
#     """取 '-' 前的部分作为基名"""
#     if "-" in stem:
#         return stem.split("-", 1)[0]
#     return stem

# def find_cover(base: str):
#     for ext in IMAGE_EXTS.keys():
#         p = INPUT_DIR / f"{base}{ext}"
#         if p.exists():
#             return p.name
#     return None

def base_name(stem: str) -> str:
    """取 '-' 前的部分作为共享资源基名。"""
    if "-" in stem:
        return stem.split("-", 1)[0].strip()
    return stem.strip()


def find_cover_for_stem(stem: str) -> Optional[Path]:
    """
    查找封面顺序：

    1. 完全同名
       XXX-摇滚版.jpg

    2. 去掉 - 后缀
       XXX.jpg
    """

    # 1️⃣ 完全同名
    for ext in IMAGE_EXTS.keys():
        p = INPUT_DIR / f"{stem}{ext}"
        if p.exists():
            return p

    # 2️⃣ 去掉 - 后缀
    base = base_name(stem)

    if base != stem:
        for ext in IMAGE_EXTS.keys():
            p = INPUT_DIR / f"{base}{ext}"
            if p.exists():
                return p

    return None

def collect_input_groups() -> dict[str, dict[str, Path]]:
    if not INPUT_DIR.exists():
        raise FileNotFoundError("找不到 input 目录")

    groups: dict[str, dict[str, Path]] = {}
    for path in sorted(INPUT_DIR.iterdir()):
        if not path.is_file():
            continue
        ext = path.suffix.lower()
        if ext not in SUPPORTED_EXTS:
            continue
        groups.setdefault(path.stem, {})[ext] = path
    return groups


def choose_audio_file(stem_files: dict[str, Path]) -> Optional[Path]:
    for ext in AUDIO_EXTS:
        if ext in stem_files:
            return stem_files[ext]
    return None


def choose_cover_file(stem_files: dict[str, Path]) -> Optional[Path]:
    for ext in (".jpg", ".jpeg", ".png"):
        if ext in stem_files:
            return stem_files[ext]
    return None


def next_track_id(existing_catalog: list[dict]) -> str:
    max_num = 0
    for item in existing_catalog:
        tid = str(item.get("id", ""))
        if tid.startswith("t") and tid[1:].isdigit():
            max_num = max(max_num, int(tid[1:]))
    return f"t{max_num + 1:03d}"


def write_asset_cipher(cipher: bytes) -> str:
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    name = secrets.token_hex(12) + ".bin"
    out = ASSETS_DIR / name
    out.write_bytes(cipher)
    return f"assets/{name}"


def pack_single_asset(source_path: Path) -> dict:
    plain = source_path.read_bytes()
    dek = secrets.token_bytes(32)
    enc = encrypt_bytes_aes_gcm(dek, plain)
    rel_file = write_asset_cipher(enc["ciphertext"])

    ext = source_path.suffix.lower()
    if ext in TEXT_EXTS:
        mime = TEXT_EXTS[ext]
        kind = "text"
    elif ext in IMAGE_EXTS:
        mime = IMAGE_EXTS[ext]
        kind = "image"
    else:
        raise ValueError(f"unsupported single asset ext: {ext}")

    return {
        "kind": kind,
        "file": rel_file,
        "mime": mime,
        "nonce": enc["nonce"],
        "dek": b64e(dek),
        "size": len(plain),
        "source_name": source_path.name,
        "source_hash": sha256_file(source_path),
    }


def split_bytes(data: bytes, max_size: int) -> list[bytes]:
    return [data[i:i + max_size] for i in range(0, len(data), max_size)]


def pack_audio_segments(source_path: Path) -> dict:
    plain = source_path.read_bytes()
    ext = source_path.suffix.lower()
    mime = AUDIO_EXTS[ext]
    source_hash = sha256_bytes(plain)

    chunks = split_bytes(plain, AUDIO_SEGMENT_MAX_BYTES)
    segments = []

    for idx, chunk in enumerate(chunks):
        dek = secrets.token_bytes(32)
        enc = encrypt_bytes_aes_gcm(dek, chunk)
        rel_file = write_asset_cipher(enc["ciphertext"])
        segments.append({
            "index": idx,
            "file": rel_file,
            "mime": mime,
            "nonce": enc["nonce"],
            "dek": b64e(dek),
            "size": len(chunk),
            "plain_hash": sha256_bytes(chunk),
        })

    return {
        "kind": "audio-segmented",
        "mime": mime,
        "segment_max_bytes": AUDIO_SEGMENT_MAX_BYTES,
        "segment_count": len(segments),
        "total_size": len(plain),
        "source_name": source_path.name,
        "source_hash": source_hash,
        "segments": segments,
    }


def reuse_or_pack_single_asset(existing_asset: Optional[dict], source_path: Optional[Path]) -> Optional[dict]:
    if source_path is None:
        return None, False
    new_hash = sha256_file(source_path)
    if existing_asset and existing_asset.get("source_hash") == new_hash:
        return existing_asset, False
    return pack_single_asset(source_path), True


def reuse_or_pack_audio(existing_audio: Optional[dict], source_path: Path):
    new_hash = sha256_file(source_path)
    if existing_audio and existing_audio.get("source_hash") == new_hash:
        return existing_audio, False
    return pack_audio_segments(source_path), True


def build_library(password: str) -> None:
    groups = collect_input_groups()
    old_catalog = load_json(CATALOG_PATH) or {"version": 1, "tracks": []}
    old_manifest_sec = load_json(MANIFEST_SEC_PATH)

    old_payload = {"tracks": {}}
    if old_manifest_sec:
        old_payload = decrypt_manifest_payload(old_manifest_sec, password)

    old_catalog_tracks = old_catalog.get("tracks", [])
    old_catalog_map = {t["stem"]: t for t in old_catalog_tracks}
    old_tracks_map = old_payload.get("tracks", {})

    new_catalog_tracks: list[dict] = []
    new_tracks_payload: dict[str, dict] = {}
    used_asset_files: set[str] = set()

    added_assets = []

    for stem in sorted(groups.keys()):
        stem_files = groups[stem]
        audio_path = choose_audio_file(stem_files)
        if not audio_path:
            continue

        old_catalog_track = old_catalog_map.get(stem)
        old_track_payload = old_tracks_map.get(stem, {})

        if old_catalog_track:
            track_id = old_catalog_track["id"]
        else:
            track_id = next_track_id(new_catalog_tracks + old_catalog_tracks)

        # lrc_path = stem_files.get(".lrc")
        # txt_path = stem_files.get(".txt")
        # cover_path = choose_cover_file(stem_files)
        lrc_path = stem_files.get(".lrc")
        txt_path = stem_files.get(".txt")
        cover_path = find_cover_for_stem(stem)

        audio_asset, packNew = reuse_or_pack_audio(old_track_payload.get("audio"), audio_path)
        lrc_asset, packNewLrc = reuse_or_pack_single_asset(old_track_payload.get("lrc"), lrc_path)
        txt_asset, packNewTxt = reuse_or_pack_single_asset(old_track_payload.get("txt"), txt_path)
        cover_asset, packNewCover = reuse_or_pack_single_asset(old_track_payload.get("cover"), cover_path)

        if packNew: added_assets.append(audio_path)
        if packNewLrc: added_assets.append(lrc_path)
        if packNewTxt: added_assets.append(txt_path)
        if packNewCover: added_assets.append(cover_path)

        new_catalog_tracks.append({
            "id": track_id,
            "stem": stem,
            "title": stem,
            "has_lrc": lrc_asset is not None,
            "has_txt": txt_asset is not None,
            "has_cover": cover_asset is not None,
            "segment_count": audio_asset["segment_count"],
            "mime": audio_asset["mime"],
        })

        track_payload = {
            "id": track_id,
            "title": stem,
            "audio": audio_asset,
            "lrc": lrc_asset,
            "txt": txt_asset,
            "cover": cover_asset,
        }
        new_tracks_payload[stem] = track_payload

        for seg in audio_asset["segments"]:
            used_asset_files.add(seg["file"])
        for asset in (lrc_asset, txt_asset, cover_asset):
            if asset and asset.get("file"):
                used_asset_files.add(asset["file"])

    new_catalog = {
        "version": 1,
        "tracks": new_catalog_tracks,
        "audio_segment_max_bytes": AUDIO_SEGMENT_MAX_BYTES,
    }
    save_json(CATALOG_PATH, new_catalog)

    new_payload = {
        "version": 1,
        "tracks": new_tracks_payload,
        "audio_segment_max_bytes": AUDIO_SEGMENT_MAX_BYTES,
    }
    new_manifest_sec = encrypt_manifest_payload(new_payload, password)
    save_json(MANIFEST_SEC_PATH, new_manifest_sec)

    cleanup_unused_assets(used_asset_files)

    for trk in added_assets:
        core_utils.Logs.done(f"新增入库资产：{trk}")
        targetpath = str(trk).replace("input","output")
        shutil.copy(trk,targetpath)
        core_utils.Logs.info(f"已备份至临时输出目录：{targetpath}")

    core_utils.Logs.done(f"已生成 {len(new_catalog_tracks)} 首")
    print(f"catalog: {CATALOG_PATH}")
    print(f"manifest: {MANIFEST_SEC_PATH}")
    print(f"assets: {ASSETS_DIR}")


def cleanup_unused_assets(used_files: set[str]) -> None:
    if not ASSETS_DIR.exists():
        return
    used_names = {Path(p).name for p in used_files}
    for path in ASSETS_DIR.iterdir():
        if path.is_file() and path.name not in used_names:
            path.unlink()


def rotate_password(old_password: str, new_password: str) -> None:
    manifest_sec = load_json(MANIFEST_SEC_PATH)
    if not manifest_sec:
        raise FileNotFoundError("找不到 manifest.sec.json")

    payload = decrypt_manifest_payload(manifest_sec, old_password)
    new_manifest_sec = encrypt_manifest_payload(payload, new_password)
    save_json(MANIFEST_SEC_PATH, new_manifest_sec)
    print("已轮换口令，仅更新 manifest.sec.json")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_build = sub.add_parser("build", help="增量构建曲库")
    p_build.add_argument("--password", required=True, help="当前口令")

    p_rotate = sub.add_parser("rotate", help="轮换口令")
    p_rotate.add_argument("--old-password", required=True)
    p_rotate.add_argument("--new-password", required=True)

    args = parser.parse_args()

    if args.cmd == "build":
        build_library(args.password)
    elif args.cmd == "rotate":
        rotate_password(args.old_password, args.new_password)


if __name__ == "__main__":
    main()
# Running:
# python encrypt_library.py build --password "口令"