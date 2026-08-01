"""Encrypted-at-rest storage for per-user integration credentials.

Fernet (cryptography) -- AES-128-CBC + HMAC-SHA256 with an authenticated,
versioned token format. Decryption of a tampered or truncated value raises
rather than returning garbage, so `decrypt` can treat any failure as "absent".

The key lives in `secrets/` (gitignored, mounted into the container), mode 0600.
Losing it means every stored credential must be re-entered -- back up that file
alongside the database, not separately.
"""
from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import get_settings

_KEY_FILENAME = "integration_secret.key"


def _key_path() -> Path:
    settings = get_settings()
    base = getattr(settings, "secrets_dir", None) or (settings.data_dir.parent / "secrets")
    return Path(base) / _KEY_FILENAME


def _fernet() -> Fernet:
    """Load the key, generating it on first use."""
    path = _key_path()
    if path.is_file():
        return Fernet(path.read_text().strip().encode())

    key = Fernet.generate_key()
    path.parent.mkdir(parents=True, exist_ok=True)
    # os.open with 0600 so the key is never briefly world-readable.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(key)
    return Fernet(key)


def encrypt(plaintext: str) -> str:
    """Return a Fernet token. Empty input stays empty (means "not set")."""
    if not plaintext:
        return ""
    return _fernet().encrypt(plaintext.encode("utf-8")).decode()


def decrypt(token: str) -> str:
    """Inverse of encrypt(). Returns "" if absent, tampered with, or written
    under a previous key -- callers treat that as "no credential stored"."""
    if not token:
        return ""
    try:
        return _fernet().decrypt(token.encode()).decode("utf-8")
    except (InvalidToken, ValueError):
        return ""


def demo() -> None:
    """Self-check: round-trip, tamper detection, empty handling, key reuse."""
    secret = "123456:AAEEabcdefghijklmnop-TESTONLY"
    box = encrypt(secret)
    assert box != secret and secret not in box, "plaintext must not survive"
    assert decrypt(box) == secret, "round-trip failed"
    assert encrypt("") == "" and decrypt("") == ""
    assert decrypt("not-a-fernet-token") == "", "garbage must not raise"

    # Flip a byte in the ciphertext body; the HMAC must reject it.
    tampered = box[:30] + ("A" if box[30] != "A" else "B") + box[31:]
    assert decrypt(tampered) == "", "tamper not detected"

    assert encrypt(secret) != encrypt(secret), "each token carries a fresh IV"
    print("secretbox self-check OK")


if __name__ == "__main__":
    demo()
