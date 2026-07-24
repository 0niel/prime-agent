import { createHash } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	type Message,
	normalizeToolName,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import type { ImportedSession } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function parseTimestamp(value: unknown, fallback = Date.now()): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value < 10_000_000_000 ? value * 1000 : value;
	}
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return fallback;
}

export function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

export function parseToolArguments(value: unknown): Record<string, unknown> {
	if (isRecord(value)) {
		return value;
	}
	if (typeof value === "string") {
		try {
			const parsed = JSON.parse(value) as unknown;
			if (isRecord(parsed)) {
				return parsed;
			}
		} catch {
			return { raw: value };
		}
		return { raw: value };
	}
	return value === undefined ? {} : { value };
}

export function createZeroUsage(overrides?: Partial<Usage>): Usage {
	const input = overrides?.input ?? 0;
	const output = overrides?.output ?? 0;
	const cacheRead = overrides?.cacheRead ?? 0;
	const cacheWrite = overrides?.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: overrides?.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: {
			input: overrides?.cost?.input ?? 0,
			output: overrides?.cost?.output ?? 0,
			cacheRead: overrides?.cost?.cacheRead ?? 0,
			cacheWrite: overrides?.cost?.cacheWrite ?? 0,
			total: overrides?.cost?.total ?? 0,
		},
	};
}

export interface ImportedAssistantOptions {
	api: Api;
	provider: string;
	model: string;
	timestamp: number;
	usage?: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

export function createAssistantMessage(
	content: (TextContent | ThinkingContent | ToolCall)[],
	options: ImportedAssistantOptions,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: options.api,
		provider: options.provider,
		model: options.model,
		usage: options.usage ?? createZeroUsage(),
		stopReason: options.stopReason ?? (content.some((block) => block.type === "toolCall") ? "toolUse" : "stop"),
		errorMessage: options.errorMessage,
		timestamp: options.timestamp,
	};
}

export function createUserMessage(content: string | (TextContent | ImageContent)[], timestamp: number): UserMessage {
	return { role: "user", content, timestamp };
}

export function createToolResultMessage(
	toolCallId: string,
	toolName: string,
	content: (TextContent | ImageContent)[],
	isError: boolean,
	timestamp: number,
): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content,
		isError,
		timestamp,
	};
}

export function textContent(text: string): TextContent {
	return { type: "text", text };
}

export function thinkingContent(
	thinking: string,
	options?: Pick<ThinkingContent, "thinkingSignature" | "redacted">,
): ThinkingContent {
	return { type: "thinking", thinking, ...options };
}

export function toolCallContent(id: string, name: string, args: unknown): ToolCall {
	return { type: "toolCall", id, name: normalizeToolName(name), arguments: parseToolArguments(args) };
}

export function contentToText(content: Message["content"]): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function isNonEmptyMessage(message: Message): boolean {
	if (message.role === "user") {
		return typeof message.content === "string" ? message.content.trim().length > 0 : message.content.length > 0;
	}
	return message.content.length > 0;
}

export function sanitizeImportedMessages(messages: Message[]): Message[] {
	const toolNames = new Map<string, string>();
	const resultIds = new Set(
		messages.filter((message) => message.role === "toolResult").map((message) => message.toolCallId),
	);

	for (const message of messages) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const block of message.content) {
			if (block.type === "toolCall" && block.id && block.name) {
				toolNames.set(block.id, block.name);
			}
		}
	}

	const sanitized: Message[] = [];
	const emittedCalls = new Set<string>();
	const emittedResults = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			const content: AssistantMessage["content"] = [];
			for (const block of message.content) {
				if (block.type !== "toolCall") {
					if (
						(block.type === "text" && block.text.trim()) ||
						(block.type === "thinking" && (block.thinking.trim() || block.thinkingSignature || block.redacted))
					) {
						content.push(block);
					}
					continue;
				}
				if (!block.id || !block.name || emittedCalls.has(block.id)) {
					continue;
				}
				if (resultIds.has(block.id)) {
					content.push(block);
					emittedCalls.add(block.id);
				} else {
					content.push(textContent(`[Tool call: ${block.name}]\n${stringifyUnknown(block.arguments)}`));
				}
			}
			const next = { ...message, content };
			if (isNonEmptyMessage(next)) {
				sanitized.push(next);
			}
			continue;
		}

		if (message.role === "toolResult") {
			if (!emittedCalls.has(message.toolCallId) || emittedResults.has(message.toolCallId)) {
				continue;
			}
			const content = message.content.filter(
				(block) => block.type === "image" || (block.type === "text" && block.text.trim().length > 0),
			);
			const next = {
				...message,
				toolName: toolNames.get(message.toolCallId) ?? message.toolName,
				content: content.length > 0 ? content : [textContent("(No tool output)")],
			};
			sanitized.push(next);
			emittedResults.add(message.toolCallId);
			continue;
		}

		if (isNonEmptyMessage(message)) {
			sanitized.push(message);
		}
	}

	return sanitized.some((message) => message.role === "user") ? sanitized : [];
}

export function deriveSessionTitle(messages: Message[], fallback?: string): string | undefined {
	const firstUser = messages.find((message) => message.role === "user");
	const text = firstUser ? contentToText(firstUser.content).replace(/\s+/g, " ").trim() : "";
	if (text) {
		return text.length > 80 ? `${text.slice(0, 77)}...` : text;
	}
	const normalizedFallback = fallback?.replace(/\s+/g, " ").trim();
	if (!normalizedFallback) {
		return undefined;
	}
	return normalizedFallback.length > 80 ? `${normalizedFallback.slice(0, 77)}...` : normalizedFallback;
}

export function importedSessionContentHash(session: ImportedSession): string {
	const messages = session.messages.map(({ timestamp: _timestamp, ...message }) => message);
	return createHash("sha256")
		.update(
			JSON.stringify({
				cwd: session.cwd,
				title: session.title,
				messages,
			}),
		)
		.digest("hex");
}
