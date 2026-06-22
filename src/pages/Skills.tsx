import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpenCheck,
  Plus,
  Save,
  Search,
  Trash2,
  Wrench,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { Skill } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/ui/rich-text-editor";

const templates = [
  { label: "Repository Analysis", value: "Repository Analysis", description: "Map a local repository before an agent is allowed to plan or modify work." },
  { label: "Code Review", value: "Code Review", description: "Review a branch, diff, or focused file set for production-impacting defects." },
  { label: "Security Review", value: "Security Review", description: "Assess code changes for security risks before release or privileged execution." },
  { label: "Test Failure Diagnosis", value: "Test Failure Diagnosis", description: "Investigate failing checks from logs and repository context before proposing fixes." },
  { label: "Web Quality Audit", value: "Web Quality Audit", description: "Audit frontend quality across performance, accessibility, SEO, and best practices." },
  { label: "Web App Testing", value: "Web App Testing", description: "Test local web applications with browser automation, screenshots, DOM inspection, and console logs." },
  { label: "Production PR Review", value: "Production PR Review", description: "Run a pre-landing review focused on production failures that normal tests miss." },
  { label: "Chief Security Audit", value: "Chief Security Audit", description: "Run a multi-phase security audit across code, dependencies, CI/CD, secrets, and AI trust boundaries." },
  { label: "Focused Security PR Review", value: "Focused Security PR Review", description: "Review only newly introduced security risk in a branch or PR with high-confidence false-positive filtering." },
  { label: "Codex Second Opinion", value: "Codex Second Opinion", description: "Use Codex CLI as an independent reviewer for structured diff review, adversarial challenge, or consultation." },
  { label: "Product Copy QA", value: "Product Copy QA", description: "Remove vague, generic, or AI-sounding product language from user-facing surfaces." },
  { label: "Documentation Update", value: "Documentation Update", description: "Draft precise documentation changes from repository context and accepted decisions." },
];

