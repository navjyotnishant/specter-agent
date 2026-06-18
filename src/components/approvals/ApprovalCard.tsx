import { AlertTriangle, CheckCircle2, MessageSquare, XCircle } from "lucide-react";
import type { ApprovalRequest } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export function ApprovalCard({ approval, onResolve }: { approval: ApprovalRequest; onResolve?: (action: "approve" | "reject" | "request-revision") => void }) {
  return (
    <Card className="rounded-3xl border-amber-200 bg-amber-50/80 shadow-sm">
      <CardContent className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-200 text-amber-950">
              <AlertTriangle className="h-6 w-6" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-black text-slate-950">{approval.title}</h3>
                <Badge className="rounded-full bg-white text-amber-900 hover:bg-white">{approval.status}</Badge>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-700">{approval.reason}</p>
              <p className="mt-2 text-sm text-slate-600"><span className="font-semibold">Requested by:</span> {approval.requested_by_agent ?? "Workflow runtime"}</p>
              <div className="mt-3 rounded-2xl border border-amber-200 bg-white/70 p-3 text-sm text-slate-700">
                {approval.context_summary || "Awaiting human review before this branch can continue."}
              </div>
            </div>
          </div>
          {approval.status === "pending" && onResolve && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button onClick={() => onResolve("approve")} className="rounded-2xl bg-emerald-600 hover:bg-emerald-700"><CheckCircle2 className="mr-2 h-4 w-4" /> Approve</Button>
              <Button onClick={() => onResolve("request-revision")} variant="outline" className="rounded-2xl border-indigo-200 bg-white"><MessageSquare className="mr-2 h-4 w-4" /> Request revision</Button>
              <Button onClick={() => onResolve("reject")} variant="destructive" className="rounded-2xl"><XCircle className="mr-2 h-4 w-4" /> Reject</Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
