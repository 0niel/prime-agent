import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { shouldUseWindowsShell } from "../../../utils/child-process.js";
import {
	asArray,
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
	textContent,
	thinkingContent,
	toolCallContent,
} from "../shared.js";
import type { ImportedSession } from "../types.js";

interface OpenCodeSessionRow {
	id: string;
	directory?: string;
	title?: string;
	time_created?: number;
}

interface MessageDataRow {
	id: string;
	data: string;
}

interface JsonDataRow {
	data: string;
}

interface OpenCodeMessageRecord {
	message: Record<string, unknown>;
	parts: Record<string, unknown>[];
}

interface NodeSqliteModule {
	DatabaseSync: new (path: string, options: { readOnly: boolean }) => NodeDatabaseSync;
}

function openDatabase(path: string): NodeDatabaseSync {
	const require = createRequire(import.meta.url);
	const sqlite = require("node:sqlite") as NodeSqliteModule;
	return new sqlite.DatabaseSync(path, { readOnly: true });
}

function parseData(value: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(value) as unknown);
	} catch {
		return undefined;
	}
}

function messageUsage(message: Record<string, unknown>): Usage {
	const tokens = asRecord(message.tokens);
	const cache = asRecord(tokens?.cache);
	const input = asNumber(tokens?.input) ?? 0;
	const output = asNumber(tokens?.output) ?? 0;
	const cacheRead = asNumber(cache?.read) ?? 0;
	const cacheWrite = asNumber(cache?.write) ?? 0;
	return createZeroUsage({
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: asNumber(tokens?.total) ?? input + output + cacheRead + cacheWrite,
	});
}

function partTimestamp(part: Record<string, unknown>, fallback: number): number {
	const time = asRecord(part.time);
	return parseTimestamp(time?.start, fallback);
}

function finishReason(value: unknown): AssistantMessage["stopReason"] {
	switch (value) {
		case "tool-calls":
		case "tool_use":
			return "toolUse";
		case "length":
			return "length";
		case "error":
			return "error";
		default:
			return "stop";
	}
}

function userPartContent(part: Record<string, unknown>): TextContent | undefined {
	switch (asString(part.type)) {
		case "text": {
			const text = asString(part.text);
			return text ? textContent(text) : undefined;
		}
		case "file": {
			const filename = asString(part.filename) ?? asString(part.url);
			return filename ? textContent(`[Attached file: ${filename}]`) : undefined;
		}
		case "subtask": {
			const prompt = asString(part.prompt);
			return prompt ? textContent(prompt) : undefined;
		}
		default:
			return undefined;
	}
}

function openCodeErrorMessage(value: unknown): string | undefined {
	const error = asRecord(value);
	const data = asRecord(error?.data);
	return asString(data?.message) ?? asString(error?.message);
}

function convertOpenCodeSession(
	session: OpenCodeSessionRow,
	records: OpenCodeMessageRecord[],
): ImportedSession | undefined {
	const messages: Message[] = [];
	for (const { message, parts } of records) {
		const role = asString(message.role);
		if (role !== "user" && role !== "assistant") {
			continue;
		}
		const time = asRecord(message.time);
		const timestamp = parseTimestamp(time?.created, session.time_created ?? Date.now());
		if (role === "user") {
			const content = parts.map(userPartContent).filter((part): part is TextContent => part !== undefined);
			if (content.length > 0) {
				messages.push(createUserMessage(content, timestamp));
			}
			continue;
		}

		let pending: (TextContent | ThinkingContent | ToolCall)[] = [];
		const usage = messageUsage(message);
		const provider = asString(message.providerID) ?? "opencode";
		const model = asString(message.modelID) ?? "opencode";
		const errorMessage = openCodeErrorMessage(message.error);
		const flushAssistant = (partTime = timestamp) => {
			if (pending.length === 0 && !errorMessage) {
				return;
			}
			messages.push(
				createAssistantMessage(pending, {
					api: "openai-completions",
					provider,
					model,
					timestamp: partTime,
					usage,
					stopReason: errorMessage ? "error" : finishReason(message.finish),
					errorMessage,
				}),
			);
			pending = [];
		};

		for (const part of parts) {
			const partTime = partTimestamp(part, timestamp);
			switch (asString(part.type)) {
				case "text": {
					const text = asString(part.text);
					if (text) {
						pending.push(textContent(text));
					}
					break;
				}
				case "reasoning": {
					const reasoning = asString(part.text);
					if (reasoning) {
						pending.push(thinkingContent(reasoning));
					}
					break;
				}
				case "tool": {
					const callId = asString(part.callID);
					const toolName = asString(part.tool);
					const state = asRecord(part.state);
					if (!callId || !toolName || !state) {
						break;
					}
					pending.push(toolCallContent(callId, toolName, state.input));
					flushAssistant(partTime);
					const status = asString(state.status);
					if (status === "completed" || status === "error") {
						const output = status === "error" ? asString(state.error) : asString(state.output);
						messages.push(
							createToolResultMessage(
								callId,
								toolName,
								[textContent(output ?? "(No tool output)")],
								status === "error",
								parseTimestamp(asRecord(state.time)?.end, partTime),
							),
						);
					}
					break;
				}
			}
		}
		flushAssistant();
	}

	const sanitized = sanitizeImportedMessages(messages);
	if (sanitized.length === 0) {
		return undefined;
	}
	return {
		source: "opencode",
		sourceId: session.id,
		cwd: session.directory ?? "",
		title: session.title?.trim() || deriveSessionTitle(sanitized),
		createdAt: parseTimestamp(session.time_created),
		messages: sanitized,
	};
}

