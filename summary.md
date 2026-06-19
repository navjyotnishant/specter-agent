# Local Multi-Agent SDLC Automation Platform — Project Summary

## Project Overview

This project is a local-first AI SDLC command center for building, running, and auditing multi-agent software delivery workflows. The platform is intended to be container-deployable and centered around a local SQLite database, with local volumes for database state, artifacts, secrets/configuration, and mounted codebases.

The long-term product goal is to let a user locally deploy the app, create an admin account, configure model providers and connectors, define reusable skills, then build and run supervisor-led multi-agent SDLC workflows such as a Security Review Team.

A Security Review Team workflow is expected to coordinate agents such as:

- Security Supervisor Agent
- Code Security Reviewer Agent
- Dependency Vulnerability Agent
- Secrets & Configuration Agent
- Report Writer Agent

The intended runtime model is supervisor delegation: a supervisor receives a high-level objective, creates a bounded task plan, delegates work to known specialist agents, shares structured memory/context, pauses for human approval when required, and produces an auditable final report.

## Core Technology Stack

### Frontend

- React
- TypeScript
- React Router
- Tailwind CSS
- shadcn/ui components
- lucide-react icons
- TanStack React Query
- React Flow via `@xyflow/react`

### Backend

- Python
- FastAPI
- SQLite
- Local filesystem volumes for data/artifacts/secrets/codebases

### Deployment Direction

- Dockerfile added
- Docker Compose added
- SQLite database path defaults to `/app/data/app.db`
- Recommended local volume mapping includes:
  - `./data:/app/data`
  - `./artifacts:/app/artifacts`
  - `./secrets:/app/secrets`
  - `./codebases:/app/codebases:ro`

## Implemented Work So Far

### 1. Frontend Product Shell

The blank starter UI was replaced with a polished local-first product experience.

Implemented pages and routes include:

- `/` — product landing page
- `/setup` — first-admin bootstrap UI
- `/login` — local login UI
- `/dashboard` — command-center dashboard
- `/workflows` — workflow area shell/list route
- `/workflows/:workflowId/builder` — Security Review Team visual builder
- `/skills` — skill library management page
- `/skills/:skillId` — skill detail placeholder
- `/runs` — run history placeholder
- `/runs/:runId` — run detail placeholder
- `/approvals` — pending approvals page
- `/settings/models` — model provider management page
- `/settings/connectors` — connector management page
- `/settings/users` — local users management page
- `/settings` — redirects to model settings
- `/admin` — admin settings placeholder

The frontend now includes:

- App shell layout
- Sidebar navigation
- Top bar with local runtime indicators
- Logout control
- Current user badge
- Preview-safe auth fallback when the FastAPI backend is not running

### 2. Dashboard

The dashboard visually communicates the product as an AI SDLC command center.

Implemented dashboard sections include:

- Runtime status cards
- SQLite health card
- Scheduler status display
- Agent Teams section
- Security Review Team template card
- Testing/QA Team placeholder
- Release Automation Team placeholder
- Custom Agent Team placeholder
- Model provider / connector / skill summary cards

### 3. Visual Workflow Builder

A visual workflow builder was added using React Flow.

Implemented builder features include:

- Left node palette with categories:
  - Agents
  - AI + Skills
  - Code + SDLC Tools
  - Control Flow
  - Memory + Context
- Custom visual node components:
  - Supervisor Agent Node
  - Specialist Agent Node
  - Human Approval Node
  - Memory Node
- Security Review Team graph mock/template view
- Agent inspector panel
- Run timeline tab
- Structured memory tab
- Distinct styling for supervisor, specialist, approval, and memory nodes

The builder currently provides a strong visual shell, but full graph persistence and runtime execution are still pending.

### 4. Agent and Workflow UI Components

Implemented reusable frontend components include:

- `AgentCard`
- `AgentInspector`
- `AgentTimeline`
- `ApprovalCard`
- `ApprovalDialog`
- `MemoryPanel`
- Custom React Flow nodes for agents, approvals, and memory

### 5. Backend SQLite Foundation

A FastAPI backend skeleton was added under `backend/app`.

Implemented backend foundation includes:

- FastAPI app entrypoint
- CORS middleware
- Startup database initialization
- SQLite session utility
- WAL mode enabled through `PRAGMA journal_mode = WAL`
- Foreign keys enabled
- Normal synchronous mode configured
- Health endpoint

The health endpoint reports:

- API status
- SQLite status
- SQLite journal mode
- Database path
- Scheduler status
- Runtime mode

### 6. SQLite Schema Foundation

The SQLite schema currently includes tables for:

- `users`
- `auth_sessions`
- `model_providers`
- `skills`
- `connectors`
- `agent_definitions`
- `workflows`
- `workflow_runs`
- `workflow_step_runs`
- `run_logs`
- `agent_runs`
- `agent_messages`
- `memory_entries`
- `approval_requests`

