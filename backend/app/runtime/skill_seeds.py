from uuid import uuid4

from app.db.session import db_session

STANDARD_REPORT_FORMAT_ID = "standard-report-format"
STANDARD_REPORT_FORMAT_TEMPLATE = """Write your findings as a report in exactly this structure:

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
deciding what to act on next, not learning the codebase."""


def seed_standard_report_format_skill() -> None:
    with db_session() as db:
        row = db.execute("SELECT id FROM skills WHERE id = ?", (STANDARD_REPORT_FORMAT_ID,)).fetchone()
        if row:
            return
        db.execute(
            """
            INSERT INTO skills (id, name, description, prompt_template, compatible_agent_roles)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                STANDARD_REPORT_FORMAT_ID,
                "Standard Report Format",
                "A consistent Summary / Findings / Next Steps structure with severity ratings, for any agent that writes a final report.",
                STANDARD_REPORT_FORMAT_TEMPLATE,
                "[]",
            ),
        )
