from app.db.session import db_session

# The Report Writer palette preset (frontend) attaches this skill by slug.
STANDARD_REPORT_FORMAT_ID = "standard-report-format"

# Built-in SDLC skill library. Seeded insert-if-missing on startup — user edits
# and deletions of these rows are never overwritten. Slugs are stable ids; the
# security_review_team template references secure-code-review,
# dependency-risk-review, and secrets-config-review by these slugs.
SEED_SKILLS: list[dict] = [
    {
        "id": STANDARD_REPORT_FORMAT_ID,
        "name": "Standard Report Format",
        "description": "A consistent Summary / Findings / Next Steps structure with severity ratings, for any agent that writes a final report.",
        "prompt_template": """Write your findings as a report in exactly this structure:

# Summary
2-3 sentences: what was reviewed and the overall verdict.

# Findings
For each finding, use this format:
### [SEVERITY] Short title
- **Location:** file/path or component
- **Issue:** what's wrong, in 1-2 sentences
- **Recommendation:** the concrete fix

Severity is one of: CRITICAL, HIGH, MEDIUM, LOW, INFO. Order findings by severity,
most severe first. If there are no findings, state that explicitly under Findings.

# Next Steps
A short bullet list of recommended follow-up actions, ordered by priority.

Do not add extra sections. Keep prose tight — this report will be read by someone
deciding what to act on next, not learning the codebase.""",
    },
    # ── Code Review bundle ────────────────────────────────────────────────────
    {
        "id": "secure-code-review",
        "name": "Secure Code Review",
        "description": "OWASP-style checklist review: injection, auth gaps, secrets, SSRF, path traversal — every finding severity-rated with file:line and a concrete fix.",
        "prompt_template": """Review the code against this security checklist:
- Injection: SQL, command, template, and header injection via unsanitized input
- Authentication/authorization: missing checks, privilege escalation paths, insecure session handling
- Hardcoded secrets: credentials, tokens, or keys committed in source
- Unsafe deserialization of untrusted data
- SSRF: user-controlled URLs reaching internal services
- Path traversal: user input in filesystem paths
- Missing input validation at trust boundaries (API handlers, file parsers, queue consumers)

For every finding: cite the exact file:line, assign CRITICAL / HIGH / MEDIUM / LOW,
and give the concrete fix — not generic advice. Report only what you can verify in
the code you inspected; no speculative or theoretical findings. If an area on the
checklist is clean, do not pad the report with it.""",
    },
    {
        "id": "pr-readiness-review",
        "name": "PR-Readiness Review",
        "description": "Pre-landing review — correctness bugs, regressions, missing validation — split into Blockers vs Nits with a READY / NOT READY verdict.",
        "prompt_template": """Review the changes as a pre-landing gate. Look for:
- Correctness bugs: logic errors, off-by-one, wrong operator, inverted conditions
- Regressions: existing behavior this change silently alters or breaks
- Missing validation or unhandled error paths on new code
- Dead code, leftover debug statements, commented-out blocks
- Inconsistencies with the surrounding code's conventions

Structure your output as exactly two lists:
## Blockers
Issues that must be fixed before this lands. Each with file:line and why it blocks.
## Nits
Optional improvements. Keep these brief.

Never mix the two categories. End with a single line: VERDICT: READY or
VERDICT: NOT READY — <one-sentence reason>.""",
    },
    {
        "id": "performance-review",
        "name": "Performance Review",
        "description": "Finds N+1 queries, sync IO in hot paths, unbounded allocations, missing pagination/indexes — each rated Impact × Effort.",
        "prompt_template": """Review the code for performance problems:
- N+1 query patterns (queries inside loops, per-item fetches)
- Synchronous/blocking IO in hot paths or request handlers
- Unbounded loops, allocations, or collections that grow with input size
- Missing pagination on list endpoints or bulk reads
- Missing database indexes for evident query patterns
- Obvious caching opportunities for repeated expensive work

Rate every finding: Impact (HIGH/MED/LOW) × Effort to fix (HIGH/MED/LOW), and cite
file:line. Order the report with high-impact/low-effort findings first. Do not
report micro-optimizations with no measurable effect. If nothing significant is
found, say so in one line.""",
    },
    {
        "id": "dependency-risk-review",
        "name": "Dependency Risk Audit",
        "description": "Audits manifests and lockfiles for vulnerable, outdated, unmaintained, or license-problematic packages.",
        "prompt_template": """Inspect the dependency manifests and lockfiles. Flag:
- Versions with known security vulnerabilities
- Packages multiple major versions behind current
- Unmaintained or archived packages still in use
- License red flags (copyleft in a proprietary context, missing licenses)
- Duplicate or conflicting versions of the same package

Output a table: | Package | Current | Issue | Recommended action |
Follow the table with at most 3 sentences of overall assessment. Only include
packages with a real issue — do not list healthy dependencies. If everything is
clean, output a single line saying so.""",
    },
    {
        "id": "secrets-config-review",
        "name": "Secrets & Config Review",
        "description": "Scans for hardcoded credentials, secrets in logs, insecure defaults, and undocumented env vars — masking any secret-like values.",
        "prompt_template": """Review source and configuration for secrets and config hygiene:
- Hardcoded credentials, API keys, tokens, or private keys in source files
- Secret-like values written to logs or error messages
- Insecure defaults: debug mode on, permissive CORS, weak crypto parameters, default passwords
- Environment variables the code reads vs what setup docs/.env.example document

When reporting any secret-like value, MASK it: show the first 4 characters followed
by •••• — never reproduce a full secret in your report. Cite file:line for every
finding, with severity CRITICAL for live credentials, HIGH for insecure defaults,
MEDIUM/LOW for hygiene issues.""",
    },
    # ── Quality bundle ────────────────────────────────────────────────────────
    {
        "id": "test-gap-analysis",
        "name": "Test Gap Analysis",
        "description": "Maps critical code paths to existing tests, lists untested branches, and proposes concrete named test cases.",
        "prompt_template": """Map the changed or critical code paths against the existing test suite:
1. Identify which functions/branches are covered by existing tests (name the test files).
2. List untested branches, edge cases, and error paths — especially failure modes,
   boundary values, and concurrent/ordering issues.
3. For each gap, propose a concrete test:
   - **Test name:** e.g. test_refund_rejects_already_refunded_order
   - **Arrange/Act/Assert:** one line each — what it sets up, what it calls, what it asserts

Be specific enough that an implementer can write each test without re-analyzing the
code. Prioritize gaps by risk (what breaks worst in production if wrong). Do not
propose redundant tests for already-covered paths.""",
    },
    {
        "id": "error-observability-review",
        "name": "Error Handling & Observability Review",
        "description": "Finds swallowed exceptions, missing timeouts/retries, unactionable errors, and log-quality gaps — prioritized by incident-hiding risk.",
        "prompt_template": """Review error handling and observability:
- Swallowed or blanket exception handlers (catch-all with no logging or re-raise)
- Network/external calls missing timeouts or retry policies
- Error messages without actionable context (no identifiers, no cause, no next step)
- Log-level misuse (errors logged as info, noise logged as error)
- Multi-step flows missing correlation/request ids for tracing

Classify each finding: **INCIDENT-HIDING** (would mask or worsen a production
incident) vs **HYGIENE** (cosmetic/consistency). Lead with incident-hiding issues.
Cite file:line and give the concrete fix for each. Skip theoretical concerns about
code paths that cannot receive external input.""",
    },
    # ── Release bundle ────────────────────────────────────────────────────────
    {
        "id": "release-notes-writer",
        "name": "Release Notes Writer",
        "description": "Turns the diff/commit history into user-facing release notes: Features, Fixes, Breaking Changes, and Upgrade Steps.",
        "prompt_template": """Write user-facing release notes from the changes. Structure:

## Features
## Fixes
## Breaking Changes
## Upgrade Steps

Omit any empty section. Write for USERS of the software, not its developers: no
internal file paths, no refactoring chatter, no commit-message jargon, no issue
ids without context. Every breaking-change entry must state both what breaks and
exactly what the user must do about it. Group related commits into one entry —
release notes describe outcomes, not the commit log. Keep each entry to 1-2 lines.""",
    },
    {
        "id": "breaking-change-detector",
        "name": "Breaking Change Detector",
        "description": "Diffs the public surface — APIs, endpoints, schemas, config, CLI flags — and produces migration notes for each break.",
        "prompt_template": """Compare the public surface before and after the changes:
- Exported functions/classes: removed, renamed, or changed signatures
- HTTP endpoints: paths, methods, request/response field shapes, status codes
- Database schema and migrations
- Configuration and environment variable names or semantics
- CLI commands and flags

For each breaking change, report: **What changed** · **Who is affected** ·
**Migration note** (the exact step a consumer must take). Internal-only changes
that no external consumer can observe are NOT breaking — exclude them. If there
are no breaking changes, say exactly that in one line: "No breaking changes
detected." Do not hedge.""",
    },
    {
        "id": "deployment-risk-assessment",
        "name": "Deployment Risk Assessment",
        "description": "Rates release risk — migration reversibility, blast radius, data-loss potential — with a rollback plan and post-deploy watchlist.",
        "prompt_template": """Assess the deployment risk of these changes:
- Migration reversibility: can the database/config changes be rolled back cleanly?
- Blast radius: which features/users break if this deploy is bad?
- Data-loss potential: any destructive migrations, truncations, or format changes?
- Feature-flag coverage: is risky behavior gated, or live for everyone at once?
- External dependency changes: new services, version bumps, API contract shifts

Output exactly:
**Overall risk:** LOW / MEDIUM / HIGH — one-sentence justification.
**Rollback plan:** the concrete steps to revert, or "not cleanly reversible" + why.
**Watch after deploy:** 3-5 specific signals (metrics, logs, endpoints) to monitor
in the first hour.""",
    },
]


def seed_builtin_skills() -> None:
    """Insert any missing built-in skills. Never overwrites existing rows, so
    user edits to seeded skills survive restarts. (A deleted built-in is
    re-created on the next restart — edit it to a no-op instead of deleting
    if you want it gone from prompts but not from the list.)"""
    with db_session() as db:
        for skill in SEED_SKILLS:
            row = db.execute("SELECT id FROM skills WHERE id = ?", (skill["id"],)).fetchone()
            if row:
                continue
            db.execute(
                """
                INSERT INTO skills (id, name, description, prompt_template, compatible_agent_roles)
                VALUES (?, ?, ?, ?, ?)
                """,
                (skill["id"], skill["name"], skill["description"], skill["prompt_template"], "[]"),
            )
