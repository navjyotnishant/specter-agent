# Design reference

Approved mockups pulled from Claude Design, kept in the repo so the UI can be
diffed against them without re-fetching or working from memory.

- **Direction:** workflow-tool native (option C) — light, node-forward, icon
  tiles, visible connection ports, per-node run output on the card, docked
  execution panel. The graph carries execution state.
- **Stylesheet:** `src/styles/mockup.css` is copied from these files. When a
  mockup changes, re-copy its `<style>` block rather than retyping values —
  every hand-transcription so far drifted a pixel or two per element.

## Files

| File | Page | Status |
|---|---|---|
| `mockups/builder.html` | Workflow Builder | matched |
| `mockups/workflows.html` | Workflows list | matched (9/9 structural) |
| `mockups/skills.html` | Skills | classes matched; structure partly verified |
| `mockups/dashboard.html` | Dashboard | metrics rebuilt; layout not compared |
| `mockups/models.html` | Models → Runtimes / Access / Console | **not built — still one page** |
| `mockups/users.html` | Users | radii/colour only |
| `mockups/direction-c.html` | The chosen visual direction | source of `mockup.css` |

## How to compare a page against its mockup

Render the mockup and the live page in a browser, dump computed styles from
both, and diff. Reading the markup alone misses things — the `--radius: 1.25rem`
token made every "rounded" control pill-shaped, and no amount of source reading
would have shown it.

Source project: `dc11c32c-c3b1-49f0-af2d-ff469bbc4e15` on claude.ai/design.
