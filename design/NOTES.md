# Design parity notes

Accumulated across `/claude-design-pull` runs. Read this before re-deriving
anything — every line here cost a run to learn.

## Source projects

| Project | UUID | Holds |
|---|---|---|
| Specter — Workflow Builder redesign | `dc11c32c-c3b1-49f0-af2d-ff469bbc4e15` | the per-page mockups |
| Specter — visual direction options | `f295db8e-0fae-424a-b052-9291148fcf5b` | the three directions; C is the chosen one |

`direction-c.html` is pulled from the second project as `c-workflow-native.html`.
It is the source of `src/styles/mockup.css` — re-copy its `<style>` block wholesale
rather than retyping when it changes.

## Pulling

`mcp__claude-design__read_file` returns the body HTML-entity-escaped inside an
`<untrusted-project-content>` wrapper. Decode `&lt;` `&gt;` `&amp;` **in that
order** — decoding `&amp;` first double-decodes everything else.

Do not transcribe mockups through a model's context. Write the escaped body to a
scratch file and decode it with a script. Hand-transcription is what produced the
drift this gate exists to catch.

Some files legitimately keep a single `&amp;` after decoding (`Users &amp; roles`)
— those were `&amp;amp;` on the wire. That is correct, not a decode failure.

## Route map (mockup → live)

| Page | Mockup | Live route |
|---|---|---|
| Workflows | `workflows.html` | `/workflows` |
| Skills | `skills.html` | `/skills` |
| Models | `models.html` | `/settings/models` |
| Users | `users.html` | `/settings/users` |
| Dashboard | `dashboard.html` | `/dashboard` |

Note `/settings/models` and `/settings/users`, not `/models` / `/users`.

## Measuring

- The app is served on **:8080**, not :5173. The README's documented dev command
  is wrong on both the port and the `VITE_API_BASE_URL` override — passing that
  override makes the browser bypass the proxy and every request fails CORS.
- Every page except login is behind auth. A login wall extracts as a page with
  none of the expected elements, which reports as dozens of spurious structural
  failures. Sign in before extracting.
- The live pages use `sp-`-prefixed classes mirroring the mockups' short names
  (`.chipf` → `.sp-chip`, `.st` → `.sp-st`, `.grp` → `.sp-grp`). The manifest
  carries that mapping.

## Known aspirational selectors

These are in the manifest but not yet in the app — the gate is *supposed* to
block on them until the pages are built:

- `.sp-chain-lk` — the Models dependency-chain strip
- `.sp-badge` — role badges on Users

## Safety

`/settings/users` has Delete-user, Disconnect-integration and Reset-password
controls. Measurement is read-only — never exercise them. A previous session
destroyed a live Telegram credential by testing a disconnect flow.

## Drift meter

| Date | Hardcoded colour literals | Files |
|---|---|---|
| (when the skill was written) | 915 | — |
| 2026-08-01 | 1037 | 31 of 103 |

Concentrated in `WorkflowRun.tsx` (234), `Workflows.tsx` (190),
`WorkflowBuilder.tsx` (124). Not a gate — but the number is going the wrong way.
