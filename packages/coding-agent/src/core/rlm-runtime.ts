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

export type RlmRunHandler = (request: RlmRunRequest) => Promise<RlmRunResult>;
