SECURITY_REVIEW_PLAN = [
    {
        "agent": "Code Security Reviewer Agent",
        "task": "Review source code for insecure patterns and risky data handling.",
    },
    {
        "agent": "Dependency Vulnerability Agent",
        "task": "Inspect dependency manifests and summarize package risk.",
    },
    {
        "agent": "Secrets & Configuration Agent",
        "task": "Check configuration surfaces with strict masking and exclusion rules.",
    },
    {
        "agent": "Report Writer Agent",
        "task": "Aggregate findings into an auditable security review report.",
    },
]


def create_supervisor_plan(objective: str) -> dict:
    return {
        "objective": objective,
        "strategy": "sequential_delegation",
        "tasks": SECURITY_REVIEW_PLAN,
        "approval_policy": "Require approval before final report or external write actions.",
    }