Indexes were added for important lookup paths such as:

- workflow run status
- workflow ID
- workflow run created timestamp
- approval status
- memory run ID
- auth session token hash
- auth session user ID

### 7. Local Authentication Foundation

Local multi-user authentication has been started.

Implemented backend auth features include:

- Admin bootstrap endpoint
- Login endpoint
- Logout endpoint
- Current user endpoint
- User list endpoint
- User creation endpoint
- User deletion endpoint
- Bcrypt password hashing
- Bearer-token session storage in SQLite
- Session revocation
- Admin-only user management protection

Implemented frontend auth features include:

- Auth provider
- Persistent local token/user storage
- Protected routes
- Setup form for first admin
- Login form
- Logout button
- User management page
- Preview-mode fallback for the Vite-only preview

### 8. Model Providers Foundation

Model provider CRUD foundations have been added.

Backend API routes include:

- `GET /api/model-providers`
- `POST /api/model-providers`
- `PATCH /api/model-providers/{provider_id}`
- `DELETE /api/model-providers/{provider_id}`

Frontend `/settings/models` page includes:

- Provider list
- Add provider form
- Provider type selector
- Base URL field
- Configured/draft status switch
- Delete action
- Preview cards for:
  - Ollama
  - OpenAI-compatible
  - Anthropic-compatible

Actual model invocation, provider secret handling, model discovery, and test-connection behavior are still pending.

### 9. Skills Foundation

Skills CRUD foundations have been added.

Backend API routes include:

- `GET /api/skills`
- `GET /api/skills/{skill_id}`
- `POST /api/skills`
- `PATCH /api/skills/{skill_id}`
- `DELETE /api/skills/{skill_id}`

Frontend `/skills` page includes:

- Skill list
- Add skill form
- Compatible roles field
- Description field
- Prompt template field
- Delete action
- Preview cards for built-in security review skills

Skill detail editing, advanced compatibility settings, default models, and tool requirements are still pending.

### 10. Connectors Foundation

Connector CRUD foundations have been added.

Backend API routes include:

- `GET /api/connectors`
- `POST /api/connectors`
- `PATCH /api/connectors/{connector_id}`
- `DELETE /api/connectors/{connector_id}`

Frontend `/settings/connectors` page includes:

- Connector list
- Add connector form
- Connector type selector
- JSON configuration field
- Configured/draft status switch
- Delete action
- Preview cards for:
  - Local codebase connector
  - MCP connector shell
  - Jira action shell

Actual local codebase allowlist enforcement, MCP validation, GitHub/Jira credentials, and command execution boundaries are still pending.

### 11. Approval UX Foundation

The approval UI has been started.

Implemented frontend features include:

- Dedicated approvals page
- Approval card component
- Approval dialog component
- Approve/reject/request-revision action buttons
- Demo fallback approval when backend data is unavailable

Implemented backend features include:

- Approval request table
- Approval list/detail endpoints
- Approve endpoint
- Reject endpoint
- Request revision endpoint
- Runtime helper for creating approval requests
- Basic run status update to `waiting_for_approval`

Full workflow pause/resume and branch continuation are still pending.

### 12. Memory UX and Backend Foundation

Structured memory has been started.

Implemented backend features include:

- `memory_entries` table
- Memory write helper
- Memory read helper
- Run memory endpoint
- Clear run memory endpoint

Implemented frontend features include:

- Memory panel component
- Memory scope display
- Sensitivity label display
- Masked/sensitive-memory visual treatment

Actual runtime memory use across real agent execution is still pending.

### 13. Agent Runtime Skeleton

A minimal backend runtime skeleton has been added.

Implemented pieces include:

- Security Review supervisor plan helper
- Demo Security Review run starter
- Agent event SSE helper
- Agent run/message/memory/approval table foundation
- Agent definition CRUD endpoints

This is not a full agent runtime yet. Real model calls, tool calls, graph execution, bounded specialist loops, and report generation are still pending.

### 14. Built-In Security Review Team Assets

Template and skill files were added under `backend/app/templates`.

Added files include:

- `security_review_team.json`
- `skills/secure_code_review.json`
- `skills/dependency_risk_review.json`
- `skills/secrets_config_review.json`
- `skills/security_report_writer.json`

These define the intended Security Review Team template and its reusable skills.

## Current User-Visible State

The app currently looks and behaves like a polished MVP shell. A user can navigate the product, view the dashboard, inspect the Security Review Team builder, see agent/memory/approval UI, and manage sample or backend-backed models, skills, connectors, and users.

When only the Vite frontend preview is running, the app uses preview-safe sample data and a preview-mode auth session. When the FastAPI backend is available, the CRUD APIs and local auth can persist data into SQLite.

