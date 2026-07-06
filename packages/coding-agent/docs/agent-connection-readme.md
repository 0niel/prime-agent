# AgentConnection Architecture README

This document explains the PR #79 interactive-mode decoupling work. It is intentionally detailed because this is a boundary-setting change: the goal is not to build the hosted gateway yet, but to make sure the TUI no longer owns agent execution and can evolve toward daemon and gateway transports without another large TUI rewrite.

## Short Version

Interactive mode used to be both the UI and the execution owner. It received an `AgentSessionRuntime`, reached into `AgentSession`, subscribed to session events directly, read session/model/settings state directly, and called methods such as `prompt()`, `steer()`, `followUp()`, `abort()`, `newSession()`, `switchSession()`, and `fork()` on runtime/session objects.

PR #79 changes that shape. `InteractiveMode` now consumes an injected `AgentConnection` for execution-facing behavior. Normal local interactive startup creates or reuses the local daemon, asks that daemon to own the runtime, attaches a `DaemonAgentConnection`, and gives that connection to the TUI.

The intended local path is now:

```text
TUI -> DaemonAgentConnection -> local daemon socket -> daemon -> AgentSessionRuntime -> AgentSession
```

The future hosted path should be able to become:

```text
web/TUI client -> GatewayAgentConnection -> realtime gateway -> sandbox daemon -> AgentSessionRuntime -> AgentSession
```

The important distinction is this:

```text
AgentConnection is the client-side interaction boundary.
It is not the final remote wire protocol.
```

That means PR #79 moves ownership boundaries and call sites. It does not need to solve sequence numbers, replay, command lifecycle envelopes, artifact handles, hosted auth, or gateway control-plane design.

## Design Goals

The decoupling has five concrete goals.

1. `InteractiveMode` must not own or construct `AgentSessionRuntime`.
2. `InteractiveMode` must not call `AgentSession` methods for execution.
3. `InteractiveMode` must consume execution state, events, and commands through `AgentConnection`.
4. Local-only behavior must be isolated behind adapter and service surfaces, not mixed into the generic connection contract.
5. The current connection types must be honest about what is transitional and what is intended as a stable client boundary.

The result should let local daemon-backed interactive mode preserve user-visible behavior while giving future gateway work a clear adapter target.

## Non-Goals

PR #79 deliberately does not build the remote gateway.

It also deliberately does not solve:

- event sequence numbers
- replay from last seen event
- command lifecycle phases beyond request/response
- stable remote DTOs for every transcript/event shape
- hosted artifact handles
- hosted auth or model setup control plane
- multi-client conflict resolution
- web-specific rendering
- network reconnection semantics
- remote file upload/download APIs

Those are follow-up protocol and product design tasks. The merge bar for PR #79 is that the TUI no longer owns agent execution and that the boundary is clean enough to evolve.

## Why This Was Necessary

The old interactive mode had a simple local shape:

```text
InteractiveMode -> AgentSessionRuntime -> AgentSession
```

That was easy to understand but it made the TUI responsible for too much:

- constructing or holding the runtime
- reading session state
- reading messages
- subscribing to in-process session events
- binding local extension UI callbacks
- reading session manager state
- switching and forking sessions
- calling model/queue/compaction/session methods directly

That shape cannot become a hosted architecture without making the UI aware of things it should never see, such as:

- runtime objects
- session objects
- `SessionManager`
- local filesystem paths as control objects
- daemon Unix sockets
- in-process event emitters
- JavaScript callback functions from extensions

The hosted architecture needs a client that can say "prompt this session", "render this event", "show this UI request", or "switch model", without knowing whether the owner is an in-process runtime, a local daemon, or a sandbox daemon behind a gateway.

## Core Concepts

### AgentConnection

`AgentConnection` is the interface `InteractiveMode` uses for execution-facing interaction.

The interface lives in:

```text
packages/coding-agent/src/modes/agent-connection/types.ts
```

It contains methods for:

