import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Node,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Loader2,
  OctagonAlert,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Square,
  X,
  ArrowLeft,
  Brain,
  Code2,
  PackageSearch,
  KeyRound,
  FileBarChart2,
  ShieldCheck,
  UserCheck,
  Terminal,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { RunStep, RunLog, RunApproval } from "@/lib/types";

// ── helpers ───────────────────────────────────────────────────────────────────
function parseUTC(s: string): Date {
  return new Date(s.endsWith("Z") || s.includes("+") ? s : s + "Z");
}
function fmtElapsed(s: number) {
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ── status palette ────────────────────────────────────────────────────────────
const S = {
  queued:           { glow: "#94a3b8", ring: "#cbd5e1", badge: "#64748b", bg: "#f8fafc", text: "#64748b", label: "Queued",   border: "#e2e8f0" },
  running:          { glow: "#3b82f6", ring: "#93c5fd", badge: "#2563eb", bg: "#eff6ff", text: "#1d4ed8", label: "Running",  border: "#bfdbfe" },
  completed:        { glow: "#10b981", ring: "#6ee7b7", badge: "#059669", bg: "#ecfdf5", text: "#065f46", label: "Done",     border: "#a7f3d0" },
  approved:         { glow: "#10b981", ring: "#6ee7b7", badge: "#047857", bg: "#ecfdf5", text: "#065f46", label: "Approved", border: "#a7f3d0" },
  failed:           { glow: "#ef4444", ring: "#fca5a5", badge: "#dc2626", bg: "#fef2f2", text: "#991b1b", label: "Failed",   border: "#fecaca" },
  rejected:         { glow: "#ef4444", ring: "#fca5a5", badge: "#dc2626", bg: "#fef2f2", text: "#991b1b", label: "Rejected", border: "#fecaca" },
  revision_requested:{ glow: "#f59e0b", ring: "#fcd34d", badge: "#b45309", bg: "#fffbeb", text: "#92400e", label: "Revision", border: "#fde68a" },
  waiting_approval: { glow: "#f59e0b", ring: "#fcd34d", badge: "#d97706", bg: "#fffbeb", text: "#92400e", label: "Approval", border: "#fde68a" },
  cancelled:        { glow: "#94a3b8", ring: "#e2e8f0", badge: "#6b7280", bg: "#f9fafb", text: "#6b7280", label: "Cancelled",border: "#e5e7eb" },
} as const;
type StatusKey = keyof typeof S;
function sc(status: string) { return S[status as StatusKey] ?? S.queued; }

// ── parallel lane colors — assigned by topo column ────────────────────────────
// Column 0 = entry (supervisor), column 1+ = parallel lanes
const LANE_COLORS = [
  "#7c3aed", // purple — supervisor
  "#2563eb", // blue
  "#0891b2", // cyan
  "#059669", // green
  "#d97706", // amber
  "#dc2626", // red
  "#7c3aed", // purple (wraps)
  "#0f766e", // teal
];
function laneColor(col: number) { return LANE_COLORS[col % LANE_COLORS.length]; }

// ── node type → icon ──────────────────────────────────────────────────────────
function nodeVisual(nodeType: string, role = "") {
  const r = role.toLowerCase();
  if (nodeType === "supervisorAgent") return { Icon: ShieldCheck, label: "SUPERVISOR" };
  if (nodeType === "memory")          return { Icon: Brain,       label: "MEMORY" };
  if (nodeType === "humanApproval")   return { Icon: UserCheck,   label: "APPROVAL GATE" };
  if (r.includes("code") || r.includes("review")) return { Icon: Code2,        label: "SPECIALIST" };
  if (r.includes("dep")  || r.includes("audit"))  return { Icon: PackageSearch, label: "SPECIALIST" };
  if (r.includes("secret")|| r.includes("config")) return { Icon: KeyRound,    label: "SPECIALIST" };
  if (r.includes("report")|| r.includes("writer")) return { Icon: FileBarChart2,label: "SPECIALIST" };
  return { Icon: Terminal, label: "SPECIALIST" };
}

// ── topological layout — assigns column (depth) to each node ─────────────────
function topoLayout(nodes: Node[], edges: Edge[]): { nodes: Node[]; colMap: Record<string, number> } {
  if (!nodes.length) return { nodes, colMap: {} };

  const inDegree: Record<string, number> = {};
  const children: Record<string, string[]> = {};
  for (const n of nodes) { inDegree[n.id] = 0; children[n.id] = []; }
  for (const e of edges) {
    if (inDegree[e.target] !== undefined) inDegree[e.target]++;
    if (children[e.source]) children[e.source].push(e.target);
  }

  const col: Record<string, number> = {};
  const queue = nodes.filter((n) => inDegree[n.id] === 0).map((n) => n.id);
  for (const id of queue) col[id] = 0;

  let head = 0;
  while (head < queue.length) {
    const id = queue[head++];
    for (const child of children[id] ?? []) {
      col[child] = Math.max(col[child] ?? 0, (col[id] ?? 0) + 1);
      if (--inDegree[child] === 0) queue.push(child);
    }
  }
  for (const n of nodes) if (col[n.id] === undefined) col[n.id] = 0;

  const byCol: Record<number, string[]> = {};
  for (const n of nodes) { const c = col[n.id]; (byCol[c] = byCol[c] ?? []).push(n.id); }

  const COL_GAP = 280;
  const ROW_GAP = 160;
  const NODE_H = 120;

  const pos: Record<string, { x: number; y: number }> = {};
  for (const [c, ids] of Object.entries(byCol)) {
    const colIdx = Number(c);
    const totalH = ids.length * NODE_H + (ids.length - 1) * (ROW_GAP - NODE_H);
    ids.forEach((id, row) => {
      pos[id] = { x: colIdx * COL_GAP, y: row * ROW_GAP - totalH / 2 + 200 };
    });
  }

  return {
    colMap: col,
    nodes: nodes.map((n) => ({ ...n, position: pos[n.id] ?? n.position })),
  };
}

// ── animated flow edge ────────────────────────────────────────────────────────
function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const status = String((data as Record<string,unknown>)?.edgeStatus ?? "queued");
  const color = String((data as Record<string,unknown>)?.edgeColor ?? "#cbd5e1");
  const isActive = status === "running";
  const isDone   = status === "completed";
  const strokeColor = isDone ? color : isActive ? color : "#e2e8f0";

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ stroke: strokeColor, strokeWidth: isDone ? 2.5 : 1.5, opacity: isDone ? 1 : isActive ? 0.9 : 0.5 }}
      />
      {isActive && (
        <EdgeLabelRenderer>
          <div style={{
            position: "absolute",
            transform: `translate(-50%,-50%) translate(${labelX}px,${labelY}px)`,
            width: 9, height: 9, borderRadius: "50%",
            background: color,
            boxShadow: `0 0 8px ${color}, 0 0 16px ${color}80`,
            animation: "pulseGlow 1s ease-in-out infinite",
            pointerEvents: "none",
          }} />
        </EdgeLabelRenderer>
      )}
    </>
  );
}

