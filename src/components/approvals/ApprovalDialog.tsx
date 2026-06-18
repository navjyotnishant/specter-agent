import type { ApprovalRequest } from "@/lib/types";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApprovalCard } from "./ApprovalCard";

export function ApprovalDialog({ approval, open, onOpenChange }: { approval?: ApprovalRequest; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="rounded-3xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-2xl font-black">Approval checkpoint</DialogTitle>
        </DialogHeader>
        {approval && <ApprovalCard approval={approval} />}
      </DialogContent>
    </Dialog>
  );
}
