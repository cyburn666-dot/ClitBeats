from __future__ import annotations

import json
import mimetypes
import secrets
from pathlib import Path
from typing import Iterable

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes


INPUT_DIR = Path("input")
WEB_DIR = Path("web")
ASSETS_DIR = WEB_DIR / "assets"
MANIFEST_PATH = WEB_DIR / "manifest.json"

# 这里改成你每次要给对方的口令
PASSWORD = "请输入口令"

# PBKDF2 参数，前后端必须一致
PBKDF2_ITERATIONS = 200_000

# 支持的输入格式
SUPPORTED_EXTS = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".flac": "audio/flac",
}


def derive_master_key(password: str, salt: bytes) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=PBKDF2_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def guess_mime(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in SUPPORTED_EXTS:
        return SUPPORTED_EXTS[ext]
    guessed, _ = mimetypes.guess_type(path.name)
    return guessed or "application/octet-stream"


def iter_audio_files(input_dir: Path) -> Iterable[Path]:
    for path in sorted(input_dir.iterdir()):
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXTS:
            yield path


def clean_old_assets():
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    for p in ASSETS_DIR.glob("*"):
        if p.is_file():
            p.unlink()


def encrypt_tracks(password: str):
    if not INPUT_DIR.exists():
        raise FileNotFoundError("找不到 input 目录")

    files = list(iter_audio_files(INPUT_DIR))
    if not files:
        raise FileNotFoundError("input 目录下没有可加密的音频文件")

    clean_old_assets()

    # 所有歌曲共用同一主口令，只派生一次主密钥
    master_salt = secrets.token_bytes(16)
    master_key = derive_master_key(password, master_salt)

    manifest = {
        "version": 1,
        "kdf": {
            "name": "PBKDF2",
            "hash": "SHA-256",
            "iterations": PBKDF2_ITERATIONS,
            "salt": master_salt.hex(),
        },
        "tracks": [],
    }

    key_wrapper = AESGCM(master_key)

    for idx, path in enumerate(files, start=1):
        plain = path.read_bytes()

        # 每首歌自己的 DEK
        dek = AESGCM.generate_key(bit_length=256)

        # 用 DEK 加密音频内容
        data_nonce = secrets.token_bytes(12)
        data_cipher = AESGCM(dek).encrypt(data_nonce, plain, None)

        random_name = secrets.token_hex(12) + ".bin"
        out_path = ASSETS_DIR / random_name
        out_path.write_bytes(data_cipher)

        # 用主密钥包裹 DEK
        wrap_nonce = secrets.token_bytes(12)
        wrapped_dek = key_wrapper.encrypt(wrap_nonce, dek, None)

        manifest["tracks"].append({
            "id": f"t{idx:03d}",
            "title": path.stem,   # 若不想暴露真实歌名，可改成 Track 01 之类
            "file": f"assets/{random_name}",
            "mime": guess_mime(path),
            "size": len(plain),
            "data_nonce": data_nonce.hex(),
            "wrapped_dek": wrapped_dek.hex(),
            "wrap_nonce": wrap_nonce.hex(),
        })

    MANIFEST_PATH.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"已加密 {len(files)} 首")
    print(f"manifest: {MANIFEST_PATH}")
    print(f"assets:   {ASSETS_DIR}")


if __name__ == "__main__":
    encrypt_tracks(PASSWORD)