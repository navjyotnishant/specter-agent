import { useState } from "react";
import { NavLink } from "react-router-dom";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  GitBranch,
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
  { href: "/settings/models", label: "Models", icon: Bot },
  { href: "/settings/connectors", label: "Connectors", icon: Network },
  { href: "/settings/users", label: "Users", icon: Users },
];

export function SidebarNav() {
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem("specter_sidebar_collapsed") === "1"; } catch { return false; }
  });

  const toggle = () => setCollapsed((prev) => {
    const next = !prev;
    try { localStorage.setItem("specter_sidebar_collapsed", next ? "1" : "0"); } catch {}
    return next;
  });

  return (
    <aside
      className="relative hidden min-h-screen shrink-0 border-r border-white/60 bg-white/75 shadow-sm backdrop-blur-xl lg:flex lg:flex-col transition-all duration-200"
      style={{ width: collapsed ? 64 : 288 }}
    >
      {/* toggle button — sits on the right edge, vertically centred */}
      <button
        onClick={toggle}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        className="absolute -right-3 top-1/2 z-20 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white shadow-sm text-slate-400 hover:text-slate-700"
      >
        {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>

      <div className={`flex-1 overflow-hidden ${collapsed ? "px-2 py-5" : "p-5"}`}>
        {/* logo */}
        {collapsed ? (
          <NavLink to="/dashboard" className="mb-6 flex items-center justify-center rounded-2xl bg-slate-950 p-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-400 text-slate-950">
              <ShieldCheck className="h-5 w-5" />
            </span>
          </NavLink>
        ) : (
          <NavLink to="/dashboard" className="mb-8 flex items-center gap-3 rounded-3xl bg-slate-950 p-3 text-white shadow-lg shadow-slate-200">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-400 text-slate-950">
              <ShieldCheck className="h-6 w-6" />
            </span>
            <span>
              <span className="block text-lg font-bold">Specter Agent</span>
              <span className="block text-xs font-semibold text-cyan-100">Agentic delivery operations</span>
            </span>
          </NavLink>
        )}

        {/* governed workspace card — hidden when collapsed */}
        {!collapsed && (
          <div className="mb-5 rounded-3xl border border-cyan-100 bg-cyan-50/80 p-4 text-sm text-cyan-950">
            <div className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4" /> Governed workspace
            </div>
            <p className="mt-1 text-cyan-800">Workflows, approvals, memory, and run evidence stay organized for review.</p>
          </div>
        )}

        {/* nav items */}
        <nav className="space-y-2">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.href}
                to={item.href}
                title={collapsed ? item.label : undefined}
                className={({ isActive }) =>
                  `flex items-center rounded-2xl transition ${
                    collapsed ? "justify-center px-2 py-3" : "gap-3 px-4 py-3"
                  } text-sm font-semibold ${
                    isActive
                      ? "bg-indigo-600 text-white shadow-lg shadow-indigo-100"
                      : "text-slate-600 hover:bg-indigo-50 hover:text-indigo-700"
                  }`
                }
              >
                <Icon className="h-4 w-4 shrink-0" />
                {!collapsed && item.label}
              </NavLink>
            );
          })}
        </nav>

        {/* safety defaults — hidden when collapsed */}
        {!collapsed && (
          <div className="mt-8 rounded-3xl border border-slate-200 bg-slate-50 p-4">
            <div className="flex items-center gap-2 text-sm font-bold text-slate-800">
              <Settings2 className="h-4 w-4" /> Agent safety defaults
            </div>
            <p className="mt-2 text-xs leading-5 text-slate-600">Bounded iterations, allowlisted tools, masked memory, and approval gates before risky actions.</p>
          </div>
        )}
      </div>
    </aside>
  );
}
