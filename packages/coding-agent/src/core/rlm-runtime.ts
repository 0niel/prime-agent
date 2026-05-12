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

export type RlmBackgroundRunState = "queued" | "running" | "done" | "error" | "cancelled";

export interface RlmBackgroundRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
}

export interface RlmBackgroundRunStartResult {
	id: string;
	state: RlmBackgroundRunState;
	session_dir: string | null;
}

export interface RlmBackgroundRunStatusResult extends RlmBackgroundRunStartResult {
	result?: RlmRunResult;
	error?: string;
	timed_out?: boolean;
}

export interface RlmBackgroundRunStatusRequest {
	id: string;
}

export interface RlmBackgroundRunWaitRequest {
	id: string;
	timeoutMs?: number;
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<RlmRunResult>;
export type RlmBackgroundRunHandler = (request: RlmBackgroundRunRequest) => Promise<RlmBackgroundRunStartResult>;
export type RlmBackgroundRunStatusHandler = (
	request: RlmBackgroundRunStatusRequest,
) => Promise<RlmBackgroundRunStatusResult>;
export type RlmBackgroundRunWaitHandler = (
	request: RlmBackgroundRunWaitRequest,
) => Promise<RlmBackgroundRunStatusResult>;
