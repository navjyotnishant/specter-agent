import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { ApprovalCard } from "@/components/approvals/ApprovalCard";
import { Card, CardContent } from "@/components/ui/card";

export default function Approvals() {
  const queryClient = useQueryClient();
  const { data = [] } = useQuery({ queryKey: ["approvals"], queryFn: api.approvals, retry: false });
  const resolve = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "reject" | "request-revision" }) =>
      api.resolveApproval(id, action, `Resolved from approval console: ${action}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["approvals"] }),
  });

  const demoApprovals = data.length
    ? data
    : [
        {
          id: "demo-approval",
          workflow_run_id: "demo-run",
          status: "pending" as const,
          title: "Approve final security report generation",
          reason: "The Security Supervisor Agent has aggregated specialist outputs and is paused before final report generation.",
          context_summary: "Code review, dependency review, and secrets/config review outputs are ready. No external writes will occur until approved.",
          requested_by_agent: "Security Supervisor Agent",
          created_at: new Date().toISOString(),
        },
      ];

  return (
    <div className="space-y-6">
      <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex items-center gap-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-amber-200 text-amber-950">
              <CheckCircle2 className="h-8 w-8" />
            </span>
            <div>
              <h2 className="text-3xl font-black text-slate-950">Pending approvals</h2>
              <p className="mt-2 text-slate-600">Review paused workflow branches, final reports, and proposed risky actions.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        {demoApprovals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} onResolve={approval.id === "demo-approval" ? undefined : (action) => resolve.mutate({ id: approval.id, action })} />
        ))}
      </div>
    </div>
  );
}
