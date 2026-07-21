<p align="center">
  <a href="https://primeintellect.ai">
    <picture>
      <source media="(prefers-color-scheme: light)" srcset="https://github.com/user-attachments/assets/40c36e38-c5bd-4c5a-9b34-f7b902cd155d">
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8">
      <img alt="Prime Intellect" src="https://github.com/user-attachments/assets/6414bc9b-126b-41ca-9307-9e982430cde8" width="312" style="max-width: 100%;">
    </picture>
  </a>
</p>

<h3 align="center">
Prime Agent: RLM-native Coding and Research Harness
</h3>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/verifiers">Verifiers</a> &bull;
  <a href="https://github.com/PrimeIntellect-ai/prime-rl">PRIME-RL</a> &bull;
  <a href="https://github.com/badlogic/pi-mono">pi-mono</a>
</p>

<p align="center">
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml">
    <img src="https://github.com/PrimeIntellect-ai/prime-agent/actions/workflows/build-binaries.yml/badge.svg" alt="Build Binaries" />
  </a>
</p>

Prime Agent is a coding and research agent built for long-running tasks.

Most agents are optimized for short, single-threaded sessions. As tasks grow, logs and tool output lead to context rot, compaction drops useful details, and one model becomes the bottleneck. Their skills are simply markdown instructions, and sessions require a client to remain open.

Prime Agent combines a [Recursive Language Model (RLM)](https://www.primeintellect.ai/blog/rlm) runtime with durable background processes:

- **Everything is programmatic:** persistent IPython is the only built-in model tool; file operations, shell commands, tool use, and context management happen through code.
- **Subagents are built in:** `rlm(...)` spawns real child agents from Python for parallel or background work and returns their results programmatically.
- **Skills are executable:** skills are importable Python packages, and the built-in skill creator can turn recurring workflows into project or personal skills.
- **Sessions run in the background:** daemon-backed agents keep running when the terminal disconnects and can be reattached later.
- **Agents communicate directly:** running agents can exchange messages and orchestrate one another without routing everything through the user.
- **Long tasks keep moving:** automatic compaction, persistent goals, heartbeats, cron schedules, autonomous mode, and retained subagents preserve progress across turns and terminal sessions.

## Getting Started

Install the latest stable release:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install.sh | sh
```

Install the latest beta built from `main`:

```bash
curl -fsSL https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/install-beta.sh | sh
```

Stable advances when a version bump lands on `main`; beta advances on every commit to `main`.

Then start Prime Agent:

```bash
prime-agent
```

Public releases are currently installed from versioned release artifacts through these installer scripts. The repository still contains inherited npm workspace identifiers for source compatibility; they are not the user-facing Prime Agent install path.

Other useful commands:

```bash
prime-agent agents                   # Open the agents view
prime-agent --resume [path|id]       # Browse or resume a previous session
prime-agent doctor [--fix]           # Inspect or repair background services
prime-agent update [--force]         # Update Prime Agent
prime-agent shutdown [--force]       # Stop every agent, worker, and background service
```

## Built for Long-Running Work

- **Direct agent-to-agent communication:** running agents and retained subagents can discover one another, exchange messages, steer active work, or queue follow-ups.
- **Daemon-backed continuity:** active sessions, IPython state, schedules, and subagents keep running when the terminal detaches and can be reattached later.
- **Heartbeats and schedules:** `/heartbeat`, `rlm_heartbeat`, and `prime-agent schedule` can re-enter a session periodically or at a specific time.
- **Persistent goals:** `/goal` keeps an objective and its progress active across turns until it is completed, paused, or cleared.
- **Bounded autonomous mode:** `/autonomous` continues working until its quality gates pass or a configured turn, token, or time limit is reached.

## Documentation

- [Documentation index](packages/coding-agent/docs/index.md)
- [Architecture overview](packages/coding-agent/docs/architecture.md)
- [Quickstart](packages/coding-agent/docs/quickstart.md)
- [RLM programming model](packages/coding-agent/docs/rlm.md)
- [Long-running and background agents](packages/coding-agent/docs/long-running-agents.md)
- [Usage and CLI reference](packages/coding-agent/docs/usage.md)
- [Provider setup](packages/coding-agent/docs/providers.md)
- [Development](packages/coding-agent/docs/development.md)
