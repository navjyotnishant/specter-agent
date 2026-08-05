import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Settings, Sparkles } from "lucide-react";
import { ProtectedRoute } from "./components/auth/ProtectedRoute";
import { AppShell } from "./components/layout/AppShell";
import { AuthProvider } from "./lib/auth";
import Connectors from "./pages/Connectors";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Models from "./pages/Models";
import NotFound from "./pages/NotFound";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import Setup from "./pages/Setup";
import Skills from "./pages/Skills";
import Users from "./pages/Users";
import WorkflowBuilder from "./pages/WorkflowBuilder";
import WorkflowRun from "./pages/WorkflowRun";
import Workflows from "./pages/Workflows";
import { ParityHarness } from "./dev/ParityHarness";

// Dev-only: seed a throwaway session for the design-parity harness, BEFORE the
// app reads localStorage. Pages gate their queries on `Boolean(token)`, so with
// no token every query stays disabled and never reads the pre-seeded cache —
// the builder rendered "Untitled" with an empty canvas and the gate reported a
// fully-built page as ~40 missing elements.
//
// Nothing is ever sent with this token; the harness resolves everything from
// cache. `import.meta.env.DEV` is statically false in a production build, so
// this block is dropped from the bundle entirely.
if (import.meta.env.DEV && window.location.pathname.startsWith("/__parity")) {
  const HARNESS_USER = {
    id: "u-1", email: "admin@local.dev", role: "admin" as const,
    created_at: "2026-06-19 09:00:00",
  };
  try {
    localStorage.setItem("sdlc_auth_token", "parity-harness-not-a-real-token");
    localStorage.setItem("sdlc_auth_user", JSON.stringify(HARNESS_USER));
  } catch { /* storage disabled — token-gated queries will render empty */ }

  // AuthProvider verifies the stored token against /auth/me on boot and calls
  // clearSession() when that fails — which is exactly right for the real app and
  // exactly wrong here, because it wiped the token before any page could read
  // it. Answer only those two auth probes locally; every other request still
  // goes to the network (and the seeded cache means none are made).
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/status"))
      return Promise.resolve(Response.json({ needs_setup: false }));
    if (url.includes("/auth/me"))
      return Promise.resolve(Response.json({ user: HARNESS_USER }));
    return realFetch(input as RequestInfo, init);
  }) as typeof window.fetch;
}

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            {/* No landing page — go straight to the app. ProtectedRoute bounces
                unauthenticated visitors to /login (or /setup on first run). */}
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/login" element={<Login />} />
            {/* Dev-only: renders a page against fixture data so the design-parity
                gate can measure it without a session. `import.meta.env.DEV` is
                statically false in a production build, so this route and the
                harness it points at are dropped from the bundle entirely. */}
            {import.meta.env.DEV && (
              <>
                <Route path="/__parity/:page" element={<ParityHarness />} />
                {/* Named :workflowId, not :id — the builder reads useParams()
                    .workflowId directly, so a differently-named segment left it
                    on its "security-review-team" default and it queried a
                    workflow the fixtures do not contain. */}
                <Route path="/__parity/:page/:workflowId" element={<ParityHarness />} />
              </>
            )}
            <Route path="/workflowssecurity-review-team/builder" element={<Navigate to="/workflows/security-review-team/builder" replace />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/workflows/:workflowId/run/:runId" element={<WorkflowRun />} />
              <Route element={<AppShell />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/workflows" element={<Workflows />} />
                <Route path="/workflows/:workflowId/builder" element={<WorkflowBuilder />} />

                <Route path="/skills" element={<Skills />} />

                <Route path="/skills/:skillId" element={<PlaceholderPage title="Skill detail" description="Inspect compatibility, default model hints, prompt behavior, and safety requirements for a reusable skill." icon={Sparkles} items={["Prompt template", "Agent compatibility", "Default model", "Tool requirements"]} />} />
                <Route path="/settings/models" element={<Models />} />
                <Route path="/settings/connectors" element={<Connectors />} />

                <Route path="/settings/users" element={<Users />} />
                <Route path="/settings" element={<Navigate to="/settings/models" replace />} />
                <Route path="/admin" element={<PlaceholderPage title="Admin settings" description="Runtime, retention, safety, scheduling, and local deployment settings." icon={Settings} items={["Memory retention", "Log cleanup", "Scheduler settings", "Backup paths"]} />} />
              </Route>
            </Route>
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
