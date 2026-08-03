from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field, field_validator

from app.db.session import db_session
from app.runtime.auth import (
    authenticate,
    bootstrap_admin,
    hash_password,
    has_any_user,
    require_admin,
    require_user,
    revoke_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])
MAX_BCRYPT_PASSWORD_BYTES = 72


class AuthRequest(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=72)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value.lower().strip()
        if "@" not in normalized or "." not in normalized.rsplit("@", 1)[-1]:
            raise ValueError("Invalid email address")
        return normalized

    @field_validator("password")
    @classmethod
    def validate_password(cls, value: str) -> str:
        if len(value.encode("utf-8")) > MAX_BCRYPT_PASSWORD_BYTES:
            raise ValueError("Password must be 72 bytes or fewer.")
        return value


class CreateUserRequest(AuthRequest):
    role: str = "operator"


@router.get("/status")
def auth_status() -> dict:
    return {"needs_setup": not has_any_user()}


@router.post("/bootstrap")
def bootstrap(request: AuthRequest) -> dict:
    user = bootstrap_admin(request.email, request.password)
    return {"user": user}


@router.post("/login")
def login(request: AuthRequest) -> dict:
    user, token = authenticate(request.email, request.password)
    with db_session() as db:
        db.execute("UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?", (user["id"],))
    return {"user": user, "token": token}


@router.post("/logout")
def logout(authorization: str | None = Header(default=None)) -> dict:
    if authorization and authorization.startswith("Bearer "):
        revoke_token(authorization.removeprefix("Bearer ").strip())
    return {"ok": True}


@router.get("/me")
def me(user: dict = Depends(require_user)) -> dict:
    return {"user": user}


@router.get("/users")
def list_users(_: dict = Depends(require_admin)) -> list[dict]:
    with db_session() as db:
        rows = db.execute(
            "SELECT id, email, role, created_at, last_seen_at FROM users ORDER BY created_at DESC"
        ).fetchall()
        return [dict(row) for row in rows]


@router.post("/users")
def create_user(request: CreateUserRequest, _: dict = Depends(require_admin)) -> dict:
    if request.role not in {"admin", "operator"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be admin or operator")

    user_id = str(uuid4())
    with db_session() as db:
        try:
            db.execute(
                "INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)",
                (user_id, request.email.lower().strip(), hash_password(request.password), request.role),
            )
        except Exception:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="User already exists")
        row = db.execute("SELECT id, email, role, created_at FROM users WHERE id = ?", (user_id,)).fetchone()
        return dict(row)


@router.delete("/users/{user_id}")
def delete_user(user_id: str, current_user: dict = Depends(require_admin)) -> dict:
    if user_id == current_user["id"]:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot delete your own account")

    with db_session() as db:
        db.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
        deleted = db.execute("DELETE FROM users WHERE id = ?", (user_id,)).rowcount
    return {"deleted": deleted > 0, "user_id": user_id}

def _validated_password(value: str) -> str:
    """Shared password rules. bcrypt ignores everything past 72 bytes, so a
    longer password would be accepted and then silently truncated — the user
    would believe they set something stronger than what actually guards the
    account."""
    if len(value) < 8:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be at least 8 characters")
    if len(value.encode("utf-8")) > MAX_BCRYPT_PASSWORD_BYTES:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Password must be 72 bytes or fewer")
    return value


class ChangeRoleRequest(BaseModel):
    role: str


@router.patch("/users/{user_id}/role")
def change_user_role(user_id: str, request: ChangeRoleRequest, current_user: dict = Depends(require_admin)) -> dict:
    """Change a user's role.

    Previously this meant delete-and-recreate, which destroyed the account's
    integrations along with it.
    """
    if request.role not in {"admin", "operator"}:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Role must be admin or operator")

    with db_session() as db:
        row = db.execute("SELECT id, role FROM users WHERE id = ?", (user_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

        # Demoting the last admin locks everyone out of user management with no
        # recovery path, so it is refused rather than merely warned about.
        if row["role"] == "admin" and request.role != "admin":
            admins = db.execute("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").fetchone()["n"]
            if admins <= 1:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="This is the only admin account — promote another user before changing this one",
                )

        db.execute(
            "UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (request.role, user_id),
        )
        updated = db.execute(
            "SELECT id, email, role, created_at, last_seen_at FROM users WHERE id = ?", (user_id,)
        ).fetchone()
    return dict(updated)


class ResetPasswordRequest(BaseModel):
    password: str


@router.post("/users/{user_id}/password")
def reset_user_password(user_id: str, request: ResetPasswordRequest, _: dict = Depends(require_admin)) -> dict:
    """Admin reset for a locked-out user, who otherwise has no recovery path."""
    _validated_password(request.password)

    with db_session() as db:
        if not db.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
        db.execute(
            "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (hash_password(request.password), user_id),
        )
        # Every existing session for that user is now stale — a password reset
        # that leaves old sessions live has not actually locked anyone out.
        db.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
    return {"ok": True, "user_id": user_id}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/password")
def change_own_password(request: ChangePasswordRequest, current_user: dict = Depends(require_user)) -> dict:
    """Self-service change. Requires the current password: a stolen session
    token must not be enough to take over the account permanently."""
    _validated_password(request.new_password)

    with db_session() as db:
        row = db.execute("SELECT password_hash FROM users WHERE id = ?", (current_user["id"],)).fetchone()
        if not row or not verify_password(request.current_password, row["password_hash"]):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Current password is incorrect")
        db.execute(
            "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (hash_password(request.new_password), current_user["id"]),
        )
    return {"ok": True}
