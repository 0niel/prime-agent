import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, Usage } from "@earendil-works/pi-ai";
import type { AgentSession } from "./agent-session.js";
import type { ToolDefinition } from "./extensions/index.js";

export interface RlmUsage {
	prompt_tokens: number;
	completion_tokens: number;
}

export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
}

export interface RlmRunResult {
	answer: string;
	usage: RlmUsage;
	turns: number;
	session_dir: string | null;
}

export interface RlmInternalRunResult extends RlmRunResult {
	assistantUsage: Usage;
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<RlmRunResult>;

export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoalTools: boolean;
	autoActivateGoalTools: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	releaseRlmSubagentRuntime?(runtime: RlmSubagentRuntime, options: CreateRlmSubagentRuntimeOptions): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
