import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  Cloud,
  Cpu,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
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

type ProviderProfile = {
  type: "ollama" | "openai-compatible" | "anthropic-compatible";
  label: string;
  shortLabel: string;
  defaultName: string;
  defaultBaseUrl: string;
  category: "Private" | "Hosted";
  description: string;
  governance: string;
  icon: typeof Cpu;
};

const providerProfiles: ProviderProfile[] = [
  {
    type: "ollama",
    label: "Ollama",
    shortLabel: "Ollama",
    defaultName: "Ollama secure review",
    defaultBaseUrl: "http://host.docker.internal:11434",
    category: "Private",
    description: "Use privately hosted models for code-aware agents and internal review flows.",
    governance: "Best for private code review and offline evaluation.",
    icon: Cpu,
  },
  {
    type: "openai-compatible",
    label: "OpenAI-compatible",
    shortLabel: "OpenAI",
    defaultName: "OpenAI-compatible reasoning",
    defaultBaseUrl: "https://api.openai.com/v1",
    category: "Hosted",
    description: "Connect a managed endpoint for supervisor planning, synthesis, and reporting work.",
    governance: "Best for high-quality planning and report generation.",
    icon: BrainCircuit,
  },
  {
    type: "anthropic-compatible",
    label: "Anthropic-compatible",
    shortLabel: "Anthropic",
    defaultName: "Anthropic-compatible reviewer",
    defaultBaseUrl: "https://api.anthropic.com",
    category: "Hosted",
    description: "Route long-context review and writing tasks through an approved hosted endpoint.",
    governance: "Best for long-form analysis and narrative reports.",
    icon: Cloud,
  },
];

const previewProviders: ModelProvider[] = providerProfiles.map((profile, index) => ({
  id: `${profile.type}-preview`,
  name: profile.defaultName,
  provider_type: profile.type,
  base_url: profile.defaultBaseUrl,
  is_configured: index === 0,
  created_at: new Date().toISOString(),
}));

function providerProfile(type: string) {
  return providerProfiles.find((profile) => profile.type === type) ?? providerProfiles[0];
}

function isConfigured(provider: ModelProvider) {
  return provider.is_configured === true || provider.is_configured === 1;
}

