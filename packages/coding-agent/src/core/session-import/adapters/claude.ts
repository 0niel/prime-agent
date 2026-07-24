import { basename } from "node:path";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { readJsonLines } from "../jsonl.js";
import {
	asArray,
	asBoolean,
	asNumber,
	asRecord,
	asString,
	createAssistantMessage,
	createToolResultMessage,
	createUserMessage,
	createZeroUsage,
	deriveSessionTitle,
	parseTimestamp,
	sanitizeImportedMessages,
	stringifyUnknown,
	textContent,
	thinkingContent,
	toolCallContent,
} from "../shared.js";
import type { ImportedSession } from "../types.js";

function claudeUsage(message: Record<string, unknown>): Usage {
	const usage = asRecord(message.usage);
	const input = asNumber(usage?.input_tokens) ?? 0;
	const output = asNumber(usage?.output_tokens) ?? 0;
	const cacheRead = asNumber(usage?.cache_read_input_tokens) ?? 0;
	const cacheWrite = asNumber(usage?.cache_creation_input_tokens) ?? 0;
	return createZeroUsage({
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
	});
}

function claudeStopReason(value: unknown): StopReason {
	switch (value) {
		case "tool_use":
			return "toolUse";
		case "max_tokens":
			return "length";
		case "error":
			return "error";
		default:
			return "stop";
	}
}

function parseImage(value: unknown): ImageContent | undefined {
	const source = asRecord(asRecord(value)?.source);
	const data = asString(source?.data);
	const mimeType = asString(source?.media_type);
	if (!data || !mimeType || asString(source?.type) !== "base64") {
		return undefined;
	}
	return { type: "image", data, mimeType };
}

function parseToolResultContent(value: unknown): (TextContent | ImageContent)[] {
	if (typeof value === "string") {
		return [textContent(value)];
	}
	const content: (TextContent | ImageContent)[] = [];
	for (const item of asArray(value)) {
		const block = asRecord(item);
		if (asString(block?.type) === "text") {
			const text = asString(block?.text);
			if (text) {
				content.push(textContent(text));
			}
		} else if (asString(block?.type) === "image") {
			const image = parseImage(block);
			if (image) {
				content.push(image);
			}
		}
	}
	if (content.length === 0 && value !== undefined) {
		content.push(textContent(stringifyUnknown(value)));
	}
	return content;
}

function parseClaudeAssistant(
	message: Record<string, unknown>,
	timestamp: number,
	toolNames: Map<string, string>,
): AssistantMessage | undefined {
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];
	if (typeof message.content === "string" && message.content) {
		content.push(textContent(message.content));
	}
	for (const item of asArray(message.content)) {
		const block = asRecord(item);
		switch (asString(block?.type)) {
			case "text": {
				const text = asString(block?.text);
				if (text) {
					content.push(textContent(text));
				}
				break;
			}
			case "thinking": {
				const thinking = asString(block?.thinking);
				const signature = asString(block?.signature);
				if (thinking || signature) {
					content.push(thinkingContent(thinking ?? "", { thinkingSignature: signature }));
				}
				break;
			}
			case "redacted_thinking": {
				const data = asString(block?.data);
				if (data) {
					content.push(
						thinkingContent("[Reasoning redacted]", {
							thinkingSignature: data,
							redacted: true,
						}),
					);
				}
				break;
			}
			case "tool_use": {
				const id = asString(block?.id);
				const name = asString(block?.name);
				if (id && name) {
					content.push(toolCallContent(id, name, block?.input));
					toolNames.set(id, name);
				}
				break;
			}
		}
	}
	if (content.length === 0) {
		return undefined;
	}
	const model = asString(message.model) ?? "claude";
	return createAssistantMessage(content, {
		api: "anthropic-messages",
		provider: "anthropic",
		model,
		timestamp,
		usage: claudeUsage(message),
		stopReason: claudeStopReason(message.stop_reason),
	});
}

export async function parseClaudeSession(filePath: string): Promise<ImportedSession | undefined> {
	const messages: Message[] = [];
	const toolNames = new Map<string, string>();
	let sourceId: string | undefined;
	let cwd = "";
	let createdAt = Number.POSITIVE_INFINITY;

	await readJsonLines(filePath, (value) => {
		const entry = asRecord(value);
		if (!entry || asBoolean(entry.isSidechain) || asBoolean(entry.isMeta)) {
			return;
		}
		sourceId ??= asString(entry.sessionId);
		cwd ||= asString(entry.cwd) ?? "";
		const timestamp = parseTimestamp(entry.timestamp);
		createdAt = Math.min(createdAt, timestamp);
		const message = asRecord(entry.message);
		if (!message) {
			return;
		}

		if (asString(entry.type) === "assistant" && asString(message.role) === "assistant") {
			const assistant = parseClaudeAssistant(message, timestamp, toolNames);
			if (assistant) {
				messages.push(assistant);
			}
			return;
		}

		if (asString(entry.type) !== "user" || asString(message.role) !== "user") {
			return;
		}

		if (typeof message.content === "string") {
			messages.push(createUserMessage(message.content, timestamp));
			return;
		}

		let userContent: (TextContent | ImageContent)[] = [];
		const flushUserContent = () => {
			if (userContent.length > 0) {
				messages.push(createUserMessage(userContent, timestamp));
				userContent = [];
			}
		};
		for (const item of asArray(message.content)) {
			const block = asRecord(item);
			switch (asString(block?.type)) {
				case "text": {
					const text = asString(block?.text);
					if (text) {
						userContent.push(textContent(text));
					}
					break;
				}
				case "image": {
					const image = parseImage(block);
					if (image) {
						userContent.push(image);
					}
					break;
				}
				case "tool_result": {
					const toolCallId = asString(block?.tool_use_id);
					if (!toolCallId) {
						break;
					}
					flushUserContent();
					messages.push(
						createToolResultMessage(
							toolCallId,
							toolNames.get(toolCallId) ?? "tool",
							parseToolResultContent(block?.content),
							asBoolean(block?.is_error) ?? false,
							timestamp,
						),
					);
					break;
				}
			}
		}
		flushUserContent();
	});

	const sanitized = sanitizeImportedMessages(messages);
	if (sanitized.length === 0) {
		return undefined;
	}
	const fallbackId = basename(filePath, ".jsonl");
	return {
		source: "claude",
		sourceId: sourceId ?? fallbackId,
		cwd,
		title: deriveSessionTitle(sanitized),
		createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
		messages: sanitized,
	};
}
