# JSON Event Stream Mode

```bash
prime-agent --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating Prime Agent into other tools or custom UIs.

## Event Types

Events are defined in [`AgentSessionEvent`](../src/core/agent-session.ts):

```typescript
type CompactionReason = "manual" | "threshold" | "overflow" | "requested";

type AgentSessionEvent =
  | AgentEvent
  | { type: "ipython_sent_agent_message"; toolCallId: string; message: KernelSentAgentMessage }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
  | { type: "compaction_start"; reason: CompactionReason; customInstructions?: string }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "service_tier_changed"; serviceTier: ServiceTier }
  | { type: "compaction_end"; reason: CompactionReason; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string; errorSeverity?: "warning" | "error"; customInstructions?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "auth_stale"; provider: string; sourceTokens?: readonly AuthSourceToken[] }
  | { type: "rlm_child_update"; child: RlmChildAgentSnapshot }
  | { type: "recap_update"; recap: string | undefined }
  | { type: "goal_update"; goal: GoalState }
  | { type: "bash_start"; command: string; excludeFromContext: boolean; transient?: boolean; runId?: string }
  | { type: "bash_output"; chunk: string }
  | { type: "bash_end"; exitCode: number | undefined; cancelled: boolean; truncated: boolean; fullOutputPath?: string; errorMessage?: string; transient?: boolean; runId?: string }
  | { type: "autonomous_gate_start"; command: string; attempt: number; maxRetries: number }
  | { type: "autonomous_gate_end"; command: string; attempt: number; maxRetries: number; passed: boolean; skipped?: boolean; exitText?: string; output?: string }
  | { type: "autonomous_continuation"; reason: "gate_failed" | "missing_terminal_evidence"; continuationsUsed: number; maxContinuations: number }
  | { type: "autonomous_limit_reached"; reason: "maxContinuations" | "maxTurns" | "maxTokens" | "timeoutMs"; used: number; limit: number }
  | { type: "refine_complete"; result: RefinementResult }
  | { type: "refine_failed"; error: string };
```

`queue_update` emits the full pending steering and follow-up queues whenever they change. `compaction_start` and `compaction_end` cover both manual and automatic compaction; `errorSeverity` is `"warning"` for benign skips and `"error"` for real failures.

`rlm_child_update` fires on every subagent state change and carries the child's full current state ([`RlmChildAgentSnapshot`](../src/core/agent-session.ts), see [rlm.md](rlm.md)). `goal_update` reports autonomous goal progress ([`GoalState`](../src/core/goals.ts), see [long-running-agents.md](long-running-agents.md)), and `recap_update` carries the summarizer's latest description of what the session is doing.

The `autonomous_*` events expose the autonomous control loop (see [long-running-agents.md](long-running-agents.md)), letting a consumer tell "the agent tried and failed" apart from "a quality gate never passed" or "a budget ran out". `autonomous_gate_end` reports `skipped: true` when a gate was not rerun because the workspace is unchanged since its last failure. Gates are evaluated on both the in-session and host-driven paths, so a single cycle can emit two gate pairs — the second is normally the skipped short circuit.

The `bash_*` events cover shell commands the user runs directly (`!command`), not the agent's tool calls: output arrives as `bash_output` chunks, `transient` marks side-conversation runs, and `runId` echoes the caller's id so concurrent runs can be correlated. `ipython_sent_agent_message` reports a message the kernel sent to another agent after its tool result was already recorded.

Base events from [`AgentEvent`](../../agent/src/types.ts):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](../../ai/src/types.ts):
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Extended messages from [`packages/coding-agent/src/core/messages.ts`](../src/core/messages.ts):
- `BashExecutionMessage`
- `CustomMessage`
- `BranchSummaryMessage`
- `CompactionSummaryMessage`

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

Your prompt is echoed back as a `user` message pair before the assistant's, and `message_update` is only emitted for assistant messages. The final result text is never written to stdout in JSON mode, so the stream stays parseable.

Not every `user` message was typed by a human: in autonomous mode, gate-failure continuation prompts are injected as ordinary `user` messages. Heartbeat, cron, and goal-context prompts are distinguishable — they arrive as `custom` messages carrying a `customType`.

Extensions that fail are reported on stdout as a frame, alongside the human-readable line on stderr:

```json
{"type":"extension_error","extensionPath":"/path/ext.ts","event":"session_start","error":"..."}
```

Other diagnostics are not JSON: failure reasons and autonomous quality-gate failures are written to stderr as human-readable text only. The process exits non-zero when a run fails — a request ending in `stopReason: "error"` or `"aborted"`, a failed compaction, a failed session command, or an unmet autonomous quality gate — so the exit code is a reliable success signal without parsing the stream.

## Example

```bash
prime-agent --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```

Track a subagent fleet:

```bash
prime-agent --mode json "Investigate the build failure" 2>/dev/null \
  | jq -r 'select(.type == "rlm_child_update") | "\(.child.label): \(.child.status)"'
```