## How to Test Current UI

In the browser, useful routes include:

- `/`
- `/dashboard`
- `/setup`
- `/login`
- `/workflows`
- `/workflows/security-review-team/builder`
- `/skills`
- `/settings/models`
- `/settings/connectors`
- `/settings/users`
- `/approvals`

If testing with the backend running, useful API routes include:

- `/api/health`
- `/api/auth/status`
- `/api/auth/bootstrap`
- `/api/auth/login`
- `/api/model-providers`
- `/api/skills`
- `/api/connectors`
- `/api/approvals`

## Pending Work

### High Priority

1. **Workflow persistence**
   - Add workflow list/detail/save APIs if not fully completed.
   - Seed the Security Review Team template into SQLite.
   - Connect the workflow list page to real workflow data.
   - Connect the builder to load graph JSON from SQLite.
   - Save graph changes from the builder back to SQLite.

2. **Workflow runtime**
   - Validate workflow graphs.
   - Execute nodes in a deterministic order.
   - Support agent nodes, memory nodes, approval nodes, and report nodes.
   - Add manual run action from the builder.
   - Store workflow step runs, logs, agent runs, messages, memory writes, and artifacts.

3. **Agent execution**
   - Implement real supervisor delegation.
   - Execute specialist agents sequentially for MVP.
   - Connect agents to selected model providers.
   - Apply allowed skills, connectors/tools, memory scope, max iterations, and approval rules.
   - Generate final report output.

4. **Approval pause/resume**
   - Pause workflow runs at approval checkpoints.
   - Persist paused state.
   - Resume execution after approval.
   - Stop/fail branch on rejection.
   - Record approver identity and comments.

5. **Live run console**
   - Stream real SSE events.
   - Display agent started/completed events.
   - Display agent messages.
   - Display memory writes.
   - Display approval required/resolved events.
   - Display final report and artifacts.

### Medium Priority

6. **Model provider services**
   - Securely store provider credentials/secrets.
   - Implement Ollama provider first.
   - Implement OpenAI-compatible provider.
   - Implement Anthropic-compatible provider.
   - Add test connection actions.
   - Add model discovery/listing where supported.

7. **Connector implementation**
   - Implement local codebase connector with allowlist enforcement.
   - Add default exclusions for `.git`, `node_modules`, `.env`, secret files, build outputs, and large artifacts.
   - Add MCP connector validation.
   - Add GitHub/Jira configuration shells with approval-before-write behavior.
   - Add command runner only with strict allowlists and approval gates.

8. **Skills improvements**
   - Add skill detail/edit page.
   - Add default model/provider hints.
   - Add compatible agent-role constraints.
   - Add skill test/preview behavior.

9. **Run detail pages**
   - Build real run detail page.
   - Show step timeline.
   - Show agent timeline.
   - Show memory entries.
   - Show approval history.
   - Show final report.
   - Show artifacts.

10. **Scheduling**
    - Add workflow schedule table/API.
    - Integrate APScheduler.
    - Add schedule UI.
    - Support scheduled runs that pause for approval.

### Security and Hardening

11. **Authentication hardening**
    - Consider secure HTTP-only cookie sessions for production-style deployments.
    - Add route protection to all sensitive APIs.
    - Add role-specific permissions beyond admin/operator.
    - Add password reset/change flows.
    - Add session expiry UI.

12. **Memory safety**
    - Add memory retention policy.
    - Add memory clearing controls in run detail.
    - Add sensitive-field masking helpers.
    - Prevent API keys/secrets from being stored in memory.

13. **Agent safety**
    - Enforce model/tool/connector allowlists per agent.
    - Enforce filesystem/codebase path allowlists.
    - Enforce max iterations and context limits.
    - Require approval before external write actions.

14. **Testing**
    - Backend tests for SQLite startup/WAL.
    - Auth tests.
    - Provider/skill/connector CRUD tests.
    - Workflow graph validation tests.
    - Memory scope enforcement tests.
    - Approval pause/resume tests.
    - Frontend component checks for agent nodes, inspector, memory panel, approvals, and builder.

15. **Documentation**
    - Complete local deployment guide.
    - Document SQLite backup/restore.
    - Document mounting local repositories read-only.
    - Document Ollama configuration.
    - Document remote provider security implications.

## Recommended Next Step

The recommended next implementation step is **workflow persistence**:

1. Add workflow API routes for list/detail/create/update/delete.
2. Seed the Security Review Team template into SQLite.
3. Replace the `/workflows` placeholder with a real workflow list page.
4. Make `/workflows/:workflowId/builder` load graph JSON from SQLite.
5. Make the builder save updated graph JSON back to SQLite.

This unlocks the next major phase: real manual workflow runs and agent runtime execution.