- subscribing to connection events
- reading session state and messages
- reading slash command metadata
- reading resource snapshots
- reading available models
- reading session stats and context
- reading and clearing queues
- responding to extension UI requests
- prompting, steering, following up, and aborting
- switching model, thinking level, transport, and queue modes
- compacting and aborting compaction
- reloading, creating, switching, forking, and navigating sessions
- import/export
- saved-session rename/delete
- disposing the connection

The important rule is that `AgentConnection` describes what the client wants to do. It does not describe how the runtime performs the work.

### InProcessAgentConnection

`InProcessAgentConnection` is a compatibility adapter for fallback local paths. It wraps an `AgentSessionRuntime` and implements `AgentConnection`.

It lives in:

```text
packages/coding-agent/src/modes/agent-connection/in-process-agent-connection.ts
```

This adapter is allowed to know about `AgentSessionRuntime` and `AgentSession`, because it is an adapter. `InteractiveMode` is not allowed to know those objects for execution.

This matters because the in-process path still exists for explicit fallbacks:

- startup benchmark
- `--no-session`
- `--help`
- `--list-models`
- other non-interactive modes that are not daemon-backed TUI clients

The adapter preserves local behavior without preserving the old TUI ownership model.

### DaemonAgentConnection

`DaemonAgentConnection` implements `AgentConnection` over the local daemon JSONL socket protocol.

It lives in:

```text
packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts
```

It owns:

- `DaemonClient`
- active daemon session id
- socket request/response calls
- daemon outbound event translation
- daemon error rehydration
- daemon detach/dispose behavior

`InteractiveMode` should not import `DaemonAgentConnection`, `DaemonClient`, `defaultDaemonSocketPath`, or daemon protocol types. Startup code composes those objects and injects only `AgentConnection`.

### Daemon Protocol

The local daemon protocol lives in:

```text
packages/coding-agent/src/modes/daemon/daemon-protocol.ts
```

It is a JSONL protocol over a local socket. It is not the final remote gateway protocol.

It currently provides:

- local daemon commands
- local daemon responses
- local daemon outbound events
- local daemon error info
- local daemon saved-session wire rows

The command `id` fields are request/response correlation ids. They are not stable user command ids, not replay cursors, and not command lifecycle ids.

### InteractiveModeUiServices

`InteractiveModeUiServices` groups local UI services that are intentionally not execution ownership.

It lives in:

```text
packages/coding-agent/src/modes/interactive/interactive-mode-services.ts
```

It includes local services such as:

- settings manager
- model registry for local auth/model browsing
- initial cwd fallback
- initial session name fallback
- registered themes

These are local TUI concerns. They are not the agent execution boundary.

Why keep them local? Because the terminal client still owns local preferences, keybindings, local theme registration, and local credential setup flows. A web client or hosted gateway will need a separate settings/auth/control-plane design. That is not part of PR #79.

### InteractiveModeLocalSessionHost

`InteractiveModeLocalSessionHost` is an in-process compatibility hook for local-only extension behavior.

It also lives in:

```text
packages/coding-agent/src/modes/interactive/interactive-mode-services.ts
```

It can expose:

- local extension runner
- local extension binding
- local session manager for legacy shortcut context
- local callback-bearing `newSession`, `fork`, and `switchSession`
- local tool render callbacks
- local system prompt and abort signal for in-process extension contexts

This host is deliberately not part of `AgentConnection`.

Daemon-backed and future gateway-backed `InteractiveMode` instances should run with:

```text
bindLocalSessionExtensions: false
localSessionHost: undefined
```

The reason is that local JavaScript functions, extension callbacks, and renderer functions are not transportable. They can exist in the in-process fallback adapter, but they must not become a generic client protocol dependency.

## Important Files

### Boundary and Adapters

```text
packages/coding-agent/src/modes/agent-connection/types.ts
packages/coding-agent/src/modes/agent-connection/in-process-agent-connection.ts
packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.ts
packages/coding-agent/src/modes/agent-connection/snapshot.ts
packages/coding-agent/src/modes/agent-connection/tool-definition.ts
packages/coding-agent/src/modes/agent-connection/index.ts
```

