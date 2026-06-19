import { NavLink } from "react-router-dom";
import {
  Bot,
  CheckCircle2,
  GitBranch,
  History,
  LayoutDashboard,
  Network,
  Settings2,
  ShieldCheck,
  Users,
  Wrench,
} from "lucide-react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/workflows", label: "Workflows", icon: GitBranch },
  { href: "/skills", label: "Skills", icon: Wrench },
  { href: "/runs", label: "Runs", icon: History },
  { href: "/approvals", label: "Approvals", icon: CheckCircle2 },
  { href: "/settings/models", label: "Models", icon: Bot },
  { href: "/settings/connectors", label: "Connectors", icon: Network },
  { href: "/settings/users", label: "Users", icon: Users },
];

export function SidebarNav() {
  return (
    <aside className="hidden min-h-screen w-72 shrink-0 border-r border-white/60 bg-white/75 p-5 shadow-sm backdrop-blur-xl lg:block">
      <NavLink to="/dashboard" className="mb-8 flex items-center gap-3 rounded-3xl bg-slate-950 p-3 text-white shadow-lg shadow-slate-200">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-400 text-slate-950">
          <ShieldCheck className="h-6 w-6" />
        </span>
        <span>
          <span className="block text-lg font-bold">Specter Agent</span>
          <span className="block text-xs font-semibold text-cyan-100">Agentic delivery operations</span>
        </span>
      </NavLink>

      <div className="mb-5 rounded-3xl border border-cyan-100 bg-cyan-50/80 p-4 text-sm text-cyan-950">
        <div className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="h-4 w-4" /> Governed workspace
        </div>
        <p className="mt-1 text-cyan-800">Workflows, approvals, memory, and run evidence stay organized for review.</p>
      </div>

      <nav className="space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.href}
              to={item.href}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-semibold transition ${
                  isActive
                    ? "bg-indigo-600 text-white shadow-lg shadow-indigo-100"
                    : "text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"
                }`
              }
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          );
        })}
      </nav>

      <div className="mt-8 rounded-3xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
          <Settings2 className="h-4 w-4" /> Agent safety defaults
        </div>
        <p className="mt-2 text-xs leading-5 text-slate-600">Bounded iterations, allowlisted tools, masked memory, and approval gates before risky actions.</p>
      </div>
    </aside>
  );
}
