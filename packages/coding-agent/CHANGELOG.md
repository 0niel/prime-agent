# Changelog

## [Unreleased]

### Added

- Added a `max` thinking level to the thinking selector, `--thinking` flag, and settings, exposing the top reasoning effort on Claude models that support it (e.g. Opus 4.6+/Sonnet 4.6).
- Added opt-in Prime Agent trace sharing with `/traces` and background uploads of persisted session JSONL files.
- Added a first draft of daemon-backed cron jobs for scheduling prompts against long-running sessions without using `/goal`.

## [0.1.3] - 2026-06-12

### Added

- Added a `/context` command showing a tree overview of the main agent and all sub-agents with per-agent tokens, cost, and context-window usage, plus session totals and a token/cost breakdown.
- Added `/clear` as an alias for `/new`.

### Changed

- Changed `/usage` to be an alias for the new `/context` command.

### Fixed

- Fixed the stale "no models available" warning appearing for sessions that already have a working model.
- Fixed the `!` and `!!` bash shortcuts in interactive mode by running bash through the agent connection, restoring streaming output, history, and Ctrl+C abort for both in-process and daemon-attached clients.

## [0.1.2] - 2026-06-12

### Fixed

- Fixed the model selector showing no models after logging in with Prime Inference during onboarding by reloading auth storage from disk when the model registry refreshes ([#151](https://github.com/PrimeIntellect-ai/prime-agent/issues/151)).

## [0.1.1] - 2026-06-11

### Fixed

- Fixed first launch to run onboarding before opening the Agents View ([#147](https://github.com/PrimeIntellect-ai/prime-agent/issues/147)).
- Fixed multiline status errors in Agents View to render as a single flattened line so they cannot overlap the input ([#146](https://github.com/PrimeIntellect-ai/prime-agent/issues/146)).
- Fixed slash commands in the main Agents View ([#149](https://github.com/PrimeIntellect-ai/prime-agent/issues/149)).

## [0.1.0] - 2026-06-11

### Breaking Changes

- Changed `InteractiveMode` construction to require an `AgentConnection` and explicit UI services or local session host.

### Added

- Added a two-step `Ctrl+X` stop/delete interaction for selected agents in Agents View.
- Added a daemon-backed Agents View as the default local interactive entrypoint.
- Added versioned daemon protocol metadata, sequenced session events, attach snapshots, replay status, and artifact references for future Swarm gateway wrapping.
- Added an `AgentConnection` client boundary with in-process and daemon adapters for interactive-mode decoupling.
- Added daemon mode and CLI controls for starting on demand, creating, listing, attaching, detaching, killing, renaming, and prompting live sessions.
- Added rich TUI attach for already-active daemon sessions via `--session <selector>` and live `daemon <selector>` shorthand.
- Added a built-in `skill-creator` skill that teaches the agent to create new skills: markdown layout, frontmatter rules, placement and precedence, and the Python-backed skill contract (package layout, `run()` convention, optional CLI, kernel venv behavior) with a test-verified working template.
- Added built-in skills shipped with prime-agent, starting with `prime-intellect`: ecosystem knowledge and prime CLI workflows for verifiers environments, evaluations, Hosted Training, sandboxes, inference, and compute. Built-in skills have the lowest precedence (user, project, and package skills with the same name win) and can be disabled with the `enableBuiltinSkills` setting or `--no-skills`.
- Added a session-backed `rlm.harness` state helper for reset-free prompt notes, memory, skills, subagent specs, and refinement events.
- Added `/refine` to update editable harness state with Create/Update/Delete edits and rollback support based on refinement history.

### Changed

- Changed Agents View `Ctrl+C` handling to mirror the interactive chat view: the first press shows a bottom hint and the second exits Prime Agent.
- Changed keybinding hints to render arrow keys as `↑`, `↓`, `←`, and `→`.
- Changed Agents View to keep transient status and reply text out of the agent list area.
- Changed Agents View `Ctrl+X` so the first press only stops sessions that are actively running.
- Changed daemon-owned chat sessions opened from Agents View to show a `← agents` tray hint when the input is empty.
- Changed active session creation to use per-session runtime config so active sessions can use different cwd, model, auth, and tool settings.
- Changed interactive `Ctrl+C` to interrupt the current operation first and exit only on a second press while the exit hint is visible; `Escape` now clears the input bar without interrupting the agent.
- Changed the IPython system prompt section to use the upstream rlm-harness IPYTHON_CONTROL_PROMPT: IPython is framed as a persistent control environment, not the target project's runtime. Shell commands should use `%%bash` cells instead of `!cmd` escapes. The agent should not install dependencies into the IPython kernel but use the project's own environment instead.
- Removed the `.venv` interpreter hint from the system prompt (no longer needed with the control-environment framing).

### Fixed

- Fixed confusing transcript formatting around thinking blocks and tool calls: ipython cells and default-shell tools (bash and extension tools) now share one panel style with a subtle neutral background instead of a status-colored box or a left rail, and tool status headers name the tool (`python · done · 7ms`, `bash · running`) so they no longer read as floating labels for the preceding thinking block. Themes gain a required `toolPanelBg` color for the panel background.
- Fixed `prime-agent` to detect a daemon left running by a previous version after self-update: the daemon now reports its app version on connect, and idle stale daemons are restarted automatically (daemons with active sessions are left running with a warning).
- Fixed Agents View listing daemon-owned subagents as top-level selectable agents instead of nested child rows.
- Fixed Agents View opening saved or stale sessions by creating a daemon runtime from the saved session file before attaching.
- Fixed Agents View delete confirmation so the red stopped confirmation expires after two seconds without removing the stopped session row.
- Fixed Agents View selected-row highlighting so it spans the full terminal width after prompt wrapping changes the layout.
- Fixed Agents View prompt bar to show a placeholder for creating a new session.
- Fixed Agents View opening sessions with the dashboard cwd's model registry, which could incorrectly show the model selector for daemon-owned sessions from another cwd.
- Stopped showing changelog entries automatically on install, first launch, and update startup.
- Fixed multi-line IPython, assistant, and child-agent errors to collapse internal tracebacks by default while preserving full details on expand.
- Fixed child-agent navigation to show contextual keybinding hints and a visible focused tray marker.
- Fixed the release installer to ask before bootstrapping the IPython kernel runtime during install, avoiding default first-run `uv` prompts inside the TUI.
- Fixed browser sign-in links to show plain URLs when terminal hyperlinks are unsupported.
- Fixed the release installer splash to keep its logo geometry stable across terminal resizes.

### Removed

- Removed the interactive `!` / `!!` bash shortcuts; use IPython for shell commands.

## [0.0.7] - 2026-06-01

### Added

- Added Prime team selection during Prime Inference login so team inference costs use the selected Prime CLI context.
- Added Python-backed skills that install into the persistent IPython kernel and are exposed alongside markdown skills.

### Changed

- Changed the Prime Agent install script to use a bounded animated Prime Lab splash with centered progress and confirmation prompts.
- Changed startup onboarding to guide unauthenticated users through login and model selection before the first agent turn.
- Changed installer npm and Node.js setup progress to keep command output hidden behind the splash and rotate detail text.

### Fixed

- Fixed update notifications and package docs to point at `prime-agent update` and use compact one-line alerts.
- Fixed Prime CLI credentials from `prime login` to make Prime Inference models available on startup.
- Fixed first-run search helper downloads to run quietly instead of printing over onboarding.
- Fixed stale no-model and tmux/update startup notices from appearing during successful onboarding.

### Removed

- Removed the unused small Prime logo export.

## [0.0.4] - 2026-05-21

### Added

- Added system prompt note listing pre-installed Python packages (requests, httpx, pyyaml, tomli, python-dotenv, pandas, numpy, scipy, beautifulsoup4, lxml, pydantic).
- Added `DEFAULT_RLM_EXTRA_UV_ARGS` constant and kernel bootstrap installation of those packages; updated prompt to reference the constant instead of a hardcoded list.

### Fixed

- Fixed the RLM kernel package prompt to show importable module names and reject `PRIME_AGENT_KERNEL_PYTHON` overrides missing default kernel packages.

## [0.0.2] - 2026-05-20

### Added

- Added a persistent `ipython` tool backed by a Jupyter kernel so Python variables and imports survive across tool calls.
- Added the RLM harness system prompt and `prime-agent-runtime` bridge so IPython code can call `rlm.run` to spawn recursive child agent sessions.
- Added automatic IPython runtime bootstrap with uv-managed Python, `ipykernel`, and `prime-agent-runtime`.
- Added subagent UI surfaces for recursive runs, including compact tray status, full-width detail views, and structured child transcripts rendered like the main chat.
- Added `/goal` for long-running objectives that continue after normal follow-ups drain until the model marks the goal complete.
- Added a pi-style installer script and R2-backed private npm tarball release pipeline for Prime Agent.
- Added Prime Inference as a selectable built-in OpenAI-compatible provider with `PRIME_API_KEY` authentication and `openai/gpt-5.5` as the default model.
- Added a first-class `/login` Prime Inference browser auth flow that imports usable Prime CLI credentials or obtains a new key through the Prime challenge flow.
- Added `/usage` to show token, cost, and context usage on demand.

### Changed

- Changed the default active built-in tool set to `ipython`.
- Changed compaction to restart the active IPython kernel so summarized sessions release in-memory Python state.
- Changed recursive background work to use normal Python async tasks with `rlm.run` instead of a separate RLM background API.
- Changed completed IPython cell rendering to use width/version-aware caching, reducing TUI redraw lag in long sessions.
- Changed collapsed IPython cells to show compact input and output previews with a single expansion hint.
- Changed auto-compaction checks to use the current context estimate and stop between long tool-loop turns before resuming after compaction.
- Changed the goal status UI to use a compact lower-tray indicator instead of repeating the full objective in chat.
- Changed IPython prompt guidance to prefer `!cmd` and `%%bash` for shell commands.
- Changed kernel bootstrap to prompt before installing `uv` and skip postinstall bootstrap unless explicitly enabled.
- Changed the app update check and self-update flow to read the Prime Agent release manifest and install manifest tarballs directly.

### Fixed

- Fixed tarball self-updates to install the tarball without first uninstalling the same logical package.
- Fixed IPython kernel startup to let `ipykernel` bind OS-assigned ports instead of randomly selecting fixed ports.
- Fixed RLM child usage aggregation so parent session totals include recursive child runs after session reloads.
- Fixed the RLM child-agent detail viewer to render messages, thinking, and tool output with the main chat presentation, open at the latest transcript output, and use terminal scrollback for native scrolling.
- Fixed `rlm.run` comm handlers to log failures and drain in-flight child runs during kernel disposal.
- Fixed raw tab rendering in TUI-backed transcript views so painted backgrounds survive indentation.
- Fixed auto-compaction threshold checks during trailing context and tool-result growth.

### Removed

- Removed install/update telemetry pings to `pi.dev` and the related setting and environment override.
- Removed the RLM background API; recursive agents now use `rlm()`/`rlm.run()` with normal Python async tasks for background work.
- Removed the legacy `read`, `write`, `grep`, `find`, and `ls` built-in tools.
- Removed the local TPS extension that posted token/cache stats after each agent response.