const promptByTemplate: Record<string, string> = {
  "Repository Analysis": "Description:\nUse this skill when a user asks Specter Agent to understand a repository, prepare an implementation plan, onboard an agent to a codebase, or validate whether a repository is ready for governed local execution.\n\nTrigger keywords:\nrepository scan, codebase map, architecture overview, entry points, onboarding, repo readiness\n\nRequired context:\n- Approved repository path\n- Requested depth of analysis\n- Any specific area of concern\n\nWorkflow:\n1. Inspect only the approved repository path.\n2. Identify application type, package managers, framework signals, service entry points, test commands, build commands, and deployment files.\n3. Read top-level docs and configuration before drawing conclusions.\n4. Build a concise map of frontend, backend, persistence, runtime, and automation surfaces.\n5. Flag missing or ambiguous setup instructions as questions, not assumptions.\n\nAllowed tools:\n- Read-only filesystem inspection\n- Read-only shell commands for listing files and reading metadata\n- Git status and diff inspection\n\nGuardrails:\n- Do not modify files.\n- Do not scan outside the approved repository.\n- Do not infer secrets or print sensitive values.\n- Do not run dependency installs, tests, or network commands unless separately approved.\n\nOutput:\n- Repository summary\n- Main entry points\n- Build/test/runtime commands found\n- Risk notes\n- Recommended next actions",
  "Code Review": "Description:\nUse this skill when reviewing a branch, diff, pull request, or focused set of files for production-impacting issues before work is merged or released.\n\nTrigger keywords:\ncode review, review diff, review branch, regression risk, pre-merge review\n\nRequired context:\n- Approved repository path\n- Diff, branch, PR, or file scope\n- Intended behavior or acceptance criteria\n\nWorkflow:\n1. Confirm the review scope and current git state.\n2. Inspect the changed files and nearby contracts they rely on.\n3. Prioritize defects that can break runtime behavior, data integrity, auth, permissions, or user workflows.\n4. Check whether tests or verification steps cover the changed behavior.\n5. Separate blocking findings from non-blocking cleanup suggestions.\n\nAllowed tools:\n- Read-only filesystem inspection\n- Git diff/status/log commands\n- Existing test output provided by the user or runtime logs\n\nGuardrails:\n- Do not rewrite code during review mode.\n- Do not report style-only issues as blockers.\n- Do not speculate; every finding must cite evidence.\n- Do not expose secrets discovered in files or logs.\n\nOutput:\n- Findings ordered by severity\n- File references and impact\n- Missing tests or verification gaps\n- Open questions\n- Short approval or block recommendation",
  "Security Review": "Description:\nUse this skill when a change touches authentication, authorization, secrets, command execution, filesystem access, external writes, workflow approvals, or agent runtime permissions.\n\nTrigger keywords:\nsecurity review, auth check, permission check, secret exposure, command execution, release gate\n\nRequired context:\n- Approved repository path\n- Change scope or release branch\n- Security-sensitive areas to prioritize\n\nWorkflow:\n1. Identify trust boundaries, authenticated actors, privileged actions, and data stores touched by the change.\n2. Review backend routes for missing user or admin checks.\n3. Inspect filesystem, subprocess, network, and agent execution paths for allowlists and approval gates.\n4. Check logs, examples, and docs for leaked credentials or unsafe operational guidance.\n5. Classify findings by severity and stop on high or critical unacknowledged risk.\n\nAllowed tools:\n- Read-only filesystem inspection\n- Git diff/status commands\n- Static review of code and configuration\n\nGuardrails:\n- Never reveal full secret values.\n- Do not weaken controls to make a workflow pass.\n- Do not approve write/destructive paths without explicit approval gates.\n- Treat command execution and filesystem traversal as high-risk until constrained.\n\nOutput:\n- Threat surface summary\n- Findings by severity\n- Required fixes before release\n- Residual risks\n- Approval recommendation",
  "Test Failure Diagnosis": "Description:\nUse this skill when a build, lint, typecheck, unit test, integration test, or container smoke test fails and the user needs a root-cause diagnosis before changes are made.\n\nTrigger keywords:\ntest failed, build failed, CI failed, lint error, type error, container failed, smoke test\n\nRequired context:\n- Failing command\n- Error output or logs\n- Approved repository path\n- Recent code changes if available\n\nWorkflow:\n1. Read the exact failure output before inspecting unrelated files.\n2. Identify the first meaningful error and distinguish it from cascading failures.\n3. Inspect only the files, config, and dependencies relevant to the failure.\n4. Form a root-cause hypothesis and list the evidence supporting it.\n5. Propose the smallest safe fix and the verification command to rerun.\n\nAllowed tools:\n- Read-only log inspection\n- Read-only filesystem inspection\n- Existing build/test commands only when the user approves execution\n\nGuardrails:\n- Do not make code changes in diagnosis mode.\n- Do not run destructive cleanup commands.\n- Do not hide flaky or environment-related uncertainty.\n- Do not broaden scope into unrelated refactors.\n\nOutput:\n- Failing command and key error\n- Likely root cause\n- Affected files\n- Minimal fix plan\n- Verification command",
  "Web Quality Audit": "Description:\nUse this skill when reviewing a local web app, landing page, dashboard, or workflow for user-facing quality before release. Inspired by Lighthouse-style audit categories: performance, accessibility, SEO, and best practices.\n\nTrigger keywords:\nweb quality, Lighthouse, accessibility, SEO, Core Web Vitals, frontend audit, page quality\n\nRequired context:\n- Approved repository path\n- Local URL or route to inspect\n- Browser viewport or device target when relevant\n- Whether the audit is report-only or fix-authorized\n\nWorkflow:\n1. Confirm the route, audience, and release risk.\n2. Inspect the page manually and, when approved, with browser tooling.\n3. Evaluate performance signals, layout stability, keyboard navigation, contrast, semantic structure, metadata, and broken states.\n4. Prioritize findings by user impact and release risk.\n5. Recommend code-level fixes with file references when possible.\n\nAllowed tools:\n- Read-only repository inspection\n- Browser inspection and screenshots when approved\n- Build output and existing local app health checks\n\nGuardrails:\n- Do not rely only on automated scores.\n- Do not introduce decorative motion or visual clutter while fixing quality issues.\n- Do not claim WCAG or SEO compliance unless verified.\n- Do not run external crawlers or network audits without approval.\n\nOutput:\n- Route audited\n- Findings by category and severity\n- Evidence or screenshot notes\n- File-level remediation plan\n- Release recommendation",
  "Web App Testing": "Description:\nUse this skill when Specter Agent needs to verify a local web application by driving a real browser against a running frontend or full-stack app.\n\nTrigger keywords:\nweb app test, browser test, Playwright, screenshot, console logs, click through, form validation, DOM inspection\n\nRequired context:\n- Approved repository path\n- Local URL or command to start the app\n- Target route or user workflow\n- Expected behavior or acceptance criteria\n- Whether the task is report-only or fix-authorized\n\nWorkflow:\n1. Determine whether the app is static HTML or a dynamic app.\n2. If the app is not already running, identify the frontend/backend server commands and ports before starting anything.\n3. Wait for the app to be reachable and for JavaScript hydration to complete before inspecting the DOM.\n4. Take an initial screenshot and inspect rendered buttons, links, inputs, headings, and visible errors.\n5. Choose selectors from rendered state, then perform the requested clicks, typing, navigation, or assertions.\n6. Capture browser console errors, failed network requests, screenshots, and reproduction steps.\n7. If fix-authorized, make the smallest targeted change and rerun the browser check.\n\nAllowed tools:\n- Browser automation against localhost or approved local URLs\n- Screenshots and DOM inspection\n- Browser console and network logs\n- Approved local dev server commands\n- Read-only repository inspection\n\nGuardrails:\n- Do not browse unrelated external sites.\n- Do not submit real credentials, payments, or destructive actions.\n- Do not inspect dynamic app DOM before hydration has completed.\n- Do not leave dev servers running unless the user asked for that.\n- Do not claim UI is fixed without a screenshot or concrete browser evidence.\n\nOutput:\n- Route/workflow tested\n- Browser evidence captured\n- Console/network issues\n- Reproduction steps\n- Fix recommendation or patch summary\n- Remaining risk",
  "Production PR Review": "Description:\nUse this skill before merging or shipping a branch when the risk is not simply whether tests pass, but whether the change can fail in production. Inspired by pre-landing engineering review workflows that inspect structural risks and scope drift.\n\nTrigger keywords:\nproduction review, pre-landing review, ship review, merge risk, branch risk, scope drift\n\nRequired context:\n- Approved repository path\n- Base branch and current branch or diff\n- Intended scope of the change\n- Relevant issue, plan, or acceptance criteria\n\nWorkflow:\n1. Establish the diff base and summarize changed files.\n2. Compare the diff against the stated scope and flag scope drift.\n3. Inspect trust boundaries, data writes, race conditions, enum/state completeness, error handling, and migration safety.\n4. Check whether tests, docs, and operational paths changed together.\n5. Classify each finding as blocking, investigate, or non-blocking.\n\nAllowed tools:\n- Read-only git diff/status/log commands\n- Read-only filesystem inspection\n- Existing test reports and build logs\n\nGuardrails:\n- Do not auto-fix in review mode.\n- Do not treat passing CI as sufficient evidence of safety.\n- Do not ignore small diffs touching auth, persistence, command execution, or agent runtime boundaries.\n- Do not approve release if a high-risk finding is unacknowledged.\n\nOutput:\n- Scope summary\n- Blocking findings\n- Investigation items\n- Missing verification\n- Ship, hold, or proceed-with-acknowledgement recommendation",
  "Chief Security Audit": "Description:\nUse this skill when the user needs a broad security posture audit across an approved repository before release, external exposure, compliance review, or privileged agent execution.\n\nTrigger keywords:\nCSO audit, security audit, threat model, OWASP, STRIDE, secrets scan, CI security, AI security\n\nRequired context:\n- Approved repository path\n- Audit mode: daily signal or comprehensive sweep\n- Release/compliance target if any\n- Areas that are explicitly out of scope\n\nWorkflow:\n1. Establish the repository boundary and audit mode.\n2. Review secrets exposure risks in committed files, examples, logs, and configuration. Do not print secret values.\n3. Inspect dependency and supply-chain posture: lockfiles, package scripts, unpinned actions, install hooks, and known risky patterns.\n4. Review CI/CD and deployment paths for unsafe triggers, privileged tokens, unpinned third-party actions, and missing approval gates.\n5. Trace authentication, authorization, webhook, file upload, command execution, and external write paths.\n6. For AI features, map user input paths to prompts, tools, memory, filesystem access, and model outputs that become trusted data.\n7. Build a STRIDE-style threat surface summary and prioritize findings by exploitability and business impact.\n\nAllowed tools:\n- Read-only repository inspection\n- Read-only git history and diff inspection when approved\n- Static dependency and workflow review\n- Existing security/test reports supplied by the user\n\nGuardrails:\n- Never reveal full credentials, tokens, keys, or session material.\n- Do not run network scanners, exploit tools, or destructive tests.\n- Do not expand attack payloads beyond what is needed to explain risk.\n- Treat agent tool execution, filesystem traversal, and prompt-to-action paths as privileged boundaries.\n- Stop on high or critical findings until acknowledged.\n\nOutput:\n- Audit mode and scope\n- Threat surface map\n- Findings by severity with evidence\n- Exploit scenario in plain language\n- Required remediation\n- Residual risk and release recommendation",
  "Focused Security PR Review": "Description:\nUse this skill when reviewing pending branch or PR changes for newly introduced, high-confidence security vulnerabilities. This is not a general code review and should not report pre-existing issues outside the diff.\n\nTrigger keywords:\nsecurity PR review, secure diff review, branch security, high-confidence vulnerability, false-positive filter\n\nRequired context:\n- Approved repository path\n- Base branch or PR diff\n- Changed files list\n- Security-sensitive areas to prioritize\n- Whether findings should be advisory or release-gating\n\nWorkflow:\n1. Collect repository status, changed files, commits, and the diff against the base branch.\n2. Research repository security context: frameworks, auth model, validation patterns, sanitization helpers, permission checks, and data boundaries.\n3. Compare new code against established secure patterns in the repository.\n4. Analyze only security implications introduced by the current diff.\n5. Trace data flow from untrusted input to sensitive operations such as database queries, subprocess calls, filesystem paths, templates, deserialization, auth decisions, and external writes.\n6. Filter aggressively for false positives. Report only findings with a concrete exploit path and confidence of 8/10 or higher.\n7. Produce structured findings and a short summary. If no findings meet the threshold, say so clearly.\n\nSecurity categories:\n- Injection: SQL, command, template, NoSQL, XML/XXE, path traversal\n- Authentication and authorization: bypass, privilege escalation, IDOR, session flaws\n- Data exposure: secret or PII logging, debug leakage, unintended API exposure\n- Crypto: weak randomness, broken verification, unsafe certificate handling\n- Code execution: unsafe eval, deserialization, dynamic imports, unsafe YAML/pickle patterns\n- Configuration: permissive CORS, insecure headers, dangerous defaults, unsafe CI triggers\n- AI/agent boundaries: user input reaching privileged prompts, tool calls, filesystem access, memory, or trusted outputs without control\n\nFalse-positive exclusions:\n- Do not report style issues, generic hardening advice, or theoretical best practices.\n- Do not report denial-of-service, rate limiting, or resource exhaustion unless the project explicitly asks for availability review.\n- Do not report client-side missing auth checks as vulnerabilities; backend enforcement is what matters.\n- Do not report documentation-only issues.\n- Do not report dependency CVEs unless the diff introduces a clearly exploitable dependency risk.\n- Do not report React or Angular XSS unless unsafe HTML APIs are used.\n- Do not report shell script command injection unless untrusted input reaches the shell in a concrete path.\n\nAllowed tools:\n- Read-only git status, log, show, and diff commands\n- Read-only repository inspection\n- Existing security configuration and tests\n- Runtime evidence supplied by Specter or the user\n\nGuardrails:\n- Do not modify code during review mode.\n- Do not print secret values.\n- Do not broaden into a full audit unless requested.\n- Do not flood the user with low-confidence findings.\n- Treat local-network exploitability as real if it crosses trust boundaries.\n\nOutput:\nMarkdown or JSON findings with:\n- file and line\n- severity\n- category\n- confidence score\n- description\n- exploit scenario\n- recommendation\n- summary counts\n- release recommendation",
  "Codex Second Opinion": "Description:\nUse this skill when Specter Agent should ask a host-side Codex CLI session for an independent review, adversarial challenge, or open-ended engineering consultation while keeping credentials on the host machine.\n\nTrigger keywords:\nCodex review, second opinion, adversarial review, ask Codex, cross-model review, independent reviewer\n\nRequired context:\n- Approved repository path\n- Mode: structured diff review, adversarial challenge, or consultation\n- Diff/base branch, plan file, or question\n- Whether the result is advisory or release-gating\n\nWorkflow:\n1. Verify Codex CLI runtime is ready and the repository is approved.\n2. Select the narrowest useful mode:\n   - Structured diff review: classify findings and produce a pass/fail recommendation.\n   - Adversarial challenge: search for edge cases, bypasses, and failure paths.\n   - Consultation: answer a focused architecture or implementation question.\n3. Run Codex in read-only mode unless a separate approval grants write access.\n4. Capture stdout, stderr, exit status, final answer, and runtime logs as evidence.\n5. Compare Codex findings against Specter or human findings and call out disagreements.\n\nAllowed tools:\n- Codex CLI through Specter Host Runner\n- Read-only filesystem access inside approved repository\n- Read-only git diff/status commands\n- Runtime logs and stored run evidence\n\nGuardrails:\n- Do not pass secrets or private credentials into prompts.\n- Do not let Codex read outside approved repository paths.\n- Do not treat a clean Codex result as proof of safety.\n- Do not auto-apply Codex suggestions without explicit write approval.\n- Preserve the raw Codex evidence for auditability.\n\nOutput:\n- Mode selected and reason\n- Codex result summary\n- Findings or advice\n- Agreement/disagreement with existing review\n- Evidence captured\n- Recommended next action",
  "Product Copy QA": "Description:\nUse this skill when reviewing user-facing text in the product, docs, setup flows, empty states, or marketing-style surfaces. It removes vague, generic, or AI-sounding language and replaces it with specific, useful wording.\n\nTrigger keywords:\ncopy review, product wording, generic language, enterprise wording, empty state copy, user-facing text\n\nRequired context:\n- Target screen, document, or component\n- Intended audience\n- Product name and approved terminology\n- Whether edits are allowed or report-only\n\nWorkflow:\n1. Identify the user-facing text and its job in the workflow.\n2. Remove vague claims, filler adjectives, implementation leakage, and unsupported promises.\n3. Replace generic wording with precise action-oriented text.\n4. Preserve product terminology and compliance-sensitive wording.\n5. Return a concise before/after table or patch.\n\nAllowed tools:\n- Read-only repository inspection\n- Targeted file edits when explicitly approved\n- Existing product terminology from local docs\n\nGuardrails:\n- Do not invent capabilities.\n- Do not expose internal implementation details in user-facing copy.\n- Do not use hype, vague enterprise buzzwords, or AI-sounding filler.\n- Do not change legal, compliance, or attribution text unless explicitly requested.\n\nOutput:\n- Copy issues found\n- Recommended replacements\n- Files or components affected\n- Open terminology questions",
  "Documentation Update": "Description:\nUse this skill when creating or updating project documentation from verified repository behavior, accepted design decisions, or completed implementation work.\n\nTrigger keywords:\nupdate docs, write README, document workflow, release notes, architecture notes, runbook\n\nRequired context:\n- Target document or documentation area\n- Source behavior to document\n- Audience: operator, developer, admin, or end user\n\nWorkflow:\n1. Read the existing document and nearby conventions.\n2. Verify claims against code, commands, or runtime behavior where possible.\n3. Update only the relevant section unless a broader restructure is requested.\n4. Use product terminology consistently.\n5. Include commands, paths, and operational notes only when they are user-facing and necessary.\n\nAllowed tools:\n- Read-only repository inspection\n- Targeted file edits after approval or explicit user request\n- Build or doc validation commands when available\n\nGuardrails:\n- Do not add internal debug notes to user-facing docs.\n- Do not mention implementation defaults unless they affect user decisions.\n- Do not invent unsupported product capabilities.\n- Do not remove attribution or compliance notes unless explicitly requested.\n\nOutput:\n- Updated documentation draft or patch\n- Verification performed\n- Any unresolved assumptions",
};

