from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.runtime.auth import require_user
from app.runtime.supervisor import PlannerUnavailableError, plan_workflow, tune_node
from app.runtime.workflows import DuplicateWorkflowName, create_workflow, delete_workflow, get_workflow, list_workflows, set_template_flag, update_workflow

router = APIRouter(prefix="/workflows", tags=["workflows"])


class WorkflowRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    description: str = ""
    graph: dict = {}
    # Repository the workflow runs against. Trigger-started runs have no UI
    # dropdown to read, so this is the only source they can use.
    workspace_path: str | None = None


class PlanRequest(BaseModel):
    objective: str = Field(min_length=1, max_length=4000)
    supervisor_node_id: str = Field(min_length=1)
    runtime: str = "sandbox"
    agent: str = "claude"
    workspace_path: str = Field(min_length=1)
    system_instructions: str = ""
    current_plan: dict | None = None
    feedback: str = ""


class TuneNodeRequest(BaseModel):
    node_data: dict
    instruction: str = Field(min_length=1, max_length=2000)
    runtime: str = "sandbox"
    agent: str = "claude"
    workspace_path: str = Field(min_length=1)


@router.get("")
def list_all_workflows(_: dict = Depends(require_user)) -> list[dict]:
    return list_workflows()


@router.post("/plan")
def plan_workflow_route(request: PlanRequest, _: dict = Depends(require_user)) -> dict:
    try:
        return plan_workflow(
            objective=request.objective,
            supervisor_node_id=request.supervisor_node_id,
            runtime=request.runtime,
            agent=request.agent,
            workspace_path=request.workspace_path,
            system_instructions=request.system_instructions,
            current_plan=request.current_plan,
            feedback=request.feedback,
        )
    except PlannerUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/plan/tune-node")
def tune_node_route(request: TuneNodeRequest, _: dict = Depends(require_user)) -> dict:
    try:
        return tune_node(
            node_data=request.node_data,
            instruction=request.instruction,
            runtime=request.runtime,
            agent=request.agent,
            workspace_path=request.workspace_path,
        )
    except PlannerUnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("")
def create_workflow_route(request: WorkflowRequest, _: dict = Depends(require_user)) -> dict:
    try:
        return create_workflow(request.name, request.description, request.graph, request.workspace_path)
    except DuplicateWorkflowName as exc:
        raise HTTPException(status_code=409, detail=str(exc))


@router.get("/{workflow_id}")
def get_workflow_route(workflow_id: str, _: dict = Depends(require_user)) -> dict:
    workflow = get_workflow(workflow_id)
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow


@router.patch("/{workflow_id}")
def update_workflow_route(workflow_id: str, request: WorkflowRequest, _: dict = Depends(require_user)) -> dict:
    try:
        workflow = update_workflow(workflow_id, request.name, request.description, request.graph, request.workspace_path)
    except DuplicateWorkflowName as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow


@router.patch("/{workflow_id}/publish-template")
def publish_template_route(workflow_id: str, _: dict = Depends(require_user)) -> dict:
    workflow = set_template_flag(workflow_id, True)
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow


@router.patch("/{workflow_id}/unpublish-template")
def unpublish_template_route(workflow_id: str, _: dict = Depends(require_user)) -> dict:
    workflow = set_template_flag(workflow_id, False)
    if not workflow:
        raise HTTPException(status_code=404, detail="Workflow not found")
    return workflow


@router.delete("/{workflow_id}")
def delete_workflow_route(workflow_id: str, _: dict = Depends(require_user)) -> dict:
    return {"deleted": delete_workflow(workflow_id), "workflow_id": workflow_id}