export default function Models() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState(providerProfiles[0].defaultName);
  const [providerType, setProviderType] = useState(providerProfiles[0].type);
  const [baseUrl, setBaseUrl] = useState(providerProfiles[0].defaultBaseUrl);
  const [isConfiguredState, setIsConfiguredState] = useState(true);
  const [error, setError] = useState("");

  const canUseBackend = Boolean(token && token !== "preview-mode");
  const { data = [], isLoading } = useQuery({
    queryKey: ["model-providers"],
    queryFn: () => api.modelProviders(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });
  const providers = data.length ? data : previewProviders;

  const metrics = useMemo(() => {
    const configured = providers.filter(isConfigured).length;
    const privateProviders = providers.filter((provider) => provider.provider_type === "ollama").length;
    return {
      total: providers.length,
      configured,
      draft: providers.length - configured,
      privateProviders,
    };
  }, [providers]);

  const resetForm = () => {
    const profile = providerProfiles[0];
    setEditingId(null);
    setName(profile.defaultName);
    setProviderType(profile.type);
    setBaseUrl(profile.defaultBaseUrl);
    setIsConfiguredState(true);
    setError("");
  };

  const selectProfile = (type: ProviderProfile["type"]) => {
    const profile = providerProfile(type);
    setProviderType(profile.type);
    if (!editingId) {
      setName(profile.defaultName);
      setBaseUrl(profile.defaultBaseUrl);
      setIsConfiguredState(profile.type === "ollama");
    }
  };

  const editProvider = (provider: ModelProvider) => {
    setEditingId(provider.id);
    setName(provider.name);
    setProviderType(providerProfile(provider.provider_type).type);
    setBaseUrl(provider.base_url ?? "");
    setIsConfiguredState(isConfigured(provider));
    setError("");
  };

  const payload = () => ({
    name: name.trim(),
    provider_type: providerType,
    base_url: baseUrl.trim() || undefined,
    is_configured: isConfiguredState,
  });

  const create = useMutation({
    mutationFn: () => api.createModelProvider(token ?? "", payload()),
    onSuccess: () => {
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to save model provider"),
  });

  const update = useMutation({
    mutationFn: () => api.updateModelProvider(token ?? "", editingId ?? "", payload()),
    onSuccess: () => {
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to update model provider"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteModelProvider(token ?? "", id),
    onSuccess: (_, id) => {
      if (editingId === id) resetForm();
      queryClient.invalidateQueries({ queryKey: ["model-providers"] });
    },
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (editingId) update.mutate();
    else create.mutate();
  };

  const isSaving = create.isPending || update.isPending;
  const selectedProfile = providerProfile(providerType);

  return (
    <div className="space-y-6">
      <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-4">
              <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-600 text-white">
                <Bot className="h-8 w-8" />
              </span>
              <div>
                <Badge className="mb-2 rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">Model governance</Badge>
                <h2 className="text-3xl font-black text-slate-950">Model providers</h2>
                <p className="mt-2 max-w-3xl text-slate-600">
                  Register approved model endpoints, control availability, and make provider choices explicit for agent workflows.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ["Total", metrics.total],
                ["Ready", metrics.configured],
                ["Draft", metrics.draft],
                ["Private", metrics.privateProviders],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-slate-100 bg-white px-4 py-3 text-center shadow-sm">
                  <p className="text-2xl font-black text-slate-950">{value}</p>
                  <p className="text-xs font-bold uppercase text-slate-500">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {providerProfiles.map((profile) => {
          const Icon = profile.icon;
          const selected = providerType === profile.type;
          return (
            <button
              key={profile.type}
              type="button"
              onClick={() => selectProfile(profile.type)}
              className={`rounded-3xl border bg-white/80 p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-200/70 ${
                selected ? "border-indigo-300 ring-2 ring-indigo-100" : "border-white/80"
              }`}
            >
              <div className="flex items-start justify-between gap-4">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800">
                  <Icon className="h-6 w-6" />
                </span>
                <Badge className={`rounded-full ${profile.category === "Private" ? "bg-emerald-100 text-emerald-800" : "bg-indigo-100 text-indigo-800"} hover:bg-current/0`}>
                  {profile.category}
                </Badge>
              </div>
              <h3 className="mt-4 text-lg font-black text-slate-950">{profile.label}</h3>
              <p className="mt-2 min-h-12 text-sm leading-6 text-slate-600">{profile.description}</p>
              <p className="mt-3 text-xs font-semibold text-slate-500">{profile.governance}</p>
            </button>
          );
        })}
      </div>

      <Card className="rounded-[2rem] border-white/80 bg-white/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="flex items-center gap-2 text-xl font-black text-slate-950">
                {editingId ? <Pencil className="h-5 w-5 text-indigo-600" /> : <Plus className="h-5 w-5 text-indigo-600" />}
                {editingId ? "Edit provider" : "Register provider"}
              </h3>
              <p className="mt-1 text-sm text-slate-600">{selectedProfile.governance}</p>
            </div>
            {editingId && (
              <Button type="button" onClick={resetForm} variant="outline" className="w-fit rounded-2xl bg-white">
                <X className="mr-2 h-4 w-4" /> Cancel edit
              </Button>
            )}
          </div>
          <form onSubmit={onSubmit} className="grid gap-3 xl:grid-cols-[1fr_220px_1.2fr_auto_auto] xl:items-end">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input className="rounded-2xl" value={name} onChange={(event) => setName(event.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Type</Label>
              <Select value={providerType} onValueChange={(value: ProviderProfile["type"]) => selectProfile(value)}>
                <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {providerProfiles.map((profile) => (
                    <SelectItem key={profile.type} value={profile.type}>{profile.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Endpoint URL</Label>
              <Input className="rounded-2xl" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://provider.example.com" />
            </div>
            <div className="flex items-center gap-3 rounded-2xl border bg-slate-50 px-4 py-3">
              <Switch checked={isConfiguredState} onCheckedChange={setIsConfiguredState} />
              <Label>Available</Label>
            </div>
            <Button disabled={isSaving || !canUseBackend} className="rounded-2xl bg-indigo-600 hover:bg-indigo-700">
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingId ? "Save changes" : "Save provider"}
            </Button>
          </form>
          {!canUseBackend && <p className="mt-3 text-sm text-slate-500">Saving providers is available when the service is connected.</p>}
          {error && <Alert variant="destructive" className="mt-4 rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <div className="grid gap-4">
        {isLoading && canUseBackend && (
          <Card className="rounded-3xl border-white/80 bg-white/80 p-6 text-slate-600">Loading providers...</Card>
        )}
        {providers.map((provider) => {
          const profile = providerProfile(provider.provider_type);
          const Icon = profile.icon;
          const configured = isConfigured(provider);
          return (
            <Card key={provider.id} className="rounded-3xl border-white/80 bg-white/80">
              <CardContent className="grid gap-5 p-5 lg:grid-cols-[1fr_auto] lg:items-center">
                <div className="flex min-w-0 gap-4">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800">
                    <Icon className="h-6 w-6" />
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-xl font-black text-slate-950">{provider.name}</h3>
                      <Badge className={`rounded-full ${configured ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"} hover:bg-current/0`}>
                        {configured ? "Available" : "Draft"}
                      </Badge>
                      <Badge variant="outline" className="rounded-full bg-white">{profile.shortLabel}</Badge>
                    </div>
                    <p className="mt-2 break-all text-sm text-slate-600">{provider.base_url || "Endpoint URL not set"}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Badge variant="outline" className="rounded-full bg-white">
                        <ShieldCheck className="mr-1 h-3 w-3" /> Policy controlled
                      </Badge>
                      <Badge variant="outline" className="rounded-full bg-white">
                        <CheckCircle2 className="mr-1 h-3 w-3" /> Per-agent selectable
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 lg:justify-end">
                  <Button
                    type="button"
                    disabled={!canUseBackend}
                    onClick={() => editProvider(provider)}
                    variant="outline"
                    className="rounded-2xl bg-white"
                  >
                    <SlidersHorizontal className="mr-2 h-4 w-4" /> Configure
                  </Button>
                  <Button
                    disabled={!canUseBackend || remove.isPending}
                    onClick={() => remove.mutate(provider.id)}
                    variant="outline"
                    size="icon"
                    className="rounded-2xl border-red-200 text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
