import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename } from "node:path";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import type { AssistantMessage, Message, TextContent, ThinkingContent, ToolCall, Usage } from "@earendil-works/pi-ai";
import { shouldUseWindowsShell } from "../../../utils/child-process.js";
import { readJsonDocument } from "../jsonl.js";
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

interface OpenCodeSessionListRow {
	id: string;
	timestamp?: number;
}

export interface OpenCodeSessionCandidate {
	id: string;
	modifiedAt: number;
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
		let usageEmitted = false;
		const provider = asString(message.providerID) ?? "opencode";
		const model = asString(message.modelID) ?? "opencode";
		const errorMessage = openCodeErrorMessage(message.error);
		let errorEmitted = false;
		const flushAssistant = (partTime = timestamp) => {
			if (pending.length === 0 && (!errorMessage || errorEmitted)) {
				return;
			}
			messages.push(
				createAssistantMessage(pending, {
					api: "openai-completions",
					provider,
					model,
					timestamp: partTime,
					usage: usageEmitted ? createZeroUsage() : usage,
					stopReason: errorMessage ? "error" : finishReason(message.finish),
					errorMessage,
				}),
			);
			usageEmitted = true;
			errorEmitted = !!errorMessage;
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

function parseOpenCodeExport(value: unknown, fallbackId: string): ImportedSession | undefined {
	const exported = asRecord(value);
	const info = asRecord(exported?.info);
	if (!info) {
		return undefined;
	}
	const id = asString(info.id) ?? fallbackId;
	const time = asRecord(info.time);
	const records = asArray(exported?.messages)
		.map((messageValue): OpenCodeMessageRecord | undefined => {
			const record = asRecord(messageValue);
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
			directory: asString(info.directory),
			title: asString(info.title),
			time_created: parseTimestamp(time?.created),
		},
		records,
	);
}

function openCodeListTimestamp(value: Record<string, unknown>): number {
	const time = asRecord(value.time);
	return parseTimestamp(
		time?.updated ??
			time?.created ??
			value.time_updated ??
			value.time_created ??
			value.updated ??
			value.created ??
			value.updatedAt ??
			value.updated_at ??
			value.createdAt ??
			value.created_at,
		0,
	);
}

export function listOpenCodeCliSessions(
	command: string,
	cwd: string,
	cutoff: number,
	limit: number,
): OpenCodeSessionCandidate[] | undefined {
	const output = runOpenCode(command, ["session", "list", "--format", "json", "--pure"], cwd, 5_000);
	if (!output) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(output) as unknown;
		const values = Array.isArray(parsed) ? parsed : asArray(asRecord(parsed)?.sessions);
		return values
			.map((value) => {
				const record = asRecord(value);
				const id = asString(record?.id);
				const timestamp = record ? openCodeListTimestamp(record) : 0;
				return id && timestamp >= cutoff ? { id, modifiedAt: timestamp } : undefined;
			})
			.filter((session): session is OpenCodeSessionCandidate => session !== undefined)
			.sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id))
			.slice(0, limit);
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
	try {
		return parseOpenCodeExport(JSON.parse(output) as unknown, sessionId);
	} catch {
		return undefined;
	}
}

export async function parseOpenCodeExportFile(filePath: string): Promise<ImportedSession | undefined> {
	return parseOpenCodeExport(await readJsonDocument(filePath), basename(filePath, ".json"));
}

function queryRows<T>(database: NodeDatabaseSync, sql: string, ...params: (string | number)[]): T[] {
	return database.prepare(sql).all(...params) as T[];
}

export function listOpenCodeSessions(databasePath: string, cutoff: number, limit: number): OpenCodeSessionCandidate[] {
	const database = openDatabase(databasePath);
	try {
		const tables = queryRows<{ name: string }>(
			database,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part')",
		);
		if (new Set(tables.map((row) => row.name)).size !== 3) {
			return [];
		}
		const columns = new Set(
			queryRows<{ name: string }>(database, "PRAGMA table_info(session)").map((column) => column.name),
		);
		const messageColumns = new Set(
			queryRows<{ name: string }>(database, "PRAGMA table_info(message)").map((column) => column.name),
		);
		const partColumns = new Set(
			queryRows<{ name: string }>(database, "PRAGMA table_info(part)").map((column) => column.name),
		);
		const timeColumn = columns.has("time_created")
			? "time_created"
			: columns.has("time_updated")
				? "time_updated"
				: "";
		if (!timeColumn) {
			return [];
		}
		const timestamps = [`COALESCE(s.${timeColumn}, 0)`];
		if (messageColumns.has("session_id") && messageColumns.has("time_created")) {
			timestamps.push("COALESCE((SELECT MAX(m.time_created) FROM message m WHERE m.session_id = s.id), 0)");
		}
		if (partColumns.has("session_id") && partColumns.has("time_created")) {
			timestamps.push("COALESCE((SELECT MAX(p.time_created) FROM part p WHERE p.session_id = s.id), 0)");
		}
		const timestampExpression = timestamps.length === 1 ? timestamps[0] : `MAX(${timestamps.join(", ")})`;
		const rootFilter = columns.has("parent_id") ? " WHERE parent_id IS NULL" : "";
		return queryRows<OpenCodeSessionListRow>(
			database,
			`SELECT s.id, ${timestampExpression} AS timestamp FROM session s${rootFilter}`,
		)
			.map((row) => ({ id: row.id, modifiedAt: parseTimestamp(row.timestamp, 0) }))
			.filter((session) => session.id && session.modifiedAt >= cutoff)
			.sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id))
			.slice(0, limit);
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
