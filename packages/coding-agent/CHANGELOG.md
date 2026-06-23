# Changelog

## [Unreleased]

## [0.2.1] - 2026-06-23

### Fixed

- Fixed daemon session recaps disappearing while a new turn regenerated them ([#239](https://github.com/PrimeIntellect-ai/prime-agent/issues/239)).
- Fixed bundled built-in skills missing from the packaged release layouts ([#240](https://github.com/PrimeIntellect-ai/prime-agent/issues/240)).

## [0.2.0] - 2026-06-23

### Added

- Added `/effort` (alias `/thinking`) to set the reasoning level, with argument autocomplete that lists the levels the current model supports.
- Added a `/system-prompt` command that shows the exact prompt last sent to the model, labelling it honestly when no turn has run yet.
- Added a `/rename` alias for `/name` and a `Ctrl+R` shortcut in the Agents View to rename the selected session inline.
- Added support for feeding pasted images into model context: pasted images become atomic editor markers, are validated and resized, held in a bounded registry, and dropped when the active model lacks vision.
- Added edit diffs to the collapsed IPython view, rendering file edits as a wrapped, full-width relative-path diff prefixed with the cell status marker.

### Changed

- Replaced the `Shift+Tab` thinking-level cycle with the `/effort` command, exposing a `max` thinking level on Claude models that support it.
- Changed the `/goal` and `/effort` commands to stay highlighted in the editor while their argument is being typed.
- Changed queued follow-up messages to render below the execution indicator.
- Changed the RLM system prompt to align its shared sections exactly with rlm-harness, including the environment block and pre-installed package hints.
- Changed trace uploads to be observable and resilient: failures surface the underlying cause, outcomes are logged to `agent-traces.log`, `/traces` shows the resolved endpoint, and transient failures retry once.

### Fixed

- Fixed Prime Agent formatting breaking when resizing to a small screen, where tool-output colors bled into the padding at narrow widths.
- Fixed onboarding showing no models after entering a provider key by refreshing the scoped model list after login.
- Fixed silent daemon replacement reading as random crashes by logging shutdown/replacement decisions, and offering to stop a stale-version daemon at startup instead of erroring out.

### Performance

- Improved session load, context building, and listing to scale linearly: file loads decode per line over a raw buffer, and branch/context building uses push+reverse instead of per-entry unshift.
- Improved daemon responsiveness under large session loads by parsing session files off the event loop, so loading one big session no longer freezes the other sessions the daemon hosts.

## [0.1.9] - 2026-06-22

### Added

- Added the Prime brand splash to the new-chat view.

### Changed

- Changed daemon attach to send slimmer snapshots and to avoid saved-session disk scans in the Agents View, speeding up switching between sessions.

### Fixed

- Fixed daemon out-of-memory crashes when listing saved sessions by streaming the listing, preserving large session row metadata, and ignoring oversized tool rows when computing session activity.

## [0.1.8] - 2026-06-21

### Added

- Added `daemon shutdown --all` to stop every Prime Agent daemon on the machine, hardened against recycled PIDs and able to force-kill wedged daemons.
- Added git context to session traces: each trace records the repository URL, branch ref, and HEAD commit, captured at end of turn and carried over when a session is forked.

### Changed

- Changed `prime-agent` to open a new chat by default at launch instead of the previous session, with the daemon session created lazily on the first message and empty chats discarded on quit.
- Changed sending a message from the Agents View to open the chat for that session.
- Changed model resolution to persist the selected model across updates and default Prime Inference to Claude Opus 4.8 when no model has been chosen.

### Fixed

- Fixed `prime-agent` attaching to a stale daemon left running by a previous version after self-update: `update` now stops the old daemon and starts the new version (confirming first when busy sessions would lose work), and a stale daemon that cannot be replaced fails loudly instead of a silent broken attach. Both shutdown paths now poll the socket until it stops listening, so a transient hiccup cannot spawn a duplicate daemon.

## [0.1.7] - 2026-06-18

### Added

- Added session and RLM heartbeats: a persistent, user-controlled heartbeat re-prompts a long-running session on a schedule via daemon-backed cron jobs, exposed through the `heartbeat` slash command and a bundled `rlm-heartbeat` Python skill, plus a `cron` CLI command to list jobs.

### Changed

- Changed collapsed IPython tool calls in the TUI to render as a single-line summary instead of a multi-line block.

## [0.1.6] - 2026-06-17

### Added

- Added a `daemon ps` CLI command that lists every Prime Agent daemon running on the machine, with confirmation before shutdown and guards against killing a shared or still-reachable daemon.
- Added opt-in trace uploads: `/traces` enables background upload of persisted session JSONL files to the Prime Inference trace endpoint.
- Added agent summaries and live status to Agents View, generated daemon-side per session and refreshed on sweep.
- Added crash-stack capture for the daemon: output routes to a rotating per-socket log file under `<agentDir>/logs/`, client-side crashes write to `client-errors.log`, and a `/logs` command shows the log directory.

### Changed

- Changed startup notices (app-update, extension-update, and tmux warnings) to surface on the Agents View instead of being appended to every chat session.

### Fixed

- Fixed IPython kernel state being lost across session resume: kernel variables are now snapshotted under session-artifacts, restored on resume, deleted with the session, and dropped on compaction.
- Fixed the viewport jumping when toggling tool-output expansion in the TUI; the viewport now stays anchored across expand/collapse.
- Fixed non-persisted (e.g. `/tmp`) sessions creating an RLM working directory they did not need.

## [0.1.5] - 2026-06-16

### Added

- Added rich syntax-aware diff rendering for IPython file edits in the TUI: the `edit` Python skill emits structured edit results that the interactive view renders as a colored, full-width unified diff inside the cell.
- Added a subagent spawn-program panel to Agents View: expand a subagent group and press `Ctrl+O` to toggle a panel showing the IPython cell that called `rlm.run` to spawn them.
- Added slash-command alias resolution so command aliases resolve to their canonical command consistently across interactive mode and Agents View, including in autocomplete.

### Changed

- Moved goals out of the harness tool surface into a bundled `goal` Python skill (`goal.get` / `goal.create` / `goal.complete`) backed by session state; the only built-in tool is now `ipython`, and the `rlm.run` comm channel is generalized into a typed host bridge.
- Changed the RLM system prompt to prefer Python for reading and searching files, porting the IPython guidance from rlm-harness.
- Spaced out the Agents View shortcut hints for readability.

### Fixed

- Fixed slow opening of long agent sessions: the JSONL socket reader is now O(n) instead of O(n^2) on large records, the session tree is fetched lazily instead of embedded in the attach snapshot, `SessionManager.open()` no longer parses the session file twice, and context building avoids copying every entry on the hot path.
- Fixed `open()` to stay consistent with the full loader when a session file begins with a blank line.
- Fixed goal-completion usage accounting that could overcount tokens.

## [0.1.4] - 2026-06-15

### Added

- Added a `/refine` command and a session-backed `rlm.harness` continual-learning state (prompt notes, memory, reusable skills, and subagent specs) that persists globally across sessions, with explicit CRUD methods, a refinement log, and global rollback. The compact harness overview is injected into the system prompt, and `/refine` re-reads state before applying so concurrent writes are not clobbered.
- Added an `edit` built-in Python RLM skill for targeted single-occurrence string replacement in existing files, callable from the kernel or as a shell command.

### Changed

- Changed the IPython control prompt to require `%%bash` as the first line of a shell cell to match the rlm-harness.

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

## [0.0.10] - 2026-06-08

### Added

- Added an inline input prompt indicator to the interactive editor.
- Added contextual keybinding hints and a visible focused tray marker for child-agent navigation.
- Added OS-specific shortcut labels in keybinding hints, rendering `Cmd`/`Option` on macOS and capitalized key names elsewhere.

### Changed

- Changed the IPython system prompt to the upstream rlm-harness `IPYTHON_CONTROL_PROMPT`: IPython is framed as a persistent control environment rather than the target project's runtime, shell commands use `%%bash` cells instead of `!cmd`, and project imports, tests, and dependency checks run through the project's own environment. Removed the `.venv` interpreter hint.
- Changed interactive `Ctrl+C` to interrupt the current operation first and exit only on a second press while the exit hint is visible; `Escape` now clears the input bar without interrupting the agent.
- Changed the Prime theme to tone down the flashy neon purple and lime green in favor of a calmer dusty lavender and sage green.

### Fixed

- Fixed missing ripgrep to surface a clean inline warning at startup and fail sub-agent runs with a clear message, while routing kernel diagnostics into captured stderr.
- Fixed IPython kernel startup to avoid blocking the session, cancelling child RLM runs on session abort and reporting bootstrap progress through a start-options handler.
- Fixed the subagent tool-expansion keybinding so it toggles expanded tool output inside the child-agent detail view.
- Fixed browser sign-in links to show plain URLs when the terminal does not support hyperlinks.
- Fixed the auth selector to preserve the selected provider's login type.
- Stopped showing changelog entries automatically on install, first launch, and update startup.

## [0.0.9] - 2026-06-04

## [0.0.8] - 2026-06-04

### Added

- Added an `onboardingCompleted` setting and a dedicated Prime Inference onboarding splash that prompts users authenticated only via the Prime CLI to choose a model before their first turn.

### Changed

- Changed the system prompt to frame the agent as a general-purpose agent that uses code to solve tasks rather than a pure coding agent, with guidance that shell state does not persist across `!cmd`/`%%bash` cells while Python kernel state does.

### Fixed

- Fixed the onboarding flow so model selection, manual API-key entry, cancellation, and the "model already ready" path all resolve correctly and mark onboarding complete instead of re-prompting on every launch.
- Fixed the release installer to ask before bootstrapping the IPython kernel runtime during install (defaulting to bootstrap when no terminal is detected) and to avoid stalling on an interactive `uv` prompt.

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

## [0.0.6] - 2026-05-27

### Changed

- Changed installer startup so npm and Node.js setup output stays hidden behind the bounded Prime splash with rotating detail text.
- Changed `postinstall` to optionally bootstrap the `fd` and `rg` search helpers (gated by an env flag) alongside the kernel, and made search-helper downloads default to silent.

### Fixed

- Fixed Prime Inference auth so credentials from `prime login` are read from the Prime CLI config and surfaced as a `prime_cli` auth source, making Prime Inference models available on startup without a separate login.
- Fixed initial model selection to skip a saved default model that no longer has configured auth.
- Fixed first-run search-helper downloads to run quietly instead of printing over onboarding.

## [0.0.5] - 2026-05-26

### Added

- Added a centered-overlay menu system for onboarding and a redesigned Prime onboarding splash and Prime Inference login dialog with browser sign-in plus a manual API-key fallback.
- Added theme support for adapting interactive surfaces to the detected terminal foreground/background colors.

### Changed

- Changed startup onboarding to guide unauthenticated users through login and model selection before the first agent turn.
- Changed the model selector and OAuth/provider selectors to render as centered surface menus rather than inline CLI lists.
- Changed update and package-update notifications to compact one-line alerts pointing at `prime-agent update`.

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

## [0.0.1] - 2026-05-18

### Added

- Initial Prime Agent release, forked from pi-mono: a persistent `ipython` tool backed by a Jupyter kernel as the default tool set, recursive RLM subagents via `rlm.run`, `/goal` for long-running objectives, an auto-bootstrapped uv-managed kernel runtime, Prime-branded TUI, and an R2-backed tarball release pipeline with a pi-style installer.