### Interactive Mode

```text
packages/coding-agent/src/modes/interactive/interactive-mode.ts
packages/coding-agent/src/modes/interactive/interactive-mode-services.ts
```

### Daemon

```text
packages/coding-agent/src/modes/daemon/daemon-mode.ts
packages/coding-agent/src/modes/daemon/daemon-client.ts
packages/coding-agent/src/modes/daemon/daemon-protocol.ts
packages/coding-agent/src/modes/daemon/daemon-extension-binding.ts
packages/coding-agent/src/modes/daemon/active-session-state.ts
packages/coding-agent/src/modes/daemon/daemon-session-list.ts
packages/coding-agent/src/modes/daemon/daemon-session-id.ts
packages/coding-agent/src/modes/daemon/daemon-socket.ts
```

### Startup Composition

```text
packages/coding-agent/src/main.ts
```

`main.ts` is allowed to know about daemon sockets, daemon clients, session managers, runtime factories, and in-process fallback construction. It is the composition root. The TUI class should not own those details.

### Tests

```text
packages/coding-agent/test/agent-connection-daemon.test.ts
packages/coding-agent/test/agent-connection-in-process.test.ts
packages/coding-agent/test/interactive-mode-boundary.test.ts
packages/coding-agent/test/main-interactive-routing.test.ts
packages/coding-agent/test/daemon-client.test.ts
packages/coding-agent/test/daemon-extension-binding.test.ts
```

## Startup Flows

### Normal Interactive Startup

For normal interactive startup, the code should choose daemon-backed mode.

The routing helper is:

```text
shouldUseDaemonInteractive()
```

Normal interactive startup does this:

1. Parse CLI args.
2. Prepare local UI services and config.
3. Start or reuse the local daemon.
4. Ask the daemon to create or attach an active session.
5. Wrap that active session with `DaemonAgentConnection`.
6. Create `InteractiveMode` with:

```text
agentConnection: DaemonAgentConnection
uiServices: createInteractiveModeUiServicesFromServices(...)
bindLocalSessionExtensions: false
```

The TUI does not construct a local `AgentSessionRuntime` for the execution session on this path.

### In-Process Fallback Startup

Some flows still intentionally use in-process runtime construction.

Current explicit fallbacks include:

- `PI_STARTUP_BENCHMARK`
- `--no-session`
- `--help`
- `--list-models`

In this path, startup creates the runtime and wraps it:

```text
new InProcessAgentConnection(runtime)
```

It also passes:

```text
localSessionHost: createInteractiveModeLocalSessionHost(runtime)
bindLocalSessionExtensions: true
```

This preserves local extension behavior without making it part of the generic connection contract.

### Rich TUI Attach to Active Daemon Sessions

PR #79 also supports rich TUI attach to existing active daemon sessions.

The user-facing shape is:

```bash
./prime-agent.sh --resume <selector>
```

If `<selector>` names a live active daemon session, startup attaches the rich TUI to that active session instead of opening the session file locally.

There is also a convenience shortcut:

```bash
./prime-agent.sh daemon <selector>
```

That shorthand becomes rich TUI attach only when `<selector>` names a live active session. Explicit daemon CLI commands keep their line-oriented behavior:

```bash
./prime-agent.sh daemon list
./prime-agent.sh daemon attach <selector>
./prime-agent.sh daemon create scratch
```

The difference is intentional:

- `daemon attach` is the line-oriented daemon client.
- `daemon <active-id>` is a convenience shorthand for rich TUI attach when the id is live.

## Execution Surface

### Prompt

The TUI calls:

```typescript
agentConnection.prompt(message, options)
```

The daemon adapter sends:

```text
prompt
```

to the local daemon.

Important behavior:

- The daemon owns the actual `session.prompt()` call.
- The TUI does not call `AgentSession.prompt()`.
- The daemon can acknowledge prompt preflight before the whole assistant turn completes.
- Stream progress arrives as connection events.

