import { Outlet } from "react-router-dom";
import { SidebarNav } from "./SidebarNav";
import { TopBar } from "./TopBar";

export function AppShell() {
  return (
    <div className="min-h-screen bg-[#f7fbff] text-slate-950">
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -left-24 top-16 h-72 w-72 rounded-full bg-cyan-200/50 blur-3xl" />
        <div className="absolute right-0 top-40 h-96 w-96 rounded-full bg-indigo-200/50 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-72 w-72 rounded-full bg-amber-100/70 blur-3xl" />
      </div>
      <div className="relative flex min-h-screen flex-col">
        <div className="flex flex-1">
          <SidebarNav />
          <main className="min-w-0 flex-1 flex flex-col">
            <TopBar />
            <div className="flex-1 p-4 sm:p-6 lg:p-8">
              <Outlet />
            </div>
            <footer className="border-t border-white/60 bg-white/40 backdrop-blur-sm px-6 py-3">
              <p className="text-center text-xs text-slate-400">
                &copy; {new Date().getFullYear()} Navjyot Labs. All rights reserved.{" "}
                <span className="mx-1 text-slate-300">&middot;</span>
                Specter Agent — Agentic delivery operations platform.
              </p>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}
