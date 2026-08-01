"""Per-user integration credentials, encrypted at rest.

The Telegram bot token used to live only in ~/.specter/telegram.json on the
host. That made it machine-global rather than user-owned, and put a plaintext
secret outside the app's own storage. Credentials now belong to the signed-in
user; the host runner still receives a copy because it is the process that
polls Telegram, but the database is the source of truth.
"""
from __future__ import annotations

import json

from app.db.session import db_session
from app.runtime.secretbox import decrypt, encrypt


def save_integration(user_id: str, provider: str, secret: str, config: dict) -> None:
    """Upsert a user's credentials. An empty `secret` keeps the stored one."""
    with db_session() as db:
        row = db.execute(
            "SELECT secret_enc FROM user_integrations WHERE user_id = ? AND provider = ?",
            (user_id, provider),
        ).fetchone()
        secret_enc = encrypt(secret) if secret else (row["secret_enc"] if row else "")
        db.execute(
            """
            INSERT INTO user_integrations (user_id, provider, secret_enc, config_json, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id, provider) DO UPDATE SET
                secret_enc = excluded.secret_enc,
                config_json = excluded.config_json,
                updated_at = CURRENT_TIMESTAMP
            """,
            (user_id, provider, secret_enc, json.dumps(config)),
        )


def get_integration(user_id: str, provider: str) -> dict | None:
    """Return {secret, config} with the secret decrypted, or None."""
    with db_session() as db:
        row = db.execute(
            "SELECT secret_enc, config_json, updated_at FROM user_integrations"
            " WHERE user_id = ? AND provider = ?",
            (user_id, provider),
        ).fetchone()
    if not row:
        return None
    return {
        "secret": decrypt(row["secret_enc"]),
        "config": json.loads(row["config_json"] or "{}"),
        "updated_at": row["updated_at"],
    }


def secret_hint(secret: str) -> str:
    """Last 4 chars, for confirming *which* token is stored without exposing it."""
    return f"…{secret[-4:]}" if len(secret) > 4 else ""


def demo() -> None:
    """Self-check: blank secret preserves the stored one, config still updates."""
    from uuid import uuid4

    # user_integrations has an enforced FK to users -- create a throwaway row.
    uid = f"selfcheck-{uuid4()}"
    with db_session() as db:
        db.execute(
            "INSERT INTO users (id, email, password_hash) VALUES (?, ?, '')",
            (uid, f"{uid}@selfcheck.invalid"),
        )
    save_integration(uid, "telegram", "123:AAA-TESTONLY", {"allowed_chat_ids": ["1"]})
    got = get_integration(uid, "telegram")
    assert got and got["secret"] == "123:AAA-TESTONLY", got

    save_integration(uid, "telegram", "", {"allowed_chat_ids": ["1", "2"]})
    got = get_integration(uid, "telegram")
    assert got["secret"] == "123:AAA-TESTONLY", "blank secret must not wipe the token"
    assert got["config"]["allowed_chat_ids"] == ["1", "2"], "config must still update"

    with db_session() as db:
        stored = db.execute(
            "SELECT secret_enc FROM user_integrations WHERE user_id = ?", (uid,)
        ).fetchone()["secret_enc"]
        assert "TESTONLY" not in stored, "token must not sit in the DB in plaintext"
        db.execute("DELETE FROM user_integrations WHERE user_id = ?", (uid,))
        db.execute("DELETE FROM users WHERE id = ?", (uid,))

    assert get_integration(uid, "telegram") is None
    assert secret_hint("123456:ABCDwwY") == "…DwwY"
    print("integrations self-check OK")


if __name__ == "__main__":
    demo()