For future gateway work, this means the current `prompt()` promise is a client convenience, not a full command lifecycle contract. A remote protocol should add accepted/running/completed/failed command phases separately.

### Steer and Follow-Up

The TUI calls:

```typescript
agentConnection.steer(message, images)
agentConnection.followUp(message, images)
```

Those map to daemon-owned session queue behavior.

The TUI keeps a local queue snapshot only for rendering. The queue itself belongs to the execution owner.

### Abort

The TUI calls:

```typescript
agentConnection.abort()
```

The daemon or adapter owns the actual abort behavior.

The TUI should not reach for an `AbortSignal` from the live session except through the in-process local-session-host compatibility path used by local extensions.

### Wait For Idle

The TUI calls:

```typescript
agentConnection.waitForIdle()
```

This replaces the old shape where interactive mode could call into `session.agent.waitForIdle()` directly.

### Compaction and Retry

The TUI calls:

```typescript
agentConnection.compact(...)
agentConnection.abortCompaction()
agentConnection.abortRetry()
agentConnection.abortBranchSummary()
```

Compaction status is rendered from connection state and connection events.

### Session Creation, Switching, Forking, and Tree Navigation

The TUI calls:

```typescript
agentConnection.newSession(...)
agentConnection.switchSession(...)
agentConnection.fork(...)
agentConnection.navigateTree(...)
```

If an in-process extension supplies callback-bearing options such as `withSession`, the local-session-host path can still run that callback locally. That is intentionally isolated. Daemon and gateway clients should not receive JavaScript callbacks through `AgentConnection`.

## State Surface

### AgentConnectionState

`AgentConnectionState` is the TUI's live execution-state snapshot.

It includes:

- active session id
- cwd
- model
- thinking level
- available thinking levels
- streaming status
- compaction status
- retry attempt
- queue modes
- session file
- session id
- session name
- session dir
- leaf id
- auto-compaction flag
- message count
- pending message count
- compaction count
- goal state
- scoped models
- active tool names
- context usage

The TUI uses this as its cache for state that used to come directly from `AgentSession`.

### Messages

The TUI calls:

```typescript
agentConnection.getMessages()
```

for full message history when needed, such as debug rendering and initial state rendering.

Current limitation:

- This still returns `AgentMessage[]`.
- That is transitional.
- A future gateway protocol should define stable transcript DTOs.

### Session Context

The TUI calls:

```typescript
agentConnection.getSessionContext()
```

This returns:

- messages
- thinking level
- model reference

Current limitation:

- It still carries `AgentMessage[]`.
- It avoids importing `SessionContext` from `SessionManager`, but it is not yet a final network transcript DTO.

### Session Tree

The TUI calls:

```typescript
agentConnection.getSessionTree()
```

The tree nodes use connection-owned wrapper types. This avoids making tree rendering depend directly on `SessionManager` types.

Current limitation:

- Some entry payloads still contain `AgentMessage`.
- The future gateway should define stable tree entry DTOs if this becomes a network API.

### Session Stats

The TUI calls:

```typescript
agentConnection.getSessionStats()
```

`SessionStats` moved into a focused module:

```text
packages/coding-agent/src/core/session-stats.ts
```

That avoids importing the whole session module for stats.

Current limitation:

- Stats still include local session file information.
- Hosted clients may need a presentation-oriented stats DTO.

## Event Surface

`AgentConnection` emits:

```typescript
type AgentConnectionEvent =
  | { type: "session_event"; event: AgentConnectionSessionEvent }
  | { type: "session_replaced"; state: AgentConnectionState; messages: AgentMessage[] }
  | { type: "extension_ui_request"; request: AgentConnectionExtensionUiRequest }
  | { type: "closed"; error?: string };
```

### session_event

This carries streaming and execution updates.

Current behavior:

- It includes core `AgentEvent` shapes.
- It also includes Prime Agent session events such as queue, compaction, retry, child-agent, and goal updates.

