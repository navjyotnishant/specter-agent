import { Link } from "react-router-dom";
import { Bell, CircleDot, Database, Menu, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function TopBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-white/70 bg-[#f7fbff]/85 px-4 py-4 backdrop-blur-xl sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button variant="outline" size="icon" className="rounded-2xl border-slate-200 bg-white lg:hidden">
            <Menu className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-black tracking-tight text-slate-950 sm:text-2xl">AI SDLC Command Center</h1>
              <Badge className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-800 hover:bg-emerald-100">
                <CircleDot className="mr-1 h-3 w-3 fill-current" /> Local runtime
              </Badge>
            </div>
            <p className="mt-1 text-sm text-slate-600">Build, run, approve, and audit multi-agent software delivery workflows.</p>
          </div>
        </div>
        <div className="hidden items-center gap-2 md:flex">
          <Badge variant="outline" className="rounded-full border-cyan-200 bg-white px-3 py-2 text-cyan-800">
            <Database className="mr-1 h-3.5 w-3.5" /> SQLite WAL
          </Badge>
          <Badge variant="outline" className="rounded-full border-indigo-200 bg-white px-3 py-2 text-indigo-800">
            <Shield className="mr-1 h-3.5 w-3.5" /> Approval gates
          </Badge>
          <Button asChild className="rounded-2xl bg-indigo-600 text-white hover:bg-indigo-700">
            <Link to="/approvals"><Bell className="mr-2 h-4 w-4" /> Pending approvals</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
