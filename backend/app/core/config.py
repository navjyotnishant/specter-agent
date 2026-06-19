from functools import lru_cache
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "Specter Agent"
    api_prefix: str = "/api"
    data_dir: Path = Path("/app/data")
    artifacts_dir: Path = Path("/app/artifacts")
    database_path: Path = Path("/app/data/app.db")
    scheduler_enabled: bool = True
    cors_origins: list[str] = ["http://localhost:5173", "http://localhost:3000"]

    class Config:
        env_prefix = "SDLC_"
        env_file = ".env"


@lru_cache
def get_settings() -> Settings:
    settings = Settings()
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    settings.artifacts_dir.mkdir(parents=True, exist_ok=True)
    return settings