Current limitation:

- This is not a final gateway event DTO.
- It has no sequence number.
- It has no replay cursor.
- It has no formal event version.

That is acceptable for PR #79 because the goal is to move the TUI behind a boundary. It must be replaced or wrapped before becoming a remote network protocol.

### session_replaced

This tells the TUI that the underlying execution session changed.

The TUI should respond by:

1. Applying the new connection state.
2. Rebinding local UI services if it has an in-process local host.
3. Refreshing connection catalog data.
4. Re-rendering the current session state.

The TUI should not manually rewire `AgentSession` event subscriptions. The adapter owns that.

### extension_ui_request

Daemon-owned extensions can request client UI.

The request shape is:

```typescript
interface AgentConnectionExtensionUiRequest {
  id: string;
  method: string;
  payload: Record<string, unknown>;
}
```

The TUI validates the payload at the boundary and responds with:

```typescript
type AgentConnectionExtensionUiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true };
```

Supported methods include:

- `select`
- `confirm`
- `input`
- `editor`
- `notify`
- `setStatus`
- `setWorkingMessage`
- `setWorkingVisible`
- `setWorkingIndicator`
- `setHiddenThinkingLabel`
- `setWidget`
- `setTitle`
- `setEditorText`

Current limitation:

- The method names and payload schemas are loose.
- There is no formal client capability negotiation.
- There is no multi-client ownership model.

That is acceptable for local daemon-backed TUI work. Hosted clients should formalize this before relying on it broadly.

### closed

The connection can report closure with an optional error string.

Current limitation:

- There is no reconnect policy in `AgentConnection`.
- There is no replay support.
- There is no structured close code taxonomy.

Those belong in later gateway work.

## Resource and Command Surface

### Slash Commands

The TUI calls:

```typescript
agentConnection.getCommands()
```

This returns `AgentConnectionSlashCommand[]`, including:

- name
- registered name
- description
- argument hint
- source
- source info

Sources include:

- extension
- prompt
- skill

The TUI uses this data for autocomplete and routing.

Important distinction:

- Command metadata is transportable.
- Local argument completion callbacks are not.

In-process mode can still attach local extension argument completers through `InteractiveModeLocalSessionHost`. Daemon-backed and future gateway-backed clients should not receive executable completion callbacks through `AgentConnection`.

### Resource Snapshot

The TUI calls:

```typescript
agentConnection.getResourceSnapshot()
```

The snapshot can include:

- context files
- skills
- prompts
- extensions
- themes
- diagnostics

The goal is to show daemon-owned loaded resources without having the TUI inspect the daemon runtime.

Current limitation:

- Some resource metadata includes local paths.
- Hosted clients may need package ids, resource ids, or sandbox-relative labels instead of raw paths.

### Tool Definitions

The TUI calls:

```typescript
agentConnection.getToolDefinition(name)
```

The returned `AgentConnectionToolDefinition` is metadata only:

- name
- label
- description
- prompt snippet
- prompt guidelines
- parameters
- render shell hint

It intentionally excludes:

- `execute`
- `prepareArguments`
- `renderCall`
- `renderResult`

Why? Because those are functions. They cannot be sent through a daemon or gateway protocol safely.

In-process local extensions can still provide renderer callbacks through:

```text
InteractiveModeLocalSessionHost.getToolRendererDefinition()
```

That keeps local custom rendering local.

## Model and Settings Surface

### Model Availability

The TUI asks the connection for session-relevant model candidates:

```typescript
agentConnection.getAvailableModels()
```

This matters because the execution owner determines what models are actually available for a session.

The TUI still uses local model registry and settings services for:

- provider setup
- login/logout
- local credential warnings
- persisted default model settings
- provider display
- local `models.json` errors

That split is intentional for PR #79.

### Model Switching

The TUI changes the active execution model through:

```typescript
agentConnection.setModel(provider, modelId)
agentConnection.cycleModel(direction)
agentConnection.setScopedModels(scopedModels)
```