// ── inline markdown renderer ──────────────────────────────────────────────────
function Markdown({ text, accent }: { text: string; accent: string }) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  function inlineFormat(s: string, key: string): React.ReactNode {
    const parts: React.ReactNode[] = [];
    const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__)/g;
    let last = 0; let ki = 0; let m: RegExpExecArray | null;
    while ((m = tokenRe.exec(s)) !== null) {
      if (m.index > last) parts.push(<span key={`${key}-t${ki++}`}>{s.slice(last, m.index)}</span>);
      const tok = m[0];
      if (tok.startsWith("`"))
        parts.push(<code key={`${key}-c${ki++}`} style={{ background: "#f1f5f9", color: accent, padding: "1px 5px", borderRadius: 3, fontSize: "0.9em", fontFamily: "ui-monospace, monospace", border: "1px solid #e2e8f0" }}>{tok.slice(1,-1)}</code>);
      else
        parts.push(<strong key={`${key}-b${ki++}`} style={{ color: "#0f172a", fontWeight: 700 }}>{tok.slice(2,-2)}</strong>);
      last = m.index + tok.length;
    }
    if (last < s.length) parts.push(<span key={`${key}-tail`}>{s.slice(last)}</span>);
    return parts.length ? parts : s;
  }

  while (i < lines.length) {
    const line = lines[i]; const trimmed = line.trim();
    if (!trimmed) { elements.push(<div key={i} style={{ height: 8 }} />); i++; continue; }
    const hm = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      const level = hm[1].length;
      elements.push(<div key={i} style={{ fontSize: level===1?15:level===2?13:11, fontWeight: 800, color: accent, marginTop: level===1?18:12, marginBottom: 6 }}>{inlineFormat(hm[2],`h${i}`)}</div>);
      i++; continue;
    }
    if (/^---+$/.test(trimmed)) { elements.push(<div key={i} style={{ borderTop: "1px solid #e2e8f0", margin: "12px 0" }} />); i++; continue; }
    if (/^[-*•]\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*•]\s/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^[-*•]\s/, "")); i++; }
      elements.push(<ul key={`ul-${i}`} style={{ margin: "6px 0", paddingLeft: 0, listStyle: "none" }}>{items.map((item,j) => <li key={j} style={{ display:"flex",gap:8,alignItems:"flex-start",marginBottom:5 }}><span style={{color:accent,marginTop:2,flexShrink:0,fontSize:9}}>▸</span><span style={{fontSize:11,color:"#374151",lineHeight:1.7}}>{inlineFormat(item,`li-${i}-${j}`)}</span></li>)}</ul>);
      continue;
    }
    if (/^\d+\.\s/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i].trim())) { items.push(lines[i].trim().replace(/^\d+\.\s/, "")); i++; }
      elements.push(<ol key={`ol-${i}`} style={{ margin:"6px 0",paddingLeft:0,listStyle:"none" }}>{items.map((item,j) => <li key={j} style={{display:"flex",gap:8,alignItems:"flex-start",marginBottom:5}}><span style={{color:accent,flexShrink:0,fontSize:9,minWidth:14,textAlign:"right",marginTop:2}}>{j+1}.</span><span style={{fontSize:11,color:"#374151",lineHeight:1.7}}>{inlineFormat(item,`ol-${i}-${j}`)}</span></li>)}</ol>);
      continue;
    }
    if (trimmed.startsWith("```")) {
      const lang = trimmed.slice(3).trim(); const codeLines: string[] = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) { codeLines.push(lines[i]); i++; }
      i++;
      elements.push(<pre key={`code-${i}`} style={{ background:"#f8fafc",border:"1px solid #e2e8f0",borderLeft:`3px solid ${accent}`,padding:"10px 14px",margin:"8px 0",overflowX:"auto",fontSize:11,color:"#1e293b",lineHeight:1.8,borderRadius:"0 6px 6px 0",fontFamily:"ui-monospace,'Cascadia Code',monospace" }}>{lang&&<div style={{fontSize:9,color:"#94a3b8",marginBottom:6,textTransform:"uppercase",letterSpacing:"0.1em"}}>{lang}</div>}{codeLines.join("\n")}</pre>);
      continue;
    }
    if (trimmed.startsWith(">")) { elements.push(<div key={i} style={{borderLeft:`3px solid ${accent}50`,paddingLeft:12,margin:"6px 0",color:"#6b7280",fontSize:11,lineHeight:1.7,fontStyle:"italic"}}>{inlineFormat(trimmed.slice(1).trim(),`bq-${i}`)}</div>); i++; continue; }
    if (/^\*\*(High|Medium|Low|Critical|Info)\*\*/.test(trimmed)) {
      const sm = trimmed.match(/^\*\*(High|Medium|Low|Critical|Info)\*\*:?\s*(.*)/);
      if (sm) {
        const sev = sm[1]; const sevColor = sev==="Critical"||sev==="High"?"#dc2626":sev==="Medium"?"#d97706":sev==="Low"?"#059669":"#6b7280";
        elements.push(<div key={i} style={{display:"flex",gap:8,alignItems:"flex-start",margin:"6px 0",padding:"8px 12px",background:`${sevColor}0d`,borderLeft:`3px solid ${sevColor}`,borderRadius:"0 6px 6px 0"}}><span style={{fontSize:9,fontWeight:800,color:sevColor,textTransform:"uppercase",letterSpacing:"0.1em",flexShrink:0,marginTop:1}}>{sev}</span><span style={{fontSize:11,color:"#374151",lineHeight:1.7}}>{inlineFormat(sm[2],`sev-${i}`)}</span></div>);
        i++; continue;
      }
    }
    elements.push(<p key={i} style={{fontSize:11,color:"#374151",margin:"4px 0",lineHeight:1.8}}>{inlineFormat(trimmed,`p-${i}`)}</p>);
    i++;
  }
  return <div style={{ fontFamily: "system-ui, -apple-system, sans-serif" }}>{elements}</div>;
}