const builtInSkills: Skill[] = [
  {
    id: "repository-analysis",
    name: "Repository Analysis",
    description: "Map a local repository before an agent is allowed to plan or modify work.",
    prompt_template: promptByTemplate["Repository Analysis"],
    compatible_agent_roles: "read-only, local repositories",
    created_at: new Date().toISOString(),
  },
  {
    id: "code-review",
    name: "Code Review",
    description: "Review a branch, diff, or focused file set for production-impacting defects.",
    prompt_template: promptByTemplate["Code Review"],
    compatible_agent_roles: "read-only, approval-required write",
    created_at: new Date().toISOString(),
  },
  {
    id: "security-review",
    name: "Security Review",
    description: "Assess code changes for security risks before release or privileged execution.",
    prompt_template: promptByTemplate["Security Review"],
    compatible_agent_roles: "read-only, security gate",
    created_at: new Date().toISOString(),
  },
  {
    id: "test-diagnosis",
    name: "Test Failure Diagnosis",
    description: "Investigate failing checks from logs and repository context before proposing fixes.",
    prompt_template: promptByTemplate["Test Failure Diagnosis"],
    compatible_agent_roles: "read-only, local repositories",
    created_at: new Date().toISOString(),
  },
  {
    id: "web-quality-audit",
    name: "Web Quality Audit",
    description: "Audit frontend quality across performance, accessibility, SEO, and best practices.",
    prompt_template: promptByTemplate["Web Quality Audit"],
    compatible_agent_roles: "read-only, browser-assisted",
    created_at: new Date().toISOString(),
  },
  {
    id: "web-app-testing",
    name: "Web App Testing",
    description: "Test local web applications with browser automation, screenshots, DOM inspection, and console logs.",
    prompt_template: promptByTemplate["Web App Testing"],
    compatible_agent_roles: "read-only, browser-assisted",
    created_at: new Date().toISOString(),
  },
  {
    id: "production-pr-review",
    name: "Production PR Review",
    description: "Run a pre-landing review focused on production failures that normal tests miss.",
    prompt_template: promptByTemplate["Production PR Review"],
    compatible_agent_roles: "read-only, release gate",
    created_at: new Date().toISOString(),
  },
  {
    id: "product-copy-qa",
    name: "Product Copy QA",
    description: "Remove vague, generic, or AI-sounding product language from user-facing surfaces.",
    prompt_template: promptByTemplate["Product Copy QA"],
    compatible_agent_roles: "read-only, user-facing copy",
    created_at: new Date().toISOString(),
  },
  {
    id: "chief-security-audit",
    name: "Chief Security Audit",
    description: "Run a multi-phase security audit across code, dependencies, CI/CD, secrets, and AI trust boundaries.",
    prompt_template: promptByTemplate["Chief Security Audit"],
    compatible_agent_roles: "read-only, security gate",
    created_at: new Date().toISOString(),
  },
  {
    id: "focused-security-pr-review",
    name: "Focused Security PR Review",
    description: "Review only newly introduced security risk in a branch or PR with high-confidence false-positive filtering.",
    prompt_template: promptByTemplate["Focused Security PR Review"],
    compatible_agent_roles: "read-only, security gate",
    created_at: new Date().toISOString(),
  },
  {
    id: "codex-second-opinion",
    name: "Codex Second Opinion",
    description: "Use Codex CLI as an independent reviewer for diff review, adversarial challenge, or consultation.",
    prompt_template: promptByTemplate["Codex Second Opinion"],
    compatible_agent_roles: "read-only, cross-model review",
    created_at: new Date().toISOString(),
  },
];

