import { basename } from "node:path";
import type { Message, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { readJsonLines } from "../jsonl.js";
import {
	asArray,
	asRecord,
	asString,
	contentToText,
	createAssistantMessage,
	createToolResultMessage,
	createUserMessage,
	deriveSessionTitle,
	parseTimestamp,
	sanitizeImportedMessages,
	stringifyUnknown,
	textContent,
	thinkingContent,
	toolCallContent,
} from "../shared.js";
import type { ImportedSession } from "../types.js";

interface PendingAssistant {
	content: (TextContent | ThinkingContent | ToolCall)[];
	timestamp: number;
}

function contentText(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	const parts: string[] = [];
	for (const item of asArray(value)) {
		const block = asRecord(item);
		const text = asString(block?.text) ?? asString(block?.output_text) ?? asString(block?.input_text);
		if (text) {
			parts.push(text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : stringifyUnknown(value);
}

function isInjectedCodexContext(text: string): boolean {
	const normalized = text.trimStart();
	return (
		normalized.startsWith("<permissions instructions>") ||
		normalized.startsWith("<app-context>") ||
		normalized.startsWith("<apps_instructions>") ||
		normalized.startsWith("<collaboration_mode>") ||
		normalized.startsWith("<in-app-browser-context") ||
		normalized.startsWith("<plugins_instructions>") ||
		normalized.startsWith("<recommended_plugins>") ||
		normalized.startsWith("<skills_instructions>") ||
		normalized.startsWith("<environment_context>") ||
		normalized.startsWith("# AGENTS.md instructions")
	);
}

function responseMessageText(payload: Record<string, unknown>, excludeInjectedContext = false): string {
	return asArray(payload.content)
		.map((item) => {
			const block = asRecord(item);
			return asString(block?.text) ?? asString(block?.output_text) ?? asString(block?.input_text) ?? "";
		})
		.filter((text) => text && (!excludeInjectedContext || !isInjectedCodexContext(text)))
		.join("\n");
}

function reasoningText(payload: Record<string, unknown>): string {
	const blocks = [...asArray(payload.summary), ...asArray(payload.content)];
	return blocks
		.map((item) => asString(asRecord(item)?.text) ?? "")
		.filter(Boolean)
		.join("\n");
}

export async function parseCodexSession(filePath: string): Promise<ImportedSession | undefined> {
	const messages: Message[] = [];
	const fallbackUserMessages = new Set<Message>();
	const eventUserMessages: { text: string; timestamp: number }[] = [];
	let sourceId: string | undefined;
	let cwd = "";
	let provider = "openai-codex";
	let model = "codex";
	let createdAt = Number.POSITIVE_INFINITY;
	let pending: PendingAssistant | undefined;

	const flushAssistant = () => {
		if (!pending || pending.content.length === 0) {
			pending = undefined;
			return;
		}
		messages.push(
			createAssistantMessage(pending.content, {
				api: "openai-codex-responses",
				provider,
				model,
				timestamp: pending.timestamp,
			}),
		);
		pending = undefined;
	};

	const addAssistantContent = (content: TextContent | ThinkingContent | ToolCall, timestamp: number) => {
		pending ??= { content: [], timestamp };
		pending.content.push(content);
	};

	await readJsonLines(filePath, (value) => {
		const entry = asRecord(value);
		const payload = asRecord(entry?.payload);
		if (!entry || !payload) {
			return;
		}
		const timestamp = parseTimestamp(entry.timestamp);
		createdAt = Math.min(createdAt, timestamp);

		if (asString(entry.type) === "session_meta") {
			sourceId ??= asString(payload.id);
			cwd ||= asString(payload.cwd) ?? "";
			provider = asString(payload.model_provider) ?? provider;
			return;
		}
		if (asString(entry.type) === "turn_context") {
			cwd ||= asString(payload.cwd) ?? "";
			model = asString(payload.model) ?? model;
			return;
		}
		if (asString(entry.type) === "event_msg" && asString(payload.type) === "user_message") {
			const text = asString(payload.message);
			if (text) {
				flushAssistant();
				eventUserMessages.push({ text, timestamp });
				messages.push(createUserMessage(text, timestamp));
			}
			return;
		}
		if (asString(entry.type) !== "response_item") {
			return;
		}

		const itemType = asString(payload.type);
		if (itemType === "message" && asString(payload.role) === "user") {
			const text = responseMessageText(payload, true);
			if (text) {
				flushAssistant();
				const userMessage = createUserMessage(text, timestamp);
				messages.push(userMessage);
				fallbackUserMessages.add(userMessage);
			}
			return;
		}
		if (itemType === "message" && asString(payload.role) === "assistant") {
			const text = responseMessageText(payload);
			if (text) {
				addAssistantContent(textContent(text), timestamp);
			}
			return;
		}
		if (itemType === "reasoning") {
			const text = reasoningText(payload);
			if (text) {
				addAssistantContent(thinkingContent(text), timestamp);
			}
			return;
		}

		const isCall = itemType === "function_call" || itemType === "custom_tool_call" || itemType === "tool_search_call";
		if (isCall) {
			const callId = asString(payload.call_id);
			const name =
				asString(payload.name) ??
				(itemType === "tool_search_call" ? "tool_search" : (itemType?.replace(/_call$/, "") ?? "tool"));
			if (callId) {
				const namespace = asString(payload.namespace);
				addAssistantContent(
					toolCallContent(callId, namespace ? `${namespace}.${name}` : name, payload.arguments ?? payload.input),
					timestamp,
				);
			}
			return;
		}

		const isOutput =
			itemType === "function_call_output" ||
			itemType === "custom_tool_call_output" ||
			itemType === "tool_search_output";
		if (isOutput) {
			const callId = asString(payload.call_id);
			if (!callId) {
				return;
			}
			flushAssistant();
			messages.push(
				createToolResultMessage(
					callId,
					itemType === "tool_search_output" ? "tool_search" : "tool",
					[textContent(contentText(payload.output ?? payload.tools ?? payload.execution))],
					asString(payload.status) === "failed",
					timestamp,
				),
			);
		}
	});
	flushAssistant();

	const selectedMessages = messages.filter((message) => {
		if (!fallbackUserMessages.has(message)) {
			return true;
		}
		if (message.role !== "user") {
			return false;
		}
		const text = contentToText(message.content);
		if (isInjectedCodexContext(text)) {
			return false;
		}
		return !eventUserMessages.some(
			(eventMessage) =>
				eventMessage.text === text && Math.abs(eventMessage.timestamp - (message.timestamp ?? 0)) <= 1_000,
		);
	});
	const sanitized = sanitizeImportedMessages(selectedMessages);
	if (sanitized.length === 0) {
		return undefined;
	}
	return {
		source: "codex",
		sourceId: sourceId ?? basename(filePath, ".jsonl"),
		cwd,
		title: deriveSessionTitle(sanitized),
		createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
		messages: sanitized,
	};
}