// ── exec canvas node ──────────────────────────────────────────────────────────
function ExecNode({ data }: { data: Record<string, unknown> }) {
  const status   = String(data.execStatus ?? "queued");
  const s        = sc(status);
  const isRun    = status === "running";
  const isDone   = status === "completed";
  const isFailed = status === "failed";
  const nodeType = String(data.nodeType ?? "");
  const role     = String(data.role ?? "");
  const { Icon, label: typeLabel } = nodeVisual(nodeType, role);
  const accent   = String(data.laneColor ?? "#94a3b8");
  const nodeAccent = isDone ? "#10b981" : isFailed ? "#dc2626" : isRun ? accent : "#94a3b8";

  return (
    <>
      <Handle type="target" position={Position.Left}  style={{ background: nodeAccent, border: "2px solid white", width: 8, height: 8 }} />
      <div style={{
        width: 220, background: "white",
        border: `1.5px solid ${isRun ? nodeAccent : isDone ? "#a7f3d0" : isFailed ? "#fecaca" : "#e2e8f0"}`,
        borderRadius: 10, fontFamily: "system-ui, -apple-system, sans-serif",
        boxShadow: isRun ? `0 0 0 3px ${nodeAccent}25, 0 4px 16px ${nodeAccent}20` : isDone ? `0 0 0 1px #a7f3d050` : "0 1px 3px rgba(0,0,0,0.08)",
        transition: "all 0.4s ease", overflow: "hidden", position: "relative",
      }}>
        {/* color accent bar on left edge */}
        <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: isDone ? "#10b981" : isFailed ? "#dc2626" : accent, borderRadius: "10px 0 0 10px" }} />

        {isRun && <div style={{ position:"absolute",top:0,left:3,right:0,height:2,background:`linear-gradient(90deg,transparent,${accent},transparent)`,animation:"scanline 1.8s linear infinite" }} />}

        <div style={{ padding: "8px 12px 8px 15px", borderBottom:`1px solid ${isRun?`${nodeAccent}25`:"#f1f5f9"}`, display:"flex",alignItems:"center",gap:8, background: isRun?`${nodeAccent}08`:isDone?"#f0fdf4":isFailed?"#fef2f2":"#fafafa" }}>
          <div style={{ width:28,height:28,borderRadius:6,background:`${nodeAccent}15`,border:`1px solid ${nodeAccent}30`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
            {isRun ? <Loader2 style={{width:13,height:13,color:nodeAccent,animation:"spin 1s linear infinite"}} />
              : isDone ? <CheckCircle2 style={{width:13,height:13,color:nodeAccent}} />
              : isFailed ? <AlertTriangle style={{width:13,height:13,color:nodeAccent}} />
              : status==="waiting_approval" ? <OctagonAlert style={{width:13,height:13,color:nodeAccent}} />
              : <Icon style={{width:13,height:13,color:nodeAccent}} />}
          </div>
          <div style={{ flex:1,minWidth:0 }}>
            <div style={{ fontSize:8,fontWeight:800,letterSpacing:"0.1em",color:`${nodeAccent}cc`,textTransform:"uppercase" }}>{typeLabel}</div>
            <div style={{ fontSize:11,fontWeight:700,color:"#0f172a",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>{String(data.label??data.nodeId)}</div>
          </div>
          <div style={{ fontSize:8,fontWeight:800,letterSpacing:"0.06em",textTransform:"uppercase",color:s.badge,border:`1px solid ${s.border}`,padding:"2px 6px",borderRadius:4,background:s.bg,flexShrink:0 }}>{s.label}</div>
        </div>

        <div style={{ padding:"8px 12px 8px 15px" }}>
          {isRun && <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}><div style={{display:"flex",gap:3}}>{[0,1,2].map((idx)=><div key={idx} style={{width:4,height:4,borderRadius:"50%",background:nodeAccent,animation:`dotBounce 1s ease-in-out ${idx*0.2}s infinite`}}/>)}</div><span style={{fontSize:9,color:s.text}}>Executing…</span></div>}
          {data.summary
            ? <p style={{fontSize:10,color:isDone?"#374151":"#6b7280",margin:0,lineHeight:1.6,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{String(data.summary)}</p>
            : <p style={{fontSize:10,color:"#d1d5db",margin:0,fontStyle:"italic"}}>{status==="queued"?"Waiting to start…":""}</p>}
        </div>

        {isRun && <div style={{height:2,background:"#f1f5f9"}}><div style={{height:"100%",background:`linear-gradient(90deg,${nodeAccent},${nodeAccent}80)`,animation:"progressBar 2s ease-in-out infinite"}}/></div>}
        {isDone && <div style={{height:2,background:"linear-gradient(90deg,#10b981,#059669)"}}/>}
      </div>
      <Handle type="source" position={Position.Right} style={{ background: nodeAccent, border: "2px solid white", width: 8, height: 8 }} />
    </>
  );
}

const nodeTypes = { exec: ExecNode };
const edgeTypes = { flowEdge: FlowEdge };

// ── log drawer ────────────────────────────────────────────────────────────────
type ApprovalGateConfig = {
  allowedActions?: string[];
  noteRequired?: boolean;
  timeoutHours?: number;
};

function fmtDeadline(value: string | null) {
  if (!value) return "No deadline recorded";
  return parseUTC(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function LogDrawer({ step, token, runId, onClose, approval, gateConfig, onApprove, onReject, onRevise, laneColor: accent }: {
  step: RunStep; token: string; runId: string; onClose: () => void;
  approval?: RunApproval | null;
  gateConfig?: ApprovalGateConfig;
  onApprove?: (note: string) => void;
  onReject?: (note: string) => void;
  onRevise?: (note: string) => void;
  laneColor: string;
}) {
  const messagesQuery = useQuery({
    queryKey: ["step-messages", runId, step.id],
    queryFn: () => api.getStepMessages(token, runId, step.id),
    refetchInterval: step.status === "running" ? 2000 : false,
  });
  const displayStatus = approval?.status && approval.status !== "pending" ? approval.status : step.status;
  const s = sc(displayStatus);
  const logEndRef = useRef<HTMLDivElement>(null);
  const { Icon } = nodeVisual(step.node_type, "");
  const [note, setNote] = useState("");

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messagesQuery.data?.length]);

  // read allowed actions + noteRequired from step metadata (passed via step node data in graph)
  const allowedActions: string[] = Array.isArray(gateConfig?.allowedActions) ? gateConfig.allowedActions : ["approve", "reject", "request_revision"];
  const noteRequired: boolean = Boolean(gateConfig?.noteRequired);
  const expired = approval?.status === "expired" || Boolean(approval?.expires_at && parseUTC(approval.expires_at).getTime() <= Date.now());
  const canSubmit = !expired && (!noteRequired || note.trim().length > 0);

  return (
    <div style={{ width: "100%", minWidth: 0, background: "white", borderLeft: "1px solid #e2e8f0", display: "flex", flexDirection: "column", fontFamily: "system-ui, -apple-system, sans-serif", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <div style={{ padding:"14px 18px",borderBottom:"1px solid #f1f5f9",background:"#fafafa",display:"flex",alignItems:"flex-start",gap:10,flexShrink:0 }}>
        <div style={{ width:36,height:36,borderRadius:8,background:`${accent}12`,border:`1px solid ${accent}25`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0 }}>
          <Icon style={{ width:16,height:16,color:accent }} />
        </div>
        <div style={{ flex:1,minWidth:0 }}>
          <p style={{ fontSize:9,fontWeight:700,letterSpacing:"0.1em",color:"#94a3b8",margin:0,textTransform:"uppercase" }}>{step.node_type} · output</p>
          <p style={{ fontSize:14,fontWeight:700,color:"#0f172a",margin:"3px 0 0" }}>{step.agent_name}</p>
          <span style={{ display:"inline-block",marginTop:6,fontSize:8,fontWeight:800,letterSpacing:"0.08em",textTransform:"uppercase",border:`1px solid ${s.border}`,padding:"2px 8px",borderRadius:4,color:s.badge,background:s.bg }}>{s.label}</span>
        </div>
        <button onClick={onClose} style={{ color:"#6b7280",background:"#f1f5f9",border:"1px solid #e2e8f0",cursor:"pointer",padding:6,borderRadius:6,display:"flex",flexShrink:0 }}>
          <X style={{ width:14,height:14 }} />
        </button>
      </div>

      {step.status === "waiting_approval" && approval?.status === "pending" && (
        <div style={{ padding:"16px 18px",borderBottom:"1px solid #fde68a",background:"#fffbeb",flexShrink:0 }}>
          {/* reason */}
          <div style={{ display:"flex",gap:8,alignItems:"flex-start",marginBottom:14 }}>
            <OctagonAlert style={{ width:14,height:14,color:"#d97706",flexShrink:0,marginTop:1 }} />
            <p style={{ fontSize:12,color:"#92400e",margin:0,fontWeight:600,lineHeight:1.6 }}>{approval.reason}</p>
          </div>
          <p style={{ fontSize:10,color:expired?"#dc2626":"#92400e",margin:"-6px 0 14px",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em" }}>
            {expired ? "Approval expired" : `Expires ${fmtDeadline(approval.expires_at)}`}
          </p>

          {/* note textarea */}
          <div style={{ marginBottom:14 }}>
            <label style={{ fontSize:10,fontWeight:700,color:"#92400e",textTransform:"uppercase",letterSpacing:"0.08em",display:"block",marginBottom:6 }}>
              Note {noteRequired ? <span style={{ color:"#dc2626" }}>*</span> : <span style={{ color:"#d97706",fontWeight:400 }}>(optional)</span>}
            </label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add context, feedback, or revision instructions…"
              rows={3}
              style={{ width:"100%",padding:"8px 10px",borderRadius:8,border:`1.5px solid ${note.trim()||!noteRequired?"#fde68a":"#fca5a5"}`,fontSize:12,color:"#0f172a",background:"white",outline:"none",resize:"vertical",boxSizing:"border-box",fontFamily:"system-ui,-apple-system,sans-serif",lineHeight:1.6 }}
            />
            {noteRequired && !note.trim() && (
              <p style={{ fontSize:10,color:"#dc2626",margin:"4px 0 0" }}>A note is required before submitting.</p>
            )}
          </div>

          {/* action buttons — only show what's configured */}
          <div style={{ display:"flex",gap:8,flexWrap:"wrap" }}>
            {allowedActions.includes("approve") && (
              <button
                disabled={!canSubmit}
                onClick={() => canSubmit && onApprove?.(note)}
                style={{ flex:1,minWidth:90,padding:"9px 0",fontSize:12,fontWeight:700,background:canSubmit?"#059669":"#d1fae5",color:"white",border:"none",cursor:canSubmit?"pointer":"not-allowed",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}
              >
                <CheckCircle2 style={{ width:13,height:13 }} /> Approve
              </button>
            )}
            {allowedActions.includes("request_revision") && (
              <button
                disabled={!canSubmit}
                onClick={() => canSubmit && onRevise?.(note)}
                style={{ flex:1,minWidth:90,padding:"9px 0",fontSize:12,fontWeight:700,background:canSubmit?"#f8fafc":"#f1f5f9",color:canSubmit?"#374151":"#94a3b8",border:"1px solid #e2e8f0",cursor:canSubmit?"pointer":"not-allowed",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}
              >
                <ChevronLeft style={{ width:13,height:13,transform:"rotate(180deg)" }} /> Request revision
              </button>
            )}
            {allowedActions.includes("reject") && (
              <button
                disabled={!canSubmit}
                onClick={() => canSubmit && onReject?.(note)}
                style={{ flex:1,minWidth:90,padding:"9px 0",fontSize:12,fontWeight:700,background:"white",color:canSubmit?"#dc2626":"#fca5a5",border:`1px solid ${canSubmit?"#fecaca":"#fee2e2"}`,cursor:canSubmit?"pointer":"not-allowed",borderRadius:8,display:"flex",alignItems:"center",justifyContent:"center",gap:6 }}
              >
                <X style={{ width:13,height:13 }} /> Reject
              </button>
            )}
          </div>
        </div>
      )}

      {approval?.status === "expired" && (
        <div style={{ padding:"14px 18px",borderBottom:"1px solid #fecaca",background:"#fef2f2",flexShrink:0 }}>
          <p style={{ fontSize:12,color:"#991b1b",margin:0,fontWeight:700,lineHeight:1.6 }}>
            Approval expired without a response. The workflow was cancelled and will not continue.
          </p>
        </div>
      )}

      {approval?.status === "approved" && (
        <div style={{ padding:"14px 18px",borderBottom:"1px solid #bbf7d0",background:"#ecfdf5",flexShrink:0 }}>
          <p style={{ fontSize:12,color:"#065f46",margin:0,fontWeight:700,lineHeight:1.6 }}>
            Approved. The workflow is cleared to continue.
          </p>
        </div>
      )}

      <div style={{ flex:1,overflowY:"auto",padding:"14px 18px",minWidth:0,wordBreak:"break-word" }}>
        <p style={{ fontSize:9,fontWeight:700,letterSpacing:"0.1em",color:"#94a3b8",margin:"0 0 12px",textTransform:"uppercase" }}>Output {messagesQuery.data?.length?`· ${messagesQuery.data.length} msg`:""}</p>
        {messagesQuery.isLoading && <div style={{display:"flex",alignItems:"center",gap:8,color:"#94a3b8",fontSize:11}}><Loader2 style={{width:12,height:12,animation:"spin 1s linear infinite"}}/> Loading…</div>}
        {messagesQuery.data?.map((msg) => (
          <div key={msg.id} style={{ marginBottom:20 }}>
            <p style={{ fontSize:9,color:"#cbd5e1",margin:"0 0 8px",textTransform:"uppercase",letterSpacing:"0.08em",display:"flex",alignItems:"center",gap:6 }}>
              <span style={{ width:4,height:4,borderRadius:"50%",background:accent,display:"inline-block" }} />
              {msg.sender_name} · {parseUTC(msg.created_at).toLocaleTimeString()}
            </p>
            <Markdown text={msg.content} accent={accent} />
          </div>
        ))}
        {!messagesQuery.isLoading && !messagesQuery.data?.length && <p style={{fontSize:11,color:"#cbd5e1",fontStyle:"italic"}}>No output yet.</p>}
        <div ref={logEndRef} />
      </div>
    </div>
  );
}

// ── step timeline ─────────────────────────────────────────────────────────────
function StepTimeline({ steps, allNodeIds, selectedId, onSelect, colMap }: {
  steps: RunStep[]; allNodeIds: string[]; selectedId: string | null;
  onSelect: (s: RunStep) => void; colMap: Record<string, number>;
}) {
  const orderedEntries = useMemo(() => {
    const seen = new Set<string>();
    const result: Array<{ step: RunStep | null; nodeId: string }> = [];
    for (const s of steps) { seen.add(s.node_id); result.push({ step: s, nodeId: s.node_id }); }
    for (const nid of allNodeIds) { if (!seen.has(nid)) result.push({ step: null, nodeId: nid }); }
    return result;
  }, [steps, allNodeIds]);

  return (
    <div style={{ flex:1,overflowY:"auto" }}>
      {orderedEntries.map(({ step, nodeId }, i) => {
        const status = step?.status ?? "queued";
        const s = sc(status);
        const isSelected = step?.id === selectedId;
        const isLast = i === orderedEntries.length - 1;
        const isRun = status === "running";
        const col = colMap[nodeId] ?? 0;
        const accent = laneColor(col);

        return (
          <div key={nodeId} onClick={() => step && onSelect(step)} style={{ display:"flex",cursor:step?"pointer":"default" }}>
            <div style={{ display:"flex",flexDirection:"column",alignItems:"center",width:44,flexShrink:0,paddingTop:16 }}>
              <div style={{
                width:26,height:26,borderRadius:"50%",
                background: isRun?`${accent}12`:isSelected?`${s.glow}15`:"white",
                border:`2px solid ${isRun?accent:isSelected?s.glow:"#e2e8f0"}`,
                display:"flex",alignItems:"center",justifyContent:"center",
                boxShadow: isRun?`0 0 10px ${accent}40`:"none", transition:"all 0.3s", flexShrink:0,
              }}>
                {isRun ? <Loader2 style={{width:11,height:11,color:accent,animation:"spin 1s linear infinite"}} />
                  : status==="completed" ? <CheckCircle2 style={{width:11,height:11,color:"#10b981"}} />
                  : status==="failed" ? <AlertTriangle style={{width:11,height:11,color:"#dc2626"}} />
                  : status==="waiting_approval" ? <OctagonAlert style={{width:11,height:11,color:"#d97706"}} />
                  : <span style={{width:7,height:7,borderRadius:"50%",background:"#e2e8f0",display:"block"}}/>}
              </div>
              {!isLast && <div style={{ width:2,flex:1,minHeight:14,background:status==="completed"?`linear-gradient(to bottom,${accent}80,#e2e8f0)`:"#f1f5f9",transition:"background 0.5s" }}/>}
            </div>

            <div style={{
              flex:1,padding:"12px 12px 12px 4px",minWidth:0,
              borderBottom:isLast?"none":"1px solid #f8fafc",
              background:isSelected?`${accent}08`:"transparent",
              borderLeft:isSelected?`2px solid ${accent}`:`2px solid transparent`,
              transition:"all 0.2s",
            }}>
              <div style={{ display:"flex",alignItems:"center",gap:6 }}>
                {/* lane color dot */}
                <span style={{ width:6,height:6,borderRadius:"50%",background:accent,flexShrink:0,display:"block" }} />
                <p style={{ fontSize:11,fontWeight:600,margin:0,flex:1,color:step?(isRun?"#0f172a":status==="completed"?"#374151":"#6b7280"):"#d1d5db",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap" }}>
                  {step?.agent_name ?? nodeId}
                </p>
                <span style={{ fontSize:8,fontWeight:800,letterSpacing:"0.06em",textTransform:"uppercase",color:s.badge,border:`1px solid ${s.border}`,padding:"1px 6px",borderRadius:4,background:s.bg,flexShrink:0 }}>{s.label}</span>
                {step && <ChevronRight style={{width:11,height:11,color:"#d1d5db",flexShrink:0}}/>}
              </div>
              {isRun && <div style={{display:"flex",alignItems:"center",gap:5,marginTop:5}}>{[0,1,2].map((idx)=><div key={idx} style={{width:4,height:4,borderRadius:"50%",background:accent,animation:`dotBounce 1s ease-in-out ${idx*0.2}s infinite`}}/>)}<span style={{fontSize:9,color:accent}}>Running…</span></div>}
              {step?.summary&&!isRun&&<p style={{fontSize:10,color:"#94a3b8",margin:"4px 0 0",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{step.summary}</p>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── run canvas ────────────────────────────────────────────────────────────────
function RunCanvas({ graphNodes, graphEdges, steps, onNodeSelect, colMap }: {
  graphNodes: Node[]; graphEdges: Edge[]; steps: RunStep[];
  onNodeSelect: (step: RunStep) => void; colMap: Record<string, number>;
}) {
  const stepByNodeId = useMemo(() => {
    const m: Record<string, RunStep> = {};
    for (const s of steps) m[s.node_id] = s;
    return m;
  }, [steps]);

  const execNodes: Node[] = useMemo(() =>
    graphNodes.map((n) => {
      const step = stepByNodeId[n.id];
      const col = colMap[n.id] ?? 0;
      return {
        ...n, type: "exec",
        data: {
          ...n.data, nodeId: n.id, nodeType: n.type,
          role: (n.data as Record<string,unknown>)?.role ?? "",
          execStatus: step?.status ?? "queued",
          summary: step?.summary ?? null,
          laneColor: laneColor(col),
        },
        draggable: false, selectable: !!step,
      };
    }),
  [graphNodes, stepByNodeId, colMap]);

  const execEdges: Edge[] = useMemo(() =>
    graphEdges.map((e) => {
      const sourceStep = stepByNodeId[e.source];
      const targetStep = stepByNodeId[e.target];
      const edgeStatus =
        sourceStep?.status==="completed"&&targetStep?.status==="running"  ? "running"  :
        sourceStep?.status==="completed"&&targetStep?.status==="completed" ? "completed" : "queued";
      const col = colMap[e.target] ?? colMap[e.source] ?? 0;
      return { ...e, type:"flowEdge", sourcePosition:Position.Right, targetPosition:Position.Left, data:{ edgeStatus, edgeColor: laneColor(col) } };
    }),
  [graphEdges, stepByNodeId, colMap]);

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    const step = stepByNodeId[node.id];
    if (step) onNodeSelect(step);
  }, [stepByNodeId, onNodeSelect]);

  return (
    <ReactFlow
      nodes={execNodes} edges={execEdges}
      nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodeClick={handleNodeClick}
      fitView fitViewOptions={{ padding: 0.18 }}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false} nodesConnectable={false}
      elementsSelectable={true} zoomOnDoubleClick={false}
      style={{ background: "#f8fafc" }}
    >
      <Background variant={BackgroundVariant.Dots} color="#e2e8f0" gap={28} size={1} />
    </ReactFlow>
  );
}

// ── run log panel — draggable resize ─────────────────────────────────────────
function RunLogPanel({ logs, colMap, stepByNodeId }: {
  logs: RunLog[]; colMap: Record<string, number>;
  stepByNodeId: Record<string, RunStep>;
}) {
  const [height, setHeight] = useState(180);
  const [collapsed, setCollapsed] = useState(false);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onMouseDown = (e: React.MouseEvent) => {
    if (collapsed) return;
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = height;
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startY.current - e.clientY;
      setHeight(Math.max(80, Math.min(500, startH.current + delta)));
    };
    const onUp = () => { dragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // resolve node_id from log metadata for color coding
  function logColor(log: RunLog): string {
    const nodeId = (log.metadata?.node_id as string) ?? (log.metadata?.step_id as string) ?? "";
    if (nodeId) {
      const step = stepByNodeId[nodeId];
      if (step) return laneColor(colMap[step.node_id] ?? 0);
      // try direct colMap lookup
      if (colMap[nodeId] !== undefined) return laneColor(colMap[nodeId]);
    }
    // try to extract node name from message
    return "#94a3b8";
  }

  return (
    <div style={{ borderTop:"1px solid #e2e8f0",background:"white",flexShrink:0,fontFamily:"system-ui,-apple-system,sans-serif",display:"flex",flexDirection:"column" }}>
      {/* drag handle */}
      {!collapsed && (
        <div
          onMouseDown={onMouseDown}
          style={{ height:5,cursor:"row-resize",background:"transparent",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center" }}
        >
          <div style={{ width:32,height:3,borderRadius:2,background:"#e2e8f0" }} />
        </div>
      )}

      {/* header */}
      <div style={{ padding:"6px 18px",display:"flex",alignItems:"center",gap:8,borderTop:collapsed?"none":"1px solid #f1f5f9",flexShrink:0 }}>
        <Terminal style={{ width:11,height:11,color:"#0891b2" }} />
        <span style={{ fontSize:9,fontWeight:700,letterSpacing:"0.12em",color:"#0891b2",textTransform:"uppercase" }}>Run Log</span>
        <span style={{ fontSize:9,color:"#94a3b8",marginLeft:4 }}>{logs.length} entries</span>
        <span style={{ fontSize:9,color:"#cbd5e1",marginLeft:4 }}>· color-coded by parallel lane</span>
        <button
          onClick={() => setCollapsed((v) => !v)}
          style={{ marginLeft:"auto",background:"none",border:"none",cursor:"pointer",color:"#94a3b8",display:"flex",alignItems:"center",gap:4,fontSize:10,padding:"2px 6px",borderRadius:4 }}
        >
          {collapsed ? <ChevronLeft style={{width:12,height:12,transform:"rotate(90deg)"}}/> : <ChevronRight style={{width:12,height:12,transform:"rotate(90deg)"}}/>}
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>

      {/* log entries */}
      {!collapsed && (
        <div style={{ height,overflowY:"auto",padding:"4px 0 10px" }}>
          {logs.map((log) => {
            const color = logColor(log);
            return (
              <div key={log.id} style={{ padding:"3px 18px",display:"flex",gap:10,alignItems:"baseline" }}>
                <span style={{ width:3,height:3,borderRadius:"50%",background:color,flexShrink:0,marginTop:6,display:"block" }} />
                <span style={{ fontSize:9,color:"#cbd5e1",flexShrink:0,fontFamily:"ui-monospace,monospace",minWidth:60 }}>
                  {parseUTC(log.created_at).toLocaleTimeString()}
                </span>
                <span style={{ fontSize:9,fontWeight:700,flexShrink:0,letterSpacing:"0.06em",minWidth:32,
                  color:log.level==="error"?"#dc2626":log.level==="warn"?"#d97706":color }}>
                  {log.level.toUpperCase()}
                </span>
                <span style={{ fontSize:11,color:"#374151",lineHeight:1.5 }}>{log.message}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────
function RunViewInner() {
  const { workflowId = "", runId = "" } = useParams();
  const navigate = useNavigate();
  const token = getStoredToken() ?? "";
  const queryClient = useQueryClient();
  const [selectedStep, setSelectedStep] = useState<RunStep | null>(null);
  const selectedStepIdRef = useRef<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightWidth, setRightWidth] = useState(420);
  const rightDragging = useRef(false);
  const rightStartX = useRef(0);
  const rightStartW = useRef(0);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rightDragging.current) return;
      const delta = rightStartX.current - e.clientX;
      setRightWidth(Math.max(280, Math.min(700, rightStartW.current + delta)));
    };
    const onUp = () => { rightDragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  const isActive = (status: string) => ["queued", "running", "waiting_approval"].includes(status);

  const localGraph = useMemo(() => {
    try { const raw = localStorage.getItem(`sdlc_workflow_graph_v5_${workflowId}`); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }, [workflowId]);

  const runQuery = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(token, runId),
    refetchInterval: (q) => isActive(q.state.data?.status ?? "running") ? 2000 : false,
  });

  const savedGraph = useMemo(() => {
    if (localGraph?.nodes?.length) return localGraph;
    const runGraph = runQuery.data?.graph;
    if (runGraph?.nodes?.length) return runGraph;
    return { nodes: [], edges: [] };
  }, [localGraph, runQuery.data?.graph]);

  const allNodeIds: string[] = useMemo(() => (savedGraph.nodes ?? []).map((n: Node) => n.id), [savedGraph]);

  // compute topo layout + colMap once
  const { nodes: layoutNodes, colMap } = useMemo(
    () => topoLayout(savedGraph.nodes ?? [], savedGraph.edges ?? []),
    [savedGraph]
  );

  const stepsQuery = useQuery({
    queryKey: ["run-steps", runId],
    queryFn: () => api.getRunSteps(token, runId),
    refetchInterval: () => { const run = queryClient.getQueryData<{status:string}>(["run",runId]); return isActive(run?.status??"running")?2000:false; },
  });
  const logsQuery = useQuery({
    queryKey: ["run-logs", runId],
    queryFn: () => api.getRunLogs(token, runId),
    refetchInterval: () => { const run = queryClient.getQueryData<{status:string}>(["run",runId]); return isActive(run?.status??"running")?3000:false; },
  });
  const approvalsQuery = useQuery({
    queryKey: ["run-approvals", runId],
    queryFn: () => api.getRunApprovals(token, runId),
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (!selectedStepIdRef.current || !stepsQuery.data) return;
    const fresh = stepsQuery.data.find((s) => s.id === selectedStepIdRef.current);
    if (fresh) setSelectedStep(fresh);
  }, [stepsQuery.data]);

  const cancelMutation   = useMutation({ mutationFn: () => api.cancelRun(token, runId), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run", runId] }) });
  const approveMutation  = useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => api.approveRun(token, runId, id, note), onSuccess: () => { queryClient.invalidateQueries({queryKey:["run",runId]}); queryClient.invalidateQueries({queryKey:["run-steps",runId]}); queryClient.invalidateQueries({queryKey:["run-approvals",runId]}); } });
  const rejectMutation   = useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => api.rejectRun(token, runId, id, note), onSuccess: () => { queryClient.invalidateQueries({queryKey:["run",runId]}); queryClient.invalidateQueries({queryKey:["run-approvals",runId]}); } });
  const reviseMutation   = useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => api.requestRevision(token, runId, id, note), onSuccess: () => { queryClient.invalidateQueries({queryKey:["run",runId]}); queryClient.invalidateQueries({queryKey:["run-approvals",runId]}); } });

  const run    = runQuery.data;
  const steps  = stepsQuery.data ?? [];
  const logs   = logsQuery.data ?? [];
  const approvals = approvalsQuery.data ?? [];
  const runStatus = run?.status ?? "running";
  const rs = sc(runStatus);
  const pendingApproval = approvals.find((a) => a.status === "pending") ?? null;
  const selectedStepApproval = selectedStep
    ? approvals.find((a) => a.workflow_step_run_id === selectedStep.id) ?? null
    : null;
  const selectedGateConfig = selectedStep
    ? ((savedGraph.nodes ?? []).find((n: Node) => n.id === selectedStep.node_id)?.data ?? {}) as ApprovalGateConfig
    : undefined;
  const completedCount = steps.filter((s) => s.status === "completed").length;
  const totalNodes = allNodeIds.length || steps.length;

  const stepByNodeId = useMemo(() => {
    const m: Record<string, RunStep> = {};
    for (const s of steps) m[s.node_id] = s;
    return m;
  }, [steps]);

  // lane color for selected step's right drawer
  const selectedStepColor = selectedStep ? laneColor(colMap[selectedStep.node_id] ?? 0) : "#4f46e5";

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!run?.created_at) return;
    const start = parseUTC(run.created_at).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - start) / 1000)));
    tick();
    if (isActive(runStatus)) { const id = setInterval(tick, 1000); return () => clearInterval(id); }
  }, [run?.created_at, runStatus]);

  return (
    <div style={{ display:"flex",flexDirection:"column",height:"100vh",background:"#f8fafc",fontFamily:"system-ui,-apple-system,sans-serif" }}>

      {/* top bar */}
      <div style={{ display:"flex",alignItems:"center",gap:14,padding:"0 20px",height:52,background:"white",borderBottom:"1px solid #e2e8f0",flexShrink:0 }}>
        <button onClick={() => navigate(`/workflows/${workflowId}/builder`)} style={{ display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#374151",background:"#f9fafb",border:"1px solid #e5e7eb",padding:"5px 12px",cursor:"pointer",fontFamily:"inherit",borderRadius:6,fontWeight:500 }}>
          <ArrowLeft style={{width:12,height:12}}/> Builder
        </button>
        <div style={{width:1,height:22,background:"#e2e8f0"}}/>
        <div style={{ display:"flex",alignItems:"center",gap:7,border:`1px solid ${rs.border}`,padding:"4px 12px",borderRadius:20,background:rs.bg }}>
          {runStatus==="running"&&<span style={{width:7,height:7,borderRadius:"50%",background:rs.badge,display:"block",animation:"pulseGlow 1s ease-in-out infinite"}}/>}
          {runStatus==="completed"&&<CheckCircle2 style={{width:12,height:12,color:"#10b981"}}/>}
          {runStatus==="failed"&&<AlertTriangle style={{width:12,height:12,color:"#dc2626"}}/>}
          {runStatus==="queued"&&<Clock style={{width:12,height:12,color:"#94a3b8"}}/>}
          {runStatus==="waiting_approval"&&<OctagonAlert style={{width:12,height:12,color:"#d97706"}}/>}
          <span style={{fontSize:10,fontWeight:700,letterSpacing:"0.08em",color:rs.badge,textTransform:"uppercase"}}>{rs.label}</span>
        </div>
        <span style={{fontSize:12,fontWeight:600,color:"#374151"}}>Run <span style={{color:"#9ca3af"}}>·</span> <span style={{fontFamily:"ui-monospace,monospace",color:"#4f46e5",fontWeight:700}}>{runId.slice(0,8)}</span></span>
        <div style={{width:1,height:16,background:"#e2e8f0"}}/>
        <span style={{fontSize:11,color:"#6b7280",fontFamily:"ui-monospace,monospace"}}>{fmtElapsed(elapsed)}</span>
        <div style={{width:1,height:16,background:"#e2e8f0"}}/>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:80,height:4,background:"#f1f5f9",borderRadius:2,overflow:"hidden"}}>
            <div style={{height:"100%",borderRadius:2,background:runStatus==="completed"?"#10b981":runStatus==="failed"?"#dc2626":"linear-gradient(90deg,#4f46e5,#7c3aed)",width:`${totalNodes>0?Math.round((completedCount/totalNodes)*100):0}%`,transition:"width 0.5s ease"}}/>
          </div>
          <span style={{fontSize:11,color:"#6b7280"}}>{completedCount}/{totalNodes}</span>
        </div>
        {pendingApproval&&<span style={{fontSize:10,fontWeight:700,color:"#d97706",border:"1px solid #fde68a",padding:"3px 10px",borderRadius:12,background:"#fffbeb",animation:"pulseGlow 1.5s ease-in-out infinite"}}>⚠ Awaiting approval</span>}
        <div style={{flex:1}}/>
        {isActive(runStatus)&&<button onClick={()=>cancelMutation.mutate()} disabled={cancelMutation.isPending} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,fontWeight:600,color:"#dc2626",background:"#fef2f2",border:"1px solid #fecaca",padding:"5px 14px",cursor:"pointer",fontFamily:"inherit",borderRadius:6}}><Square style={{width:11,height:11}}/> Cancel</button>}
      </div>

      {/* body */}
      <div style={{ display:"flex",flex:1,overflow:"hidden" }}>

        {/* left — pipeline */}
        <div style={{ width:leftCollapsed?40:276,flexShrink:0,borderRight:"1px solid #e2e8f0",background:"white",display:"flex",flexDirection:"column",overflow:"hidden",transition:"width 0.2s ease" }}>
          <div style={{ padding:"10px 12px",borderBottom:"1px solid #f1f5f9",display:"flex",alignItems:"center",gap:8,flexShrink:0 }}>
            {!leftCollapsed&&<p style={{fontSize:9,fontWeight:700,letterSpacing:"0.12em",color:"#94a3b8",margin:0,textTransform:"uppercase",flex:1}}>Pipeline · {totalNodes} steps</p>}
            <button onClick={()=>setLeftCollapsed(v=>!v)} title={leftCollapsed?"Expand pipeline":"Collapse pipeline"} style={{background:"none",border:"none",cursor:"pointer",color:"#94a3b8",display:"flex",padding:2,borderRadius:4,marginLeft:leftCollapsed?0:"auto"}}>
              {leftCollapsed?<PanelLeftOpen style={{width:14,height:14}}/>:<PanelLeftClose style={{width:14,height:14}}/>}
            </button>
          </div>
          {!leftCollapsed
            ? <StepTimeline steps={steps} allNodeIds={allNodeIds} selectedId={selectedStep?.id??null} onSelect={(s)=>{setSelectedStep(s);selectedStepIdRef.current=s.id;}} colMap={colMap}/>
            : (
              <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", alignItems:"center", paddingTop:8, gap:4 }}>
                {(allNodeIds.length ? allNodeIds : steps.map(s=>s.node_id)).map((nodeId) => {
                  const step = stepByNodeId[nodeId];
                  const status = step?.status ?? "queued";
                  const isRun = status === "running";
                  const col = colMap[nodeId] ?? 0;
                  const accent = laneColor(col);
                  return (
                    <div
                      key={nodeId}
                      onClick={() => step && (setSelectedStep(step), selectedStepIdRef.current = step.id, setLeftCollapsed(false))}
                      title={step?.agent_name ?? nodeId}
                      style={{ width:28, height:28, borderRadius:"50%", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center", cursor:step?"pointer":"default",
                        background: isRun ? `${accent}15` : "white",
                        border: `2px solid ${isRun ? accent : status==="completed" ? "#10b981" : status==="failed" ? "#dc2626" : status==="waiting_approval" ? "#d97706" : "#e2e8f0"}`,
                        boxShadow: isRun ? `0 0 8px ${accent}50` : "none",
                        transition: "all 0.3s",
                      }}
                    >
                      {isRun
                        ? <Loader2 style={{width:11,height:11,color:accent,animation:"spin 1s linear infinite"}}/>
                        : status==="completed" ? <CheckCircle2 style={{width:11,height:11,color:"#10b981"}}/>
                        : status==="failed"    ? <AlertTriangle style={{width:11,height:11,color:"#dc2626"}}/>
                        : status==="waiting_approval" ? <OctagonAlert style={{width:11,height:11,color:"#d97706"}}/>
                        : <span style={{width:6,height:6,borderRadius:"50%",background:"#e2e8f0",display:"block"}}/>}
                    </div>
                  );
                })}
              </div>
            )
          }
        </div>

        {/* canvas */}
        <div style={{ flex:1,position:"relative",overflow:"hidden" }}>
          <ReactFlowProvider>
            <RunCanvas
              graphNodes={layoutNodes}
              graphEdges={savedGraph.edges??[]}
              steps={steps}
              onNodeSelect={(s)=>{setSelectedStep(s);selectedStepIdRef.current=s.id;setRightCollapsed(false);}}
              colMap={colMap}
            />
          </ReactFlowProvider>
          {!savedGraph.nodes?.length&&<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center"}}><p style={{fontSize:12,color:"#94a3b8"}}>No graph saved — save the workflow first.</p></div>}
        </div>

        {/* right — log drawer, collapsible */}
        {selectedStep && (
          rightCollapsed ? (
            <div style={{ width:40,flexShrink:0,borderLeft:"1px solid #e2e8f0",background:"white",display:"flex",flexDirection:"column",alignItems:"center",paddingTop:12,gap:8 }}>
              <button onClick={()=>setRightCollapsed(false)} title="Expand output" style={{background:"none",border:"none",cursor:"pointer",color:"#94a3b8",display:"flex",padding:4,borderRadius:4}}>
                <PanelRightOpen style={{width:14,height:14}}/>
              </button>
              <div style={{width:3,height:40,borderRadius:2,background:selectedStepColor,opacity:0.5}}/>
            </div>
          ) : (
            <div style={{ display:"flex",flexDirection:"row",width:rightWidth,flexShrink:0 }}>
              {/* left drag handle */}
              <div
                onMouseDown={(e) => { rightDragging.current=true; rightStartX.current=e.clientX; rightStartW.current=rightWidth; e.preventDefault(); }}
                style={{ width:5, cursor:"col-resize", background:"transparent", flexShrink:0, display:"flex", alignItems:"center", justifyContent:"center" }}
              >
                <div style={{ width:3, height:32, borderRadius:2, background:"#e2e8f0" }} />
              </div>
              <div style={{ display:"flex",flexDirection:"column",flex:1,minWidth:0,overflow:"hidden" }}>
              <div style={{ padding:"6px 10px 0",display:"flex",justifyContent:"flex-end",background:"white",borderLeft:"1px solid #e2e8f0",borderBottom:"1px solid #f1f5f9",flexShrink:0 }}>
                <button onClick={()=>setRightCollapsed(true)} title="Collapse output" style={{background:"none",border:"none",cursor:"pointer",color:"#94a3b8",display:"flex",padding:4,borderRadius:4}}>
                  <PanelRightClose style={{width:14,height:14}}/>
                </button>
              </div>
              <LogDrawer
                step={selectedStep} token={token} runId={runId}
                onClose={()=>{setSelectedStep(null);selectedStepIdRef.current=null;}}
                approval={selectedStepApproval}
                gateConfig={selectedGateConfig}
                onApprove={(note)=>selectedStepApproval?.status==="pending"&&approveMutation.mutate({id:selectedStepApproval.id,note})}
                onReject={(note)=>selectedStepApproval?.status==="pending"&&rejectMutation.mutate({id:selectedStepApproval.id,note})}
                onRevise={(note)=>selectedStepApproval?.status==="pending"&&reviseMutation.mutate({id:selectedStepApproval.id,note})}
                laneColor={selectedStepColor}
              />
              </div>
            </div>
          )
        )}
      </div>

      <RunLogPanel logs={logs} colMap={colMap} stepByNodeId={stepByNodeId} />

      <style>{`
        @keyframes spin        { to { transform: rotate(360deg); } }
        @keyframes dotBounce   { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes scanline    { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
        @keyframes progressBar { 0% { width: 0%; } 60% { width: 80%; } 100% { width: 95%; } }
        @keyframes pulseGlow   { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
        .react-flow__node { transition: filter 0.3s; }
      `}</style>
    </div>
  );
}

export default function WorkflowRun() {
  return <RunViewInner />;
}
