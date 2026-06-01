# Changelog

## [Unreleased]

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
