# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file starts from the current unreleased work. Earlier history lives in the
git log — it was never recorded here, and reconstructing it after the fact would
produce a commit list rather than a changelog.

## [Unreleased]

### Added

- **One-command install.** `curl -fsSL …/install.sh | sh` puts a single binary on
  your PATH — no interpreter, no virtualenv, no package manager. The published
  SHA-256 is verified before anything is installed and a mismatch refuses rather
  than warns. Upgrading over a running `specter serve` does not disturb it.
  `git`, `gh` and the agent CLIs are deliberately not bundled; `specter status`
  now reports which are missing, what each one enables, and whether agents run
  confined.
- **Built-in workflow templates, seeded on startup.** The template gallery ships
  with Security Review Team, Pre-Push Review, and Release Readiness. Seeding is
  insert-if-missing, so an edited template survives every restart; a deleted one
  comes back on the next start. Skills seed the same way, and both backends use
  the same ids — pointed at one database, the second to start finds the library
  already there rather than inserting a duplicate set.
- ~~**Import an agentic-orchestrator repo into a workflow.**~~ **Not working in
  this release.** The scanner that reads skills and agents out of a repo lived in
  the Python host runner and was not ported when that was removed, so the import
  dialog asks for a repository's contents and gets back a parsed URL. Repo
  *discovery* (finding git repos under a root, detecting their stack) does work.
  Tracked in #44.
- **Telegram trigger.** Send a topic or draft from an allowlisted Telegram chat
  and it is delivered to the supervisor as the run's input. `/list` shows the
  available workflows; a bare `/workflow_name` asks whether to supply input or
  start with none. Step progress edits a single message in place rather than
  posting one notification per step.
- **Telegram credentials on the Users page.** A "My integrations" card shows the
  signed-in user's own bot credential with connect, rotate, and disconnect.
  Previously the only way to set one was to build a workflow and drag in a
  trigger node. Credentials are stored per user and encrypted at rest; only a
  last-four hint is ever returned to the browser.
- **Model selection.** A selector in the top bar sets the default model, and each
  workflow node can override it. The lists come from what the installed CLIs
  actually report rather than a hardcoded set.
- **Approval gates from imported skills.** A skill that requires human input
  imports as an approval gate. This can be waived per workflow, with the warning
  shown before the import runs.

### Changed

- New agent nodes default to Claude instead of Codex, in the palette, on
  imported nodes, and wherever a node carries no explicit agent.
- Returning from a run view goes back to wherever the run was started — the
  workflows list or the builder — instead of always the builder.
- Skill and workflow names must now be unique, compared case-insensitively.
  Re-importing a skill overwrites it with the latest copy; a hand-written or
  seeded skill of the same name is kept separate rather than silently replaced.

### Changed

- **State moved out of the project directory into `~/.specter`.** The run
  history, artifacts and the key that decrypts stored credentials used to live
  in the checkout, so deleting the repository deleted them. `SPECTER_HOME`
  relocates the whole directory and Docker reads the same variable, so the
  container and the CLI always resolve to one place. **Migrating an existing
  install:** stop the container, `cp -a data artifacts secrets ~/.specter/`,
  start it again — the key and the database must move together or stored
  credentials become unreadable.
- The CLI no longer picks its database from the working directory. It used to
  prefer `./data/app.db` whenever that file existed, so the same command
  answered differently depending on where it was run, and any unrelated project
  containing that path silently adopted it.

### Removed

- **The Python backend and the standalone host runner.** The Go binary serves
  every endpoint they did; nothing built or ran them. There is no longer a
  process on `localhost:8765` to start — `specter serve` spawns agents itself,
  and the launchd service supervises that same command.

### Fixed

- A fresh install could not open its own database. SQLite creates the database
  file but not the directory holding it, so a machine where nothing had already
  created `~/.specter/data` failed with `unable to open database file (14)`.
  Only Docker installs escaped it, because the bind mount created the directory
  as a side effect.
- `specter run` no longer refuses every workflow that has a trigger node. It
  required an objective on every node, but only agent nodes carry one — a
  trigger, approval gate, memory node, or webhook has nothing to ask an agent.
  The server was unaffected, so the CLI and the server disagreed about which
  graphs were valid.
- Opening a saved workflow no longer resets its name and description to a
  template's, which auto-save then persisted over the real values.
- Clicking a node during a run now shows its prompt and instructions. Previously
  nothing appeared until the run reached that step, and then only its output.
- Deleting a workflow removes its run history, logs, agent messages, memory
  entries, and approval requests. They were previously orphaned in the database
  with no way to reach them.
- Deleting a workflow asks for confirmation first.
- The builder warns before you navigate away with unsaved changes.
- Bulk edits in the builder apply to every selected node, not only sandbox ones.
- Signing in no longer falls back to a fabricated admin session when the backend
  is unreachable — the dev server now proxies `/api` correctly, and the preview
  mode that masked the failure has been removed.

### Removed

- The two seeded workflow templates ("Security Review Team" and "Claude Code
  Review"). They were the source of the fabricated defaults that overwrote saved
  workflow names.
- The welcome page. The app is a login page plus the main application.

### Security

- Integration credentials are encrypted at rest with Fernet
  (`cryptography`), keyed from `secrets/integration_secret.key` (mode 0600,
  gitignored). The database is the source of truth; the host runner holds a
  working copy only because it is the process that polls Telegram. Losing the
  key file means credentials must be re-entered — back it up alongside the
  database.
- Disconnecting a Telegram bot clears the stored credential **and** stops the
  host-side poller. Clearing only the stored record would have left the bot
  accepting messages after the UI reported it disconnected.
- Repo cloning is restricted to `github.com` and `gitlab.com` over HTTPS, always
  lands under `~/.specter/imports/` with a sanitized directory name, and runs
  with credential prompts disabled.
- Logs served over HTTP are scrubbed for tokens and other secrets before leaving
  the host runner.
