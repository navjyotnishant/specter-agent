from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Specter Agent"
    api_prefix: str = "/api"
    data_dir: Path = Path("/app/data")
    artifacts_dir: Path = Path("/app/artifacts")
    database_path: Path = Path("/app/data/app.db")
    # 127.0.0.1 because native is the primary deployment. The Docker path
    # overrides this to host.docker.internal in docker-compose.yml, where that
    # address actually resolves -- it never did outside a container.
    host_runner_url: str = "http://127.0.0.1:8765"
    # How the host-side Telegram poller reaches this API (reverse of host_runner_url).
    telegram_backend_url: str = "http://127.0.0.1:8000"
    host_runner_timeout_seconds: float = 2.0
    scheduler_enabled: bool = True
    # The Vite dev server binds 8080 (see vite.config.ts), and a browser treats
    # localhost and 127.0.0.1 as DIFFERENT origins -- so both spellings of each
    # are listed. Without 8080 the dev frontend cannot make a single request.
    cors_origins: list[str] = [
        "http://localhost:8080", "http://127.0.0.1:8080",
        "http://localhost:5173", "http://127.0.0.1:5173",
        "http://localhost:3000", "http://127.0.0.1:3000",
    ]

    # Linear integration (opt-in — no-op if token not set)
    linear_api_token: str = ""
    linear_team_id: str = "SPE"
    linear_project_name: str = "specter-agent"

    class Config:
        env_prefix = "SDLC_"
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    return settings
