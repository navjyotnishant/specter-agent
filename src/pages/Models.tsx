import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, CheckCircle2, Loader2, Plus, Server, Trash2 } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { ModelProvider } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const previewProviders: ModelProvider[] = [
  { id: "ollama-preview", name: "Local Ollama", provider_type: "ollama", base_url: "http://host.docker.internal:11434", is_configured: true, created_at: new Date().toISOString() },
  { id: "openai-preview", name: "OpenAI-compatible", provider_type: "openai-compatible", base_url: "https://api.openai.com/v1", is_configured: false, created_at: new Date().toISOString() },
  { id: "anthropic-preview", name: "Anthropic-compatible", provider_type: "anthropic-compatible", base_url: "https://api.anthropic.com", is_configured: false, created_at: new Date().toISOString() },
];

export default function Models() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [name, setName] = useState("Local Ollama");
  const [providerType, setProviderType] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState("http://host.docker.internal:11434");
  const [isConfigured, setIsConfigured] = useState(true);
  const [error, setError] = useState("");

  const { data = [] } = useQuery({ queryKey: ["model-providers"], queryFn: () => api.modelProviders(token ?? ""), enabled: Boolean(token && token !== "preview-mode"), retry: false });
  const providers = data.length ? data : previewProviders;

  const create = useMutation({
    mutationFn: () => api.createModelProvider(token ?? "", { name, provider_type: providerType, base_url: baseUrl, is_configured: isConfigured }),
    onSuccess: () => {
      setError("");
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to save model provider"),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteModelProvider(token ?? "", id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["model-providers"] }) });

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
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-600 text-white"><Bot className="h-8 w-8" /></span>
            <div>
              <Badge className="mb-2 rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">Model routing</Badge>
              <h2 className="text-3xl font-black text-slate-950">Model providers</h2>
              <p className="mt-2 text-slate-600">Configure approved model endpoints for supervisors and specialist agents.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-[2rem] border-white/80 bg-white/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <h3 className="mb-5 flex items-center gap-2 text-xl font-black text-slate-950"><Plus className="h-5 w-5 text-indigo-600" /> Add provider</h3>
          <form onSubmit={onSubmit} className="grid gap-3 xl:grid-cols-[1fr_220px_1fr_auto_auto] xl:items-end">
            <div className="space-y-2"><Label>Name</Label><Input className="rounded-2xl" value={name} onChange={(event) => setName(event.target.value)} required /></div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={providerType} onValueChange={setProviderType}>
                <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama</SelectItem>
                  <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                  <SelectItem value="anthropic-compatible">Anthropic-compatible</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2"><Label>Base URL</Label><Input className="rounded-2xl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></div>
            <div className="flex items-center gap-3 rounded-2xl border bg-slate-50 px-4 py-3"><Switch checked={isConfigured} onCheckedChange={setIsConfigured} /><Label>Configured</Label></div>
            <Button disabled={create.isPending || token === "preview-mode"} className="rounded-2xl bg-indigo-600 hover:bg-indigo-700">{create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save</Button>
          </form>
          {token === "preview-mode" && <p className="mt-3 text-sm text-slate-500">Saving providers is available when the service is connected.</p>}
          {error && <Alert variant="destructive" className="mt-4 rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {providers.map((provider) => (
          <Card key={provider.id} className="rounded-3xl border-white/80 bg-white/80">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><Server className="h-6 w-6" /></span>
                <Badge className={`rounded-full ${provider.is_configured ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"} hover:bg-current/0`}>{provider.is_configured ? "Configured" : "Draft"}</Badge>
              </div>
              <h3 className="mt-4 text-xl font-black text-slate-950">{provider.name}</h3>
              <p className="mt-1 text-sm font-semibold text-indigo-700">{provider.provider_type}</p>
              <p className="mt-3 break-all text-sm text-slate-600">{provider.base_url || "No base URL set"}</p>
              <div className="mt-5 flex justify-between gap-2">
                <Badge variant="outline" className="rounded-full bg-white"><CheckCircle2 className="mr-1 h-3 w-3" /> Per-agent selectable</Badge>
                <Button disabled={token === "preview-mode" || remove.isPending} onClick={() => remove.mutate(provider.id)} variant="outline" size="icon" className="rounded-2xl border-red-200 text-red-700 hover:bg-red-50"><Trash2 className="h-4 w-4" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
