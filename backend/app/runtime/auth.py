import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import Header, HTTPException, status
from passlib.context import CryptContext

from app.db.session import db_session

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
SESSION_DAYS = 7


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_user(row) -> dict:
    return {
        "id": row["id"],
        "email": row["email"],
        "role": row["role"],
        "created_at": row["created_at"],
    }


def has_any_user() -> bool:
    with db_session() as db:
        row = db.execute("SELECT COUNT(*) AS count FROM users").fetchone()
        return row["count"] > 0


def bootstrap_admin(email: str, password: str) -> dict:
    if has_any_user():
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Admin user already exists")

    user_id = str(uuid4())
    with db_session() as db:
        db.execute(
            "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
            (user_id, email.lower().strip(), hash_password(password)),
        )
        row = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return public_user(row)


def authenticate(email: str, password: str) -> tuple[dict, str]:
    with db_session() as db:
        row = db.execute("SELECT * FROM users WHERE email = ?", (email.lower().strip(),)).fetchone()
        if not row or not verify_password(password, row["password_hash"]):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

        token = secrets.token_urlsafe(32)
        session_id = str(uuid4())
        expires_at = (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).isoformat()
        db.execute(
            "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
            (session_id, row["id"], hash_token(token), expires_at),
        )
        return public_user(row), token


def issue_service_token(user_id: str, days: int = 365) -> str:
    """Mint a long-lived session for a background integration.

    The Telegram poller runs outside the app and needs to call the API on the
    configuring user's behalf. Minting here means the user never has to find and
    paste their own browser token; revoking is the same as any other session.
    """
    token = secrets.token_urlsafe(32)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    with db_session() as db:
        db.execute(
            "INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)",
            (str(uuid4()), user_id, hash_token(token), expires_at),
        )
    return token


def get_user_for_token(token: str) -> dict | None:
    with db_session() as db:
        row = db.execute(
            """
            SELECT users.*
            FROM auth_sessions
            JOIN users ON users.id = auth_sessions.user_id
            WHERE auth_sessions.token_hash = ?
              AND auth_sessions.revoked_at IS NULL
              AND auth_sessions.expires_at > ?
            """,
            (hash_token(token), datetime.now(timezone.utc).isoformat()),
        ).fetchone()
        return public_user(row) if row else None


def revoke_token(token: str) -> None:
    with db_session() as db:
        db.execute(
            "UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND revoked_at IS NULL",
            (hash_token(token),),
        )


def require_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

    user = get_user_for_token(authorization.removeprefix("Bearer ").strip())
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or expired session")
    return user


def require_admin(authorization: str | None = Header(default=None)) -> dict:
    user = require_user(authorization)
    if user["role"] != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user
