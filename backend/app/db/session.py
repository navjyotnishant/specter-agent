import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from app.core.config import get_settings


SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  base_url TEXT,
  is_configured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  prompt_template TEXT NOT NULL DEFAULT '',
  compatible_agent_roles TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  is_configured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_instructions TEXT NOT NULL DEFAULT '',
  default_provider_id TEXT,
  default_model TEXT,
  allowed_skill_ids TEXT NOT NULL DEFAULT '[]',
  allowed_connector_ids TEXT NOT NULL DEFAULT '[]',
  memory_scope_default TEXT NOT NULL DEFAULT 'workflow',
  max_iterations INTEGER NOT NULL DEFAULT 3,
  requires_approval_default INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  graph_json TEXT NOT NULL DEFAULT '{}',
  is_template INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger_type TEXT NOT NULL DEFAULT 'manual',
  final_report TEXT,
  graph_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY(workflow_id) REFERENCES workflows(id)
);

CREATE TABLE IF NOT EXISTS workflow_step_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
);

CREATE TABLE IF NOT EXISTS run_logs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  agent_role TEXT NOT NULL,
  provider_id TEXT,
  model TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  summary TEXT,
  error TEXT,
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id)
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL,
  sender_type TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id)
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent_run_id TEXT,
  key TEXT NOT NULL,
  value_text TEXT NOT NULL,
  sensitivity_label TEXT NOT NULL DEFAULT 'internal',
  created_by_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  workflow_step_run_id TEXT,
  agent_run_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  proposed_action_json TEXT NOT NULL DEFAULT '{}',
  context_summary TEXT NOT NULL DEFAULT '',
  requested_by_agent TEXT,
  resolved_by_user_id TEXT,
  resolved_at TEXT,
  resolution_comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(workflow_run_id) REFERENCES workflow_runs(id),
  FOREIGN KEY(agent_run_id) REFERENCES agent_runs(id)
);

CREATE TABLE IF NOT EXISTS runtime_workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT UNIQUE NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS runtime_runs (
  id TEXT PRIMARY KEY,
  runtime_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  prompt TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'read-only',
  status TEXT NOT NULL,
  exit_code INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  error TEXT,
  requested_by TEXT,
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(workspace_id) REFERENCES runtime_workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_created_at ON workflow_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_memory_entries_run_id ON memory_entries(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_id ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_runtime_workspaces_active ON runtime_workspaces(is_active);
CREATE INDEX IF NOT EXISTS idx_runtime_runs_workspace_id ON runtime_runs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_runtime_runs_status ON runtime_runs(status);
"""


def get_database_path() -> Path:
    return get_settings().database_path


def connect() -> sqlite3.Connection:
    path = get_database_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    connection.execute("PRAGMA synchronous = NORMAL")
    return connection


@contextmanager
def db_session() -> Iterator[sqlite3.Connection]:
    connection = connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database() -> None:
    with db_session() as db:
        db.executescript(SCHEMA)
        _add_column_if_missing(db, "users", "updated_at", "TEXT")
        _add_column_if_missing(db, "runtime_workspaces", "updated_at", "TEXT")
        _add_column_if_missing(db, "workflow_runs", "graph_json", "TEXT NOT NULL DEFAULT '{}'")
        db.execute("UPDATE users SET updated_at = created_at WHERE updated_at IS NULL")
        db.execute("UPDATE runtime_workspaces SET updated_at = created_at WHERE updated_at IS NULL")


def _add_column_if_missing(db: sqlite3.Connection, table_name: str, column_name: str, column_type: str) -> None:
    columns = [row["name"] for row in db.execute(f"PRAGMA table_info({table_name})").fetchall()]
    if column_name not in columns:
        db.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")
