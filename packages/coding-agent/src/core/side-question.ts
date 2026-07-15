import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";

export type SideQuestionStatus = "running" | "complete" | "cancelled" | "error";

export interface SideQuestionEvent {
	id: string;
	question: string;
	answer: string;
	status: SideQuestionStatus;
	errorMessage?: string;
}

export interface SideQuestionRun {
	done: Promise<void>;
	abort(): void;
}

const SIDE_QUESTION_INSTRUCTION =
	"Answer this one side question using only the conversation context above. Do not use tools and do not ask a follow-up question.";

function readAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") {
		return "";
	}
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export function startSideQuestion(
	parent: Agent,
	id: string,
	question: string,
	onEvent: (event: SideQuestionEvent) => void | Promise<void>,
): SideQuestionRun {
	const model = parent.state.model;
	if (!model) {
		throw new Error("Select a model before asking a side question");
	}

	const sideAgent = new Agent({
		initialState: {
			model,
			systemPrompt: parent.state.systemPrompt,
			messages: structuredClone(parent.state.messages),
			thinkingLevel: "off",
			serviceTier: parent.state.serviceTier,
			tools: [],
		},
		convertToLlm: parent.convertToLlm,
		transformContext: parent.transformContext,
		streamFn: parent.streamFn,
		getApiKey: parent.getApiKey,
		onPayload: parent.onPayload,
		onResponse: parent.onResponse,
		shouldStopAfterTurn: () => true,
		sessionId: parent.sessionId,
		thinkingBudgets: parent.thinkingBudgets,
		transport: "sse",
		maxRetryDelayMs: parent.maxRetryDelayMs,
		toolExecution: parent.toolExecution,
	});

	let answer = "";
	let abortRequested = false;
	let started = false;
	const emit = (status: SideQuestionStatus, errorMessage?: string) =>
		onEvent({ id, question, answer, status, ...(errorMessage ? { errorMessage } : {}) });

	const unsubscribe = sideAgent.subscribe(async (event) => {
		if (event.type !== "message_update" && event.type !== "message_end") {
			return;
		}
		const nextAnswer = readAssistantText(event.message);
		if (nextAnswer === answer) {
			return;
		}
		answer = nextAnswer;
		await emit("running");
	});

	const prompt = `<side_question>\n${SIDE_QUESTION_INSTRUCTION}\n\n${question}\n</side_question>`;
	const done = Promise.resolve()
		.then(() => emit("running"))
		.then(async () => {
			if (abortRequested) {
				await emit("cancelled");
				return;
			}
			started = true;
			await sideAgent.prompt(prompt);
			if (abortRequested) {
				await emit("cancelled");
				return;
			}
			if (sideAgent.state.errorMessage) {
				await emit("error", sideAgent.state.errorMessage);
				return;
			}
			await emit("complete");
		})
		.catch(async (error) => {
			const errorMessage = error instanceof Error ? error.message : String(error);
			await Promise.resolve(
				emit(abortRequested ? "cancelled" : "error", abortRequested ? undefined : errorMessage),
			).catch(() => undefined);
		})
		.finally(unsubscribe);

	return {
		done,
		abort() {
			abortRequested = true;
			if (started) {
				sideAgent.abort();
			}
		},
	};
}
