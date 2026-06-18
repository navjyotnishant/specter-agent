import json
from collections.abc import AsyncIterator


def sse_event(event: str, payload: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


async def demo_agent_event_stream(run_id: str) -> AsyncIterator[str]:
    events = [
        ("agent_started", {"run_id": run_id, "agent": "Security Supervisor Agent"}),
        ("agent_message", {"run_id": run_id, "message": "Creating bounded security review task plan."}),
        ("agent_memory_written", {"run_id": run_id, "key": "review_objective"}),
        ("approval_required", {"run_id": run_id, "reason": "Final report requires human review."}),
    ]
    for event, payload in events:
        yield sse_event(event, payload)
