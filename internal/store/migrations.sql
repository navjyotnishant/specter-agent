-- Extracted from _add_column_if_missing() calls in backend/app/db/session.py.
-- SQLite has no ADD COLUMN IF NOT EXISTS, so each runs independently and a
-- "duplicate column name" error means it is already applied -- not a failure.

ALTER TABLE users ADD COLUMN updated_at TEXT;
ALTER TABLE runtime_workspaces ADD COLUMN updated_at TEXT;
ALTER TABLE workflow_runs ADD COLUMN graph_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflow_runs ADD COLUMN workspace_path TEXT;
ALTER TABLE approval_requests ADD COLUMN expires_at TEXT;
ALTER TABLE skills ADD COLUMN source_repo TEXT NOT NULL DEFAULT '';
ALTER TABLE workflow_runs ADD COLUMN run_input_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE workflows ADD COLUMN workspace_path TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_seen_at TEXT;
