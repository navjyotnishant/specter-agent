from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.core.config import get_settings
from app.db.session import initialize_database
from app.routers import agents, approvals, auth, connectors, health, memory, model_providers, runs, runtime_adapters, skills, workflows
from app.runtime.graph_runner import recover_approved_waiting_runs
from app.runtime.skill_seeds import seed_standard_report_format_skill
from app.runtime.workflows import seed_security_review_workflow, seed_claude_code_review_workflow

settings = get_settings()
app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def on_startup() -> None:
    initialize_database()
    seed_security_review_workflow()
    seed_claude_code_review_workflow()
    seed_standard_report_format_skill()
    recover_approved_waiting_runs()


app.include_router(health.router, prefix=settings.api_prefix)
app.include_router(auth.router, prefix=settings.api_prefix)
app.include_router(model_providers.router, prefix=settings.api_prefix)
app.include_router(runtime_adapters.router, prefix=settings.api_prefix)
app.include_router(skills.router, prefix=settings.api_prefix)
app.include_router(connectors.router, prefix=settings.api_prefix)
app.include_router(workflows.router, prefix=settings.api_prefix)
app.include_router(agents.router, prefix=settings.api_prefix)
app.include_router(approvals.router, prefix=settings.api_prefix)
app.include_router(memory.router, prefix=settings.api_prefix)
app.include_router(runs.router, prefix=settings.api_prefix)

frontend_dir = Path("/app/frontend")
if frontend_dir.exists():
    assets_dir = frontend_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="frontend-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_frontend(full_path: str) -> FileResponse:
        requested_path = frontend_dir / full_path
        if requested_path.is_file():
            return FileResponse(requested_path)
        return FileResponse(frontend_dir / "index.html")