function runOpenCode(command: string, args: string[], cwd: string, timeout: number): string | undefined {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, NO_COLOR: "1" },
		maxBuffer: 64 * 1024 * 1024,
		shell: shouldUseWindowsShell(command),
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
	});
	return result.status === 0 ? result.stdout.trim() : undefined;
}

export function listOpenCodeCliSessionIds(command: string, cwd: string): string[] | undefined {
	const output = runOpenCode(command, ["session", "list", "--format", "json", "--pure"], cwd, 5_000);
	if (!output) {
		return undefined;
	}
	try {
		return asArray(JSON.parse(output) as unknown)
			.map((value) => asString(asRecord(value)?.id))
			.filter((id): id is string => id !== undefined);
	} catch {
		return undefined;
	}
}

export async function parseOpenCodeCliSession(
	command: string,
	cwd: string,
	sessionId: string,
): Promise<ImportedSession | undefined> {
	const output = runOpenCode(command, ["export", sessionId, "--pure"], cwd, 30_000);
	if (!output) {
		return undefined;
	}
	const exported = asRecord(JSON.parse(output) as unknown);
	const info = asRecord(exported?.info);
	const id = asString(info?.id) ?? sessionId;
	const time = asRecord(info?.time);
	const records = asArray(exported?.messages)
		.map((value): OpenCodeMessageRecord | undefined => {
			const record = asRecord(value);
			const message = asRecord(record?.info);
			if (!message) {
				return undefined;
			}
			return {
				message,
				parts: asArray(record?.parts)
					.map(asRecord)
					.filter((part): part is Record<string, unknown> => part !== undefined),
			};
		})
		.filter((record): record is OpenCodeMessageRecord => record !== undefined);
	return convertOpenCodeSession(
		{
			id,
			directory: asString(info?.directory),
			title: asString(info?.title),
			time_created: parseTimestamp(time?.created),
		},
		records,
	);
}

function queryRows<T>(database: NodeDatabaseSync, sql: string, ...params: (string | number)[]): T[] {
	return database.prepare(sql).all(...params) as T[];
}

export function listOpenCodeSessionIds(databasePath: string): string[] {
	const database = openDatabase(databasePath);
	try {
		const tables = queryRows<{ name: string }>(
			database,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part')",
		);
		if (new Set(tables.map((row) => row.name)).size !== 3) {
			return [];
		}
		try {
			return queryRows<{ id: string }>(
				database,
				"SELECT id FROM session WHERE parent_id IS NULL ORDER BY time_updated, id",
			).map((row) => row.id);
		} catch {
			return queryRows<{ id: string }>(database, "SELECT id FROM session ORDER BY time_updated, id").map(
				(row) => row.id,
			);
		}
	} finally {
		database.close();
	}
}

export async function parseOpenCodeSession(
	databasePath: string,
	sessionId: string,
): Promise<ImportedSession | undefined> {
	const database = openDatabase(databasePath);
	try {
		const session = database
			.prepare("SELECT id, directory, title, time_created FROM session WHERE id = ?")
			.get(sessionId) as OpenCodeSessionRow | undefined;
		if (!session) {
			return undefined;
		}

		const records: OpenCodeMessageRecord[] = [];
		const messageRows = queryRows<MessageDataRow>(
			database,
			"SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id",
			sessionId,
		);
		for (const row of messageRows) {
			const message = parseData(row.data);
			const messageId = row.id;
			const role = asString(message?.role);
			if (!message || !messageId || (role !== "user" && role !== "assistant")) {
				continue;
			}
			const parts = queryRows<JsonDataRow>(
				database,
				"SELECT data FROM part WHERE session_id = ? AND message_id = ? ORDER BY time_created, id",
				sessionId,
				messageId,
			)
				.map((part) => parseData(part.data))
				.filter((part): part is Record<string, unknown> => part !== undefined);
			records.push({ message, parts });
		}
		return convertOpenCodeSession(session, records);
	} finally {
		database.close();
	}
}
