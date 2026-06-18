import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { GitBranch, History, Settings, Sparkles } from "lucide-react";
import { ProtectedRoute } from "./components/auth/ProtectedRoute";
import { AppShell } from "./components/layout/AppShell";
import { AuthProvider } from "./lib/auth";
import Approvals from "./pages/Approvals";
import Connectors from "./pages/Connectors";
import Dashboard from "./pages/Dashboard";
import Index from "./pages/Index";
import Login from "./pages/Login";
import Models from "./pages/Models";
import NotFound from "./pages/NotFound";
import { PlaceholderPage } from "./pages/PlaceholderPage";
import Setup from "./pages/Setup";
import Skills from "./pages/Skills";
import Users from "./pages/Users";
import WorkflowBuilder from "./pages/WorkflowBuilder";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/login" element={<Login />} />
            <Route path="/workflowssecurity-review-team/builder" element={<Navigate to="/workflows/security-review-team/builder" replace />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AppShell />}>
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/workflows" element={<PlaceholderPage title="Workflows" description="Create visual automation graphs with basic nodes, agent orchestration, memory movement, and approval gates." icon={GitBranch} items={["Security Review Team template", "Custom workflow creation", "Graph JSON persistence", "Manual and scheduled triggers"]} />} />
                <Route path="/workflows/:workflowId/builder" element={<WorkflowBuilder />} />

                <Route path="/skills" element={<Skills />} />
                <Route path="/skills/:skillId" element={<PlaceholderPage title="Skill detail" description="Inspect compatibility, default model hints, prompt behavior, and safety requirements for a reusable skill." icon={Sparkles} items={["Prompt template", "Agent compatibility", "Default model", "Tool requirements"]} />} />
                <Route path="/runs" element={<PlaceholderPage title="Workflow runs" description="Audit manual and scheduled executions with live agent logs, memory writes, approval events, and artifacts." icon={History} items={["Live run console", "Agent timeline", "Step timeline", "Artifacts and final reports"]} />} />
                <Route path="/runs/:runId" element={<PlaceholderPage title="Run detail" description="Review a single workflow run, including agent messages, memory entries, approval decisions, and final output." icon={History} items={["Agent messages", "Shared memory", "Approval history", "Final security report"]} />} />
                <Route path="/approvals" element={<Approvals />} />
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
