import type { AgentNodeConfig } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function AgentInspector({ agent, onChange }: { agent: AgentNodeConfig; onChange: (agent: AgentNodeConfig) => void }) {
  return (
    <div className="space-y-5 rounded-[2rem] border border-white/80 bg-white/90 p-5 shadow-sm">
      <div>
        <Badge className="mb-2 rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">Agent inspector</Badge>
        <h3 className="text-xl font-black text-slate-950">{agent.name}</h3>
        <p className="text-sm text-slate-600">Configure model, skills, tools, memory, and approval rules.</p>
      </div>

      <div className="grid gap-4">
        <div className="space-y-2">
          <Label>Agent name</Label>
          <Input className="rounded-2xl" value={agent.name} onChange={(event) => onChange({ ...agent, name: event.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>Role</Label>
          <Input className="rounded-2xl" value={agent.role} onChange={(event) => onChange({ ...agent, role: event.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>Goal / objective</Label>
          <Textarea className="min-h-20 rounded-2xl" value={agent.objective} onChange={(event) => onChange({ ...agent, objective: event.target.value })} />
        </div>
        <div className="space-y-2">
          <Label>System instructions</Label>
          <Textarea className="min-h-24 rounded-2xl" value={agent.systemInstructions} onChange={(event) => onChange({ ...agent, systemInstructions: event.target.value })} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={agent.provider} onValueChange={(provider) => onChange({ ...agent, provider })}>
              <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ollama">Ollama</SelectItem>
                <SelectItem value="openai-compatible">OpenAI-compatible</SelectItem>
                <SelectItem value="anthropic-compatible">Anthropic-compatible</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Model</Label>
            <Input className="rounded-2xl" value={agent.model} onChange={(event) => onChange({ ...agent, model: event.target.value })} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>Memory scope</Label>
          <Select value={agent.memoryScope} onValueChange={(memoryScope: AgentNodeConfig["memoryScope"]) => onChange({ ...agent, memoryScope })}>
            <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="workflow">Workflow memory</SelectItem>
              <SelectItem value="team">Team memory</SelectItem>
              <SelectItem value="agent_private">Agent-private scratchpad</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {agent.delegationStrategy && (
          <div className="space-y-2">
            <Label>Delegation strategy</Label>
            <Select value={agent.delegationStrategy} onValueChange={(delegationStrategy: AgentNodeConfig["delegationStrategy"]) => onChange({ ...agent, delegationStrategy })}>
              <SelectTrigger className="rounded-2xl"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sequential_delegation">Sequential delegation</SelectItem>
                <SelectItem value="parallel_delegation_later">Parallel delegation later</SelectItem>
                <SelectItem value="review_and_revise_later">Review-and-revise loop later</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Allowed skills</Label>
            <div className="flex flex-wrap gap-2 rounded-2xl border bg-slate-50 p-3">
              {agent.skills.map((skill) => <Badge key={skill} className="rounded-full bg-cyan-100 text-cyan-800 hover:bg-cyan-100">{skill}</Badge>)}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Allowed tools/connectors</Label>
            <div className="flex flex-wrap gap-2 rounded-2xl border bg-slate-50 p-3">
              {agent.tools.map((tool) => <Badge key={tool} className="rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">{tool}</Badge>)}
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between rounded-2xl border bg-amber-50 p-4">
          <div>
            <Label>Human approval required</Label>
            <p className="text-sm text-slate-600">Pause before final report or risky action.</p>
          </div>
          <Switch checked={agent.requiresApproval} onCheckedChange={(requiresApproval) => onChange({ ...agent, requiresApproval })} />
        </div>
      </div>
    </div>
  );
}