type SkillDraft = {
  name: string;
  description: string;
  promptTemplate: string;
};

function parseMetadata(value: string) {
  return value
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .split(",")
    .map((part) => part.replace(/['"]/g, "").trim())
    .filter(Boolean);
}

function draftFromSkill(skill: Skill): SkillDraft {
  return {
    name: skill.name,
    description: skill.description,
    promptTemplate: skill.prompt_template,
  };
}

function metadataFromDraft(_draft: SkillDraft) {
  return [];
}

export default function Skills() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [selectedSkillId, setSelectedSkillId] = useState(builtInSkills[0].id);
  const [draft, setDraft] = useState<SkillDraft>(() => draftFromSkill(builtInSkills[0]));
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");

  const canUseBackend = Boolean(token && token !== "preview-mode");
  const { data = [] } = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });
  const savedSkills = data;
  const editableSkills = useMemo(() => {
    const savedSkillNames = new Set(savedSkills.map((skill) => skill.name));
    return [
      ...savedSkills,
      ...builtInSkills.filter((skill) => !savedSkillNames.has(skill.name)),
    ];
  }, [savedSkills]);
  const selectedSkill = useMemo(
    () => editableSkills.find((skill) => skill.id === selectedSkillId) ?? editableSkills[0] ?? builtInSkills[0],
    [editableSkills, selectedSkillId],
  );
  const selectedSaved = savedSkills.some((skill) => skill.id === selectedSkill?.id);
  const filteredSkills = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return editableSkills;
    return editableSkills.filter((skill) =>
      [skill.name, skill.description, skill.compatible_agent_roles].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }, [editableSkills, search]);
  const activeSkills = data.length;

  useEffect(() => {
    if (!selectedSkill) return;
    setSelectedSkillId(selectedSkill.id);
    setDraft(draftFromSkill(selectedSkill));
  }, [selectedSkill]);

  const create = useMutation({
    mutationFn: (nextDraft: SkillDraft) =>
      api.createSkill(token ?? "", {
        name: nextDraft.name,
        description: nextDraft.description,
        prompt_template: nextDraft.promptTemplate,
        compatible_agent_roles: metadataFromDraft(nextDraft),
      }),
    onSuccess: (skill) => {
      setError("");
      setSelectedSkillId(skill.id);
      setDraft(draftFromSkill(skill));
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to save skill"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteSkill(token ?? "", id),
    onSuccess: () => {
      setSelectedSkillId(builtInSkills[0].id);
      setDraft(draftFromSkill(builtInSkills[0]));
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
  const update = useMutation({
    mutationFn: (payload: { id: string; draft: SkillDraft }) =>
      api.updateSkill(token ?? "", payload.id, {
        name: payload.draft.name,
        description: payload.draft.description,
        prompt_template: payload.draft.promptTemplate,
        compatible_agent_roles: metadataFromDraft(payload.draft),
    }),
    onSuccess: () => {
      setError("");
      queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to update skill"),
  });

  const selectSkill = (skill: Skill) => {
    setError("");
    setSelectedSkillId(skill.id);
    setDraft(draftFromSkill(skill));
  };

  const applyTemplate = (templateName: string) => {
    const templateSkill = editableSkills.find((skill) => skill.name === templateName);
    if (templateSkill) {
      selectSkill(templateSkill);
      return;
    }
    const template = templates.find((item) => item.value === templateName);
    if (!template) return;
    setError("");
    setSelectedSkillId(`draft-${template.value}`);
    setDraft({
      name: template.label,
      description: template.description,
      promptTemplate: promptByTemplate[template.value],
    });
  };

  const saveSelectedSkill = () => {
    setError("");
    if (selectedSaved && selectedSkill) {
      update.mutate({ id: selectedSkill.id, draft });
      return;
    }
    create.mutate(draft);
  };

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-100">
            <Wrench className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Skills</h1>
            <p className="text-sm text-slate-500">Configure reusable instructions for governed local agent work</p>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="rounded-2xl">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid min-h-[720px] gap-4 xl:grid-cols-[320px_minmax(0,1fr)]">
        {/* left panel — skill library */}
        <Card className="rounded-2xl border-slate-200 shadow-none">
          <CardContent className="flex h-full flex-col p-0">
            {/* library header */}
            <div className="flex items-center gap-2.5 border-b border-slate-100 px-4 py-3.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-xl bg-indigo-50">
                <BookOpenCheck className="h-3.5 w-3.5 text-indigo-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-800">Skill library</p>
                <p className="text-[11px] text-slate-400">{savedSkills.length} saved · {builtInSkills.length - savedSkills.length > 0 ? builtInSkills.length - savedSkills.length : builtInSkills.length} templates</p>
              </div>
            </div>

            {/* search */}
            <div className="border-b border-slate-100 px-3 py-3">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search skills"
                  className="h-8 rounded-xl bg-slate-50 pl-8 text-xs border-slate-200"
                />
              </div>
            </div>

            {!canUseBackend && (
              <div className="mx-3 mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
                <p className="text-xs font-semibold text-amber-900">Backend session required to save changes.</p>
              </div>
            )}

            {/* skill list */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SkillList skills={filteredSkills} savedSkills={savedSkills} selectedSkillId={selectedSkillId} onSelect={selectSkill} />
            </div>
          </CardContent>
        </Card>

        {/* right panel — editor */}
        <Card className="rounded-2xl border-slate-200 shadow-none">
          <CardContent className="p-0">
            {/* editor header */}
            <div className="border-b border-slate-100 px-5 py-4">
              {/* top row: action buttons */}
              <div className="flex items-center justify-end gap-4">
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 rounded-xl px-3 text-sm"
                    onClick={() => applyTemplate("Repository Analysis")}
                  >
                    <Plus className="mr-1.5 h-3.5 w-3.5" />
                    New
                  </Button>
                  {selectedSaved && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(selectedSkill.id)}
                      className="h-9 w-9 rounded-xl border-red-200 text-red-600 hover:bg-red-50"
                      aria-label="Delete skill"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    disabled={create.isPending || update.isPending || !canUseBackend}
                    onClick={saveSelectedSkill}
                    className="h-9 rounded-xl bg-indigo-600 px-3 text-sm hover:bg-indigo-700"
                  >
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                    {create.isPending || update.isPending ? "Saving…" : selectedSaved ? "Save changes" : "Save skill"}
                  </Button>
                </div>
              </div>
              {/* title + description below */}
              <h2 className="mt-3 text-xl font-bold text-slate-900">{draft.name || "Untitled skill"}</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
                {draft.description || "Add a description that makes the skill easy to choose."}
              </p>
            </div>

            {!canUseBackend && (
              <Alert className="m-5 rounded-2xl border-amber-200 bg-amber-50">
                <AlertDescription className="text-sm text-amber-900">
                  Saving is disabled until the backend session is available.
                </AlertDescription>
              </Alert>
            )}

            <div className="p-5">
              <SkillEditor draft={draft} onChange={setDraft} />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SkillBtn({ skill, selected, onSelect }: { skill: Skill; selected: boolean; onSelect: (s: Skill) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(skill)}
      className={`w-full rounded-xl px-3 py-2.5 text-left transition-colors ${
        selected ? "bg-indigo-50" : "hover:bg-slate-50"
      }`}
    >
      <p className={`truncate text-sm font-semibold ${selected ? "text-indigo-800" : "text-slate-800"}`}>{skill.name}</p>
      <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-slate-400">
        {skill.description || "No description provided."}
      </p>
    </button>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{label}</p>
  );
}

function SkillList({ skills, savedSkills, selectedSkillId, onSelect }: {
  skills: Skill[];
  savedSkills: Skill[];
  selectedSkillId: string;
  onSelect: (s: Skill) => void;
}) {
  const savedSet = new Set(savedSkills.map((s) => s.id));
  const saved = skills.filter((s) => savedSet.has(s.id));
  const templates = skills.filter((s) => !savedSet.has(s.id));
  const noResults = skills.length === 0;

  return (
    <div className="p-2">
      {noResults && <p className="p-3 text-xs text-slate-400">No skills match the current search.</p>}
      {saved.length > 0 && (
        <>
          <SectionHeader label="Your skills" />
          <div className="space-y-0.5">
            {saved.map((s) => <SkillBtn key={s.id} skill={s} selected={s.id === selectedSkillId} onSelect={onSelect} />)}
          </div>
        </>
      )}
      {templates.length > 0 && (
        <>
          {saved.length > 0 && <div className="my-2 border-t border-slate-100" />}
          <SectionHeader label="Templates" />
          <div className="space-y-0.5">
            {templates.map((s) => <SkillBtn key={s.id} skill={s} selected={s.id === selectedSkillId} onSelect={onSelect} />)}
          </div>
        </>
      )}
    </div>
  );
}

function SkillEditor({ draft, onChange }: { draft: SkillDraft; onChange: (draft: SkillDraft) => void }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold uppercase tracking-widest text-slate-400">Name</Label>
          <Input className="h-9 rounded-xl text-sm" value={draft.name} onChange={(event) => onChange({ ...draft, name: event.target.value })} required />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs font-semibold uppercase tracking-widest text-slate-400">Description</Label>
          <Input className="h-9 rounded-xl text-sm" value={draft.description} onChange={(event) => onChange({ ...draft, description: event.target.value })} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs font-semibold uppercase tracking-widest text-slate-400">Skill instructions</Label>
        <RichTextEditor
          value={draft.promptTemplate}
          onChange={(md) => onChange({ ...draft, promptTemplate: md })}
          placeholder="Write skill instructions using headings, lists, and code blocks…"
          minHeight="430px"
        />
      </div>
    </div>
  );
}