The TUI should only persist local default model settings after the connection accepts the execution change.

### Thinking Level

The TUI changes thinking level through:

```typescript
agentConnection.setThinkingLevel(level)
agentConnection.cycleThinkingLevel()
```

Thinking level state comes from connection state and events.

### Settings

Settings are not part of `AgentConnection`.

That is intentional. Settings currently remain local TUI state. Future hosted clients need a separate control-plane design for account settings, model setup, credentials, and user preferences.

## Session Registry and File-Like Operations

The TUI uses `AgentConnection` for saved-session operations:

```typescript
agentConnection.listSavedSessions(scope)
agentConnection.renameSavedSession(sessionPath, name)
agentConnection.deleteSavedSession(sessionPath)
```

It also uses:

```typescript
agentConnection.importFromJsonl(inputPath, cwdOverride)
agentConnection.exportToHtml(outputPath)
agentConnection.exportToJsonl(outputPath)
```

This keeps current local behavior working through daemon-backed interactive mode.

Current limitation:

- These APIs are path-based.
- Saved-session rows contain `Date` objects.
- Exports return file paths.

That is not remote-safe. It is accepted in PR #79 because local TUI behavior currently needs it and the goal is not to build hosted artifact semantics yet.

Rule for future work:

```text
Do not add new generic AgentConnection features that require local paths, Date objects, or local filesystem semantics.
```

Gateway work should introduce:

- opaque session ids
- artifact ids
- download handles
- upload handles
- string timestamps
- sandbox-relative display paths when needed

## Subagent Runtime Model

The daemon owns primary and subagent runtimes.

Relevant files:

```text
packages/coding-agent/src/modes/daemon/daemon-mode.ts
packages/coding-agent/src/modes/daemon/daemon-session-list.ts
packages/coding-agent/src/core/agent-session-runtime.ts
```

Daemon session summaries can include:

- runtime kind
- parent active session id
- parent session id
- parent session path
- RLM child id
- RLM parent node id

The TUI also receives RLM child-agent snapshot events through `AgentConnectionSessionEvent`.

Current limitation:

- The protocol does not yet formalize `sandboxId`, `primaryRuntimeId`, or a stable runtime graph.
- The daemon can hold multiple active sessions.
- The hosted target of "one primary agent per sandbox plus daemon-owned subagent runtimes" is represented operationally, but not yet as a stable gateway identity model.

That identity model belongs in a follow-up protocol PR.

## What Is Local By Design

The following are local UI concerns in PR #79:

- terminal rendering
- keyboard input
- keybindings
- local settings manager
- local theme registration
- local model registry browsing
- local credential setup and login/logout UI
- local package update checks
- local clipboard behavior
- local path autocomplete
- local changelog display
- local TUI smoke tooling

These can be used by the terminal client without violating the execution boundary.

The key test is:

```text
Does this local thing control agent execution, or is it local UI chrome?
```

If it controls agent execution, it should go through `AgentConnection`.

If it is local UI chrome, it can remain in `InteractiveModeUiServices` or another local UI service.

## What Must Not Leak Into InteractiveMode Execution

`InteractiveMode` should not depend on:

- `AgentSessionRuntime`
- `AgentSession`
- `SessionManager`
- `DaemonClient`
- `defaultDaemonSocketPath`
- daemon protocol command types
- in-process event emitters
- executable tool callbacks through `AgentConnection`
- extension runner callbacks through `AgentConnection`
- local daemon socket paths
- local filesystem-backed session internals for execution

The regression test `interactive-mode-boundary.test.ts` checks the most important import-level version of this rule.

## Transitional Types

The current `AgentConnection` type surface still uses some core package types:

- `AgentEvent`
- `AgentMessage`
- `Model`
- `ImageContent`
- `TextContent`
- `UserMessage`
- `AssistantMessage`
- `Usage`
- `ThinkingLevel`
- `Transport`
- `CompactionResult`
- `GoalState`
- `SessionStats`
- `DeleteSessionFileResult`

