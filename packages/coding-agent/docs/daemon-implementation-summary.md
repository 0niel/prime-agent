# Daemon Implementation Summary

This branch adds a tmux-like daemon mode for Prime Agent. The daemon is a background process that listens on a Unix socket and owns active agent sessions. CLI clients connect to that socket to create, attach, detach, prompt, rename, kill, and list sessions.

## User Flow

The main entrypoint is:

```sh
prime-agent daemon
```

That command:

1. Starts the background daemon if it is not already running.
2. Creates a new active session.
3. Attaches the terminal to that new session.

Explicit daemon commands are also available:

```sh
prime-agent daemon start
prime-agent daemon list
prime-agent daemon list -a
prime-agent daemon create scratch
prime-agent daemon attach <session>
prime-agent daemon prompt <session> "Say hello"
prime-agent daemon rename <session> scratch
prime-agent daemon kill <session>
prime-agent daemon shutdown
```

`prime-agent daemon start` launches a detached background daemon and returns. `prime-agent daemon start --foreground` keeps the daemon attached to the current terminal for debugging.

## Session Identity

There are two session identifiers:

- `activeSessionId`: daemon-local live handle for a currently active session.
- `sessionId`: persisted JSONL session id.

The `activeSessionId` exists because one persisted session can be attached to a running daemon process and needs a socket-level live handle. The `sessionId` is the durable id stored in the JSONL header.

The list table displays 12-character suffix ids. Commands accept suffix matches and report an error if the suffix is ambiguous.

## Per-Session Config

The daemon has default session config from the command that started it. Each created session can override that config.

Examples of per-session config:

- `cwd`
- model/provider
- tools
- thinking level
- extensions, skills, prompts, themes
- context/settings flags

This means one daemon can own sessions with different models, working directories, and tool sets.

## Persistence Layout

Session JSONL files are stored flat:

```text
~/.prime/agent/sessions/<sessionId>.jsonl
```

The session root can be overridden with:

```sh
PRIME_AGENT_SESSION_DIR=/path/to/sessions
```

Session artifacts are stored separately:

```text
~/.prime/agent/session-artifacts/<sessionId>/...
```

The current concrete use of `session-artifacts` is RLM/subagent child session storage. A parent session can have child session directories under its artifact directory.

## Session Metadata

Metadata that is not inferable from messages is stored as typed append-only JSONL entries in the session file.

Examples:

```json
{"type":"session_info","name":"scratch"}
{"type":"session_state","state":{"status":"sleep"}}
{"type":"model_change","provider":"openai","modelId":"gpt-4o-mini"}
{"type":"thinking_level_change","thinkingLevel":"off"}
```

Current rules:

- Immutable session facts live in the JSONL header: `id`, `timestamp`, `cwd`, `parentSession`.
- Mutable metadata is appended as typed entries.
- The latest matching metadata entry wins during reconstruction.
- Metadata/control entries are ignored by LLM context unless they are explicitly context-bearing, such as `custom_message`.

Daemon inactive state is persisted with `session_state`. It is not guessed from file paths.

## List Behavior

`prime-agent daemon list` shows active and idle sessions.

`prime-agent daemon list -a` includes inactive saved sessions as well.

Table columns:

```text
name  id  status  age  model  messages  clients
```

The `cwd` column is intentionally omitted. `age` is based on the JSONL modified time.

Statuses are sorted in this order:

1. `user`
2. `idle`
3. `tool`
4. `model`
5. `sleep`
6. `crash`

Only the status text is colored.

Status meaning:

- `user`: active session has an attached client and is waiting for user input.
- `idle`: active session has no attached client and is not currently streaming.
- `tool`: active session is streaming and currently has pending tool calls.
- `model`: active session is streaming model output.
- `sleep`: inactive persisted session that was cleanly killed or shut down.
- `crash`: inactive persisted session marked as crashed.

## Protocol Shape

CLI clients send JSON commands over the daemon socket. Commands include an optional request `id`, which is only used to correlate command responses.

Example command shape:

```json
{"id":"request-1","type":"create","name":"scratch"}
```

Example response shape:

```json
{"id":"request-1","type":"response","command":"create","success":true,"data":{"session":{}}}
```

Attach is event-oriented. The daemon sends an initial `session_attached` event with state and historical messages, then streams subsequent `session_event` messages for new activity.

## Tests

Tests were added or updated around:

- daemon list table output
- daemon id suffix matching and ambiguity handling
- persisted session state
- flat session storage
- `PRIME_AGENT_SESSION_DIR`
- session artifact directory behavior
- RLM/subagent child session placement
