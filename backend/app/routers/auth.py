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
)

router = APIRouter(prefix="/auth", tags=["auth"])


class AuthRequest(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=256)

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        normalized = value.lower().strip()
        if "@" not in normalized or "." not in normalized.rsplit("@", 1)[-1]:
            raise ValueError("Invalid email address")
        return normalized


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
        rows = db.execute("SELECT id, email, role, created_at FROM users ORDER BY created_at DESC").fetchall()
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