Not all of these are equally risky.

Plain data types such as model metadata, image content, usage, and thinking levels are structurally close to wire DTOs today, but they are still imported package types rather than versioned protocol types.

The highest-risk transitional types are:

- `AgentEvent`
- `AgentMessage`
- saved-session `Date` fields
- local session paths
- arbitrary tool args/results
- custom message payloads

Why keep them for PR #79?

Because replacing every transcript, event, renderer, and session tree shape in the same PR would be a much larger and riskier migration. PR #79 moves the architectural boundary first. A follow-up can replace the DTOs once the TUI is already consuming a boundary.

The important rule is:

```text
Do not call the current AgentConnection type surface the final remote protocol.
```

## Error Handling

The local daemon has structured recoverable errors for some interactive recovery flows.

Examples:

- missing session cwd
- missing import file

Those are rehydrated by `DaemonAgentConnection` so existing interactive recovery flows still work.

Current limitation:

- Most errors are still strings.
- There is no complete error code taxonomy.
- There is no transport-level retry/reconnect model.

That is acceptable for PR #79. Hosted work should define structured error codes and retryability semantics.

## Testing Strategy

The tests are focused on preserving current behavior while enforcing the new boundary.

### Boundary Test

```text
packages/coding-agent/test/interactive-mode-boundary.test.ts
```

This verifies:

- `interactive-mode.ts` does not import core runtime/session/session-manager modules.
- `interactive-mode.ts` does not import daemon transports.
- `interactive-mode.ts` does not import concrete connection adapters.
- generic connection types do not import core runtime/session/session-manager modules.
- generic connection types document the transitional protocol distinction.

This is not a full architecture proof. It is a practical guardrail against the easiest regression.

### Daemon Connection Adapter Tests

```text
packages/coding-agent/test/agent-connection-daemon.test.ts
```

These verify daemon adapter behavior such as:

- loading connection state through daemon commands
- forwarding session replacement snapshots
- forwarding session events only for the attached active session
- forwarding extension UI requests and responses
- queue commands
- resource snapshots
- session context
- session tree
- tool metadata
- saved-session list/rename/delete
- recoverable error rehydration
- owning-client disposal

### In-Process Adapter Tests

```text
packages/coding-agent/test/agent-connection-in-process.test.ts
```

These verify:

- tool metadata strips executable callbacks
- session context comes through the connection boundary
- replacement snapshots are emitted
- old session listeners are unsubscribed
- new session listeners are subscribed
- runtime callbacks are cleared during dispose

### Startup Routing Tests

```text
packages/coding-agent/test/main-interactive-routing.test.ts
```

These verify:

- normal interactive startup uses daemon-backed mode
- explicit fallback paths remain in-process
- rich TUI daemon attach shorthand parsing works
- explicit daemon line-oriented commands are preserved

### Daemon Extension Binding Tests

```text
packages/coding-agent/test/daemon-extension-binding.test.ts
```

These verify daemon-side extension binding and replacement behavior.

## How To Test Manually

### Normal Daemon-Backed TUI

Run:

```bash
./prime-agent.sh
```

Expected behavior:

- the TUI opens normally
- a local daemon is started or reused
- interactive mode is backed by `DaemonAgentConnection`
- user-visible behavior should match normal interactive use

### Active Daemon Session List

Run:

```bash
./prime-agent.sh daemon list
```

This uses the line-oriented daemon CLI, not rich TUI attach.

### Rich TUI Attach

Start or find an active daemon session id, then run:

```bash
./prime-agent.sh --resume <active-session-id>
```

or:

```bash
./prime-agent.sh daemon <active-session-id>
```

Expected behavior:

- rich TUI opens
- it attaches to the existing active daemon session
- it does not create a new local in-process runtime for the TUI

### Explicit Line-Oriented Attach

Run:

```bash
./prime-agent.sh daemon attach <active-session-id>
```

Expected behavior:

- line-oriented daemon attach behavior
- not the rich TUI

This distinction is intentional.

## Common Misunderstandings

### "Does AgentConnection mean the remote protocol is done?"

No.

`AgentConnection` is the client-side interaction boundary. The remote protocol still needs its own envelopes, versions, replay model, command lifecycle, artifact handles, auth/control-plane story, and stable DTOs.

### "Why keep in-process mode at all?"

Because some paths are explicit local fallbacks or non-daemon modes. The goal is not to delete local execution immediately. The goal is to stop the TUI from owning execution directly.

### "Why are there still local paths in AgentConnection?"

Because current local session management and import/export behavior are path-based. PR #79 preserves behavior. The important guardrail is that future generic connection features should not deepen the path dependency.

### "Why are AgentEvent and AgentMessage still used?"

Because rewriting the entire transcript/event renderer would make this PR much larger. They are documented as transitional. The follow-up DTO PR should replace or wrap them after the boundary is in place.

### "Does daemon-backed TUI still support extension UI?"

Yes, for daemon-originated extension UI requests that can be represented as serializable method/payload messages.

Local callback-bearing extension hooks remain in the in-process local-session-host path only.

### "Why remove live bash shortcut support?"

The migration intentionally does not expand the boundary for bash-specific session operations. Historical bash messages still render, but new live shell work should go through IPython for this architecture slice.

## Review Checklist

Use this checklist when reviewing future changes near interactive mode.

### InteractiveMode

- Does `interactive-mode.ts` avoid importing `AgentSessionRuntime`?
- Does it avoid importing `AgentSession`?
- Does it avoid importing `SessionManager`?
- Does it avoid importing daemon sockets or daemon clients?
- Does it receive execution behavior through `AgentConnection`?
- Are local-only hooks guarded by `bindLocalSessionExtensions` or local UI services?

### AgentConnection

- Does a new method describe client intent instead of runtime internals?
- Does it avoid executable callbacks?
- Does it avoid exposing daemon socket details?
- Does it avoid exposing `SessionManager` objects?
- Does it avoid adding new local path dependencies?
- If it reuses core DTOs, is that clearly transitional?

### Daemon Adapter

- Does daemon-specific transport logic stay inside `DaemonAgentConnection` or daemon modules?
- Are daemon errors translated before reaching TUI recovery flows?
- Are only events for the attached active session forwarded?
- Does dispose detach cleanly?

### In-Process Adapter

- Is runtime/session access contained inside the adapter?
- Are executable tool callbacks stripped from connection-facing metadata?
- Are session replacement listeners correctly rebound?
- Are old subscriptions cleaned up?

### Docs and Tests

- Does new behavior have a focused regression test?
- Does the boundary test still pass?
- Is any transitional surface documented rather than implied?
- Are local-only behaviors called out as local-only?

## Follow-Up Work

The next protocol-focused PRs should address:

1. Stable network DTOs for messages, events, session entries, stats, resources, and errors.
2. A versioned gateway envelope.
3. Event sequence numbers.
4. Replay from last seen event.
5. Snapshot plus cursor semantics.
6. Command ids that survive reconnect.
7. Command accepted/running/completed/failed phases.
8. Structured error codes and retryability.
9. Artifact handles for import/export/files/images.
10. Hosted auth and model setup control plane.
11. Stable sandbox and runtime identity, such as `sandboxId`, `primaryRuntimeId`, and `parentRuntimeId`.
12. Client capability negotiation for extension UI.
13. Pagination or range loading for large session histories.
14. Multi-client ownership and conflict semantics.

These follow-ups should not require another broad TUI refactor if PR #79 keeps the current boundary clean.

## The Most Important Rule

The TUI can be rich, local, and terminal-specific.

The TUI cannot be the execution owner.

If a change requires the TUI to know about `AgentSessionRuntime`, `AgentSession`, `SessionManager`, daemon sockets, local event emitters, or executable runtime callbacks, it probably belongs in an adapter, daemon module, or future control-plane service instead.
