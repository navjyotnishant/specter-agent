import { FormEvent, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, Plus, Sparkles, Trash2 } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { Skill } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const previewSkills: Skill[] = [
  { id: "secure-code-review", name: "Secure Code Review", description: "Review source files for insecure patterns and sensitive data handling issues.", prompt_template: "Return findings grouped by severity with evidence and remediation.", compatible_agent_roles: "['Code reviewer','Supervisor Agent']", created_at: new Date().toISOString() },
  { id: "dependency-risk-review", name: "Dependency Risk Review", description: "Inspect manifests and lockfiles for outdated or risky packages.", prompt_template: "Identify risky packages and practical remediation steps.", compatible_agent_roles: "['Dependency auditor']", created_at: new Date().toISOString() },
  { id: "secrets-config-review", name: "Secrets & Config Risk Review", description: "Find accidental secret exposure while masking sensitive values.", prompt_template: "Never reveal full secrets. Mask sensitive values.", compatible_agent_roles: "['Secrets and configuration reviewer']", created_at: new Date().toISOString() },
];

export default function Skills() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [name, setName] = useState("Security Report Writer");
  const [description, setDescription] = useState("Aggregate specialist findings into an auditable report.");
  const [roles, setRoles] = useState("Security report writer, Supervisor Agent");
  const [promptTemplate, setPromptTemplate] = useState("Create a final report with summary, severity table, evidence, remediation, and approval notes.");
  const [error, setError] = useState("");

  const { data = [] } = useQuery({ queryKey: ["skills"], queryFn: () => api.skills(token ?? ""), enabled: Boolean(token && token !== "preview-mode"), retry: false });
  const skills = data.length ? data : previewSkills;

  const create = useMutation({
    mutationFn: () => api.createSkill(token ?? "", { name, description, prompt_template: promptTemplate, compatible_agent_roles: roles.split(",").map((role) => role.trim()).filter(Boolean) }),
    onSuccess: () => {
      setError("");
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to save skill"),
  });
  const remove = useMutation({ mutationFn: (id: string) => api.deleteSkill(token ?? "", id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["skills"] }) });

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
            <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-600 text-white"><Sparkles className="h-8 w-8" /></span>
            <div>
              <Badge className="mb-2 rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">Reusable behavior</Badge>
              <h2 className="text-3xl font-black text-slate-950">Skill Library</h2>
              <p className="mt-2 text-slate-600">Create prompt/tool behaviors that can be attached to agents or standard workflow nodes.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-[2rem] border-white/80 bg-white/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <h3 className="mb-5 flex items-center gap-2 text-xl font-black text-slate-950"><Plus className="h-5 w-5 text-indigo-600" /> Add skill</h3>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-2"><Label>Name</Label><Input className="rounded-2xl" value={name} onChange={(event) => setName(event.target.value)} required /></div>
              <div className="space-y-2"><Label>Compatible roles</Label><Input className="rounded-2xl" value={roles} onChange={(event) => setRoles(event.target.value)} /></div>
            </div>
            <div className="space-y-2"><Label>Description</Label><Input className="rounded-2xl" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
            <div className="space-y-2"><Label>Prompt template</Label><Textarea className="min-h-28 rounded-2xl" value={promptTemplate} onChange={(event) => setPromptTemplate(event.target.value)} /></div>
            <Button disabled={create.isPending || token === "preview-mode"} className="w-fit rounded-2xl bg-indigo-600 hover:bg-indigo-700">{create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Save skill</Button>
          </form>
          {token === "preview-mode" && <p className="mt-3 text-sm text-slate-500">Saving skills is available when the FastAPI backend is running.</p>}
          {error && <Alert variant="destructive" className="mt-4 rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {skills.map((skill) => (
          <Card key={skill.id} className="rounded-3xl border-white/80 bg-white/80">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><Brain className="h-6 w-6" /></span>
                <Button disabled={token === "preview-mode" || remove.isPending} onClick={() => remove.mutate(skill.id)} variant="outline" size="icon" className="rounded-2xl border-red-200 text-red-700 hover:bg-red-50"><Trash2 className="h-4 w-4" /></Button>
              </div>
              <h3 className="mt-4 text-xl font-black text-slate-950">{skill.name}</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">{skill.description}</p>
              <div className="mt-4 rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-700">{skill.prompt_template}</div>
              <Badge variant="outline" className="mt-4 rounded-full bg-white">{skill.compatible_agent_roles}</Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
