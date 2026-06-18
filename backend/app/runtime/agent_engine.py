from uuid import uuid4

from app.db.session import db_session
from app.runtime.approvals import create_approval_request
from app.runtime.memory import write_memory
from app.runtime.supervisor import create_supervisor_plan


def start_security_review_demo(workflow_id: str, objective: str) -> str:
    run_id = str(uuid4())
    supervisor_run_id = str(uuid4())
    plan = create_supervisor_plan(objective)

    with db_session() as db:
        db.execute(
            "INSERT INTO workflow_runs (id, workflow_id, status, trigger_type) VALUES (?, ?, 'running', 'manual')",
            (run_id, workflow_id),
        )
        db.execute(
            """
            INSERT INTO agent_runs (id, workflow_run_id, node_id, agent_name, agent_role, status, summary)
            VALUES (?, ?, 'security-supervisor', 'Security Supervisor Agent', 'Supervisor Agent', 'completed', ?)
            """,
            (supervisor_run_id, run_id, str(plan)),
        )

    write_memory(run_id, "workflow", "supervisor_plan", str(plan), supervisor_run_id, "internal", "Security Supervisor Agent")
    create_approval_request(
        workflow_run_id=run_id,
        title="Approve final security report generation",
        reason="The supervisor has completed specialist delegation and needs approval before finalizing the report.",
        requested_by_agent="Security Supervisor Agent",
        context_summary="Sequential specialist review plan is ready for report aggregation.",
        agent_run_id=supervisor_run_id,
    )
    return run_id
