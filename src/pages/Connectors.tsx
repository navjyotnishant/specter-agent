import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderLock, Loader2, Network, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { Connector } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const previewConnectors: Connector[] = [
  { id: "local-codebase", name: "Read-only local codebases", connector_type: "local-codebase", config_json: '{"root":"/app/codebases","allowlist":["/app/codebases"],"exclusions":[".git","node_modules",".env"]}', is_configured: true, created_at: new Date().toISOString() },
  { id: "mcp-preview", name: "MCP Tool Gateway", connector_type: "mcp", config_json: '{"servers":[]}', is_configured: false, created_at: new Date().toISOString() },
  { id: "jira-preview", name: "Jira Action Shell", connector_type: "jira", config_json: '{"write_actions_require_approval":true}', is_configured: false, created_at: new Date().toISOString() },
];

function parseConfig(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return { raw: value };
  }
}

export default function Connectors() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [name, setName] = useState("Read-only local codebases");
  const [connectorType, setConnectorType] = useState("local-codebase");
  const [config, setConfig] = useState('{"root":"/app/codebases","allowlist":["/app/codebases"],"exclusions":[".git","node_modules",".env"]}');
  const [isConfigured, setIsConfigured] = useState(true);
  const [error, setError] = useState("");

  const { data = [] } = useQuery({ queryKey: ["connectors"], queryFn: () => api.connectors(token ?? ""), enabled: Boolean(token && token !== "preview-mode"), retry: false });
  const connectors = data.length ? data : previewConnectors;

  const create = useMutation({
    mutationFn: () => api.createConnector(token ?? "", { name, connector_type: connectorType, config: parseConfig(config), is_configured: isConfigured }),
    onSuccess: () => {
      setError("");
      queryClient.invalidateQueries({ queryKey: ["connectors"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to save connector"),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteConnector(token ?? "", id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["connectors"] }) });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    create.mutate();
  };

  return (
    <div className="space-y-6">
      <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex items-center gap-4">
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-600 text-white"><Network className="h-8 w-8" /></span>
            <div>
              <Badge className="mb-2 rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">Tool boundaries</Badge>
              <h2 className="text-3xl font-black text-slate-950">Connectors</h2>
              <p className="mt-2 text-slate-600">Configure MCP tools, local codebase allowlists, GitHub/Jira shells, and command execution boundaries.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-[2rem] border-white/80 bg-white/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <h3 className="mb-5 flex items-center gap-2 text-xl font-black text-slate-950"><Plus className="h-5 w-5 text-indigo-600" /> Add connector</h3>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-3 lg:grid-cols-[1fr_240px_auto] lg:items-end">
              <div className="space-y-2"><Label>Name</Label><Input className="rounded-2xl" value={name} onChange={(event) => setName(event.target.value)} required /></div>
              <div className="space-y-2">
                <Label>Type</Label>
                <Select value={connectorType} onValueChange={setConnectorType}>
                  <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local-codebase">Local codebase</SelectItem>
                    <SelectItem value="mcp">MCP</SelectItem>
                    <SelectItem value="github">GitHub</SelectItem>
                    <SelectItem value="jira">Jira</SelectItem>
                    <SelectItem value="command-runner">Command runner</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3 rounded-2xl border bg-slate-50 px-4 py-3"><Switch checked={isConfigured} onCheckedChange={setIsConfigured} /><Label>Configured</Label></div>
            </div>
            <div className="space-y-2"><Label>Config JSON</Label><Textarea className="min-h-28 rounded-2xl font-mono text-sm" value={config} onChange={(event) => setConfig(event.target.value)} /></div>
            <Button disabled={create.isPending || token === "preview-mode"} className="w-fit rounded-2xl bg-indigo-600 hover:bg-indigo-700">{create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save connector</Button>
          </form>
          {token === "preview-mode" && <p className="mt-3 text-sm text-slate-500">Saving connectors is available when the FastAPI backend is running.</p>}
          {error && <Alert variant="destructive" className="mt-4 rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {connectors.map((connector) => (
          <Card key={connector.id} className="rounded-3xl border-white/80 bg-white/80">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><FolderLock className="h-6 w-6" /></span>
                <Badge className={`rounded-full ${connector.is_configured ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"} hover:bg-current/0`}>{connector.is_configured ? "Configured" : "Draft"}</Badge>
              </div>
              <h3 className="mt-4 text-xl font-black text-slate-950">{connector.name}</h3>
              <p className="mt-1 text-sm font-semibold text-indigo-700">{connector.connector_type}</p>
              <pre className="mt-4 max-h-36 overflow-auto rounded-2xl bg-slate-950 p-3 text-xs leading-5 text-cyan-100">{connector.config_json}</pre>
              <div className="mt-5 flex justify-between gap-2">
                <Badge variant="outline" className="rounded-full bg-white"><ShieldCheck className="mr-1 h-3 w-3" /> Approval aware</Badge>
                <Button disabled={token === "preview-mode" || remove.isPending} onClick={() => remove.mutate(connector.id)} variant="outline" size="icon" className="rounded-2xl border-red-200 text-red-700 hover:bg-red-50"><Trash2 className="h-4 w-4" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
