/**
 * Run modes for the coding agent.
 */

export type {
	AgentConnection,
	AgentConnectionArtifactReference,
	AgentConnectionArtifactType,
	AgentConnectionEvent,
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
	AgentConnectionModel,
	AgentConnectionModelCycleResult,
	AgentConnectionQueueState,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionEvent,
	AgentConnectionSlashCommand,
	AgentConnectionState,
} from "./agent-connection/index.js";
export { DaemonAgentConnection, InProcessAgentConnection } from "./agent-connection/index.js";
export { DaemonClient, type DaemonClientMessageListener } from "./daemon/daemon-client.js";
export { type DaemonModeOptions, runDaemonMode } from "./daemon/daemon-mode.js";
export type {
	DaemonArtifactReference,
	DaemonAttachResult,
	DaemonClientCapability,
	DaemonClientId,
	DaemonCommand,
	DaemonCommandEnvelope,
	DaemonCommandId,
	DaemonEventEnvelope,
	DaemonEventId,
	DaemonEventMeta,
	DaemonEventSequence,
	DaemonOutbound,
	DaemonProtocolInfo,
	DaemonProtocolName,
	DaemonProtocolVersion,
	DaemonReplayInfo,
	DaemonReplayStatus,
	DaemonResponse,
	DaemonResumeCursor,
	DaemonSessionSnapshot,
} from "./daemon/daemon-protocol.js";
export {
	DAEMON_PROTOCOL_INFO,
	DAEMON_PROTOCOL_NAME,
	DAEMON_PROTOCOL_VERSION,
} from "./daemon/daemon-protocol.js";
export type { SessionStatus, SessionSummary } from "./daemon/daemon-session-list.js";
export { defaultDaemonSocketPath } from "./daemon/daemon-socket.js";
export {
	InteractiveMode,
	type InteractiveModeOptions,
} from "./interactive/interactive-mode.js";
export {
	createInteractiveModeLocalSessionHost,
	createInteractiveModeUiServices,
	createInteractiveModeUiServicesFromServices,
	type InteractiveModeLocalSessionHost,
	type InteractiveModeUiServices,
} from "./interactive/interactive-mode-services.js";
export { type PrintModeOptions, runPrintMode } from "./print-mode.js";
export { type ModelInfo, RpcClient, type RpcClientOptions, type RpcEventListener } from "./rpc/rpc-client.js";
export { runRpcMode } from "./rpc/rpc-mode.js";
export type { RpcCommand, RpcResponse, RpcSessionState } from "./rpc/rpc-types.js";
