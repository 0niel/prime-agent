import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getAgentDir, getSessionsDir } from "../../config.js";
import { SessionImportFileNotFoundError } from "../session-import-errors.js";
import { parseClaudeSession } from "./adapters/claude.js";
import { parseCodexSession } from "./adapters/codex.js";
import { parseOpenCodeExportFile } from "./adapters/opencode.js";
import { readJsonDocument, readJsonLinePrefix } from "./jsonl.js";
import { asArray, asRecord, asString, importedSessionContentHash } from "./shared.js";
import { importedSessionPath, persistImportedSession } from "./storage.js";
import type { SessionImportOptions } from "./types.js";

export type SessionImportFileKind = "native" | "claude" | "codex" | "opencode" | "unknown";
export type ExternalSessionImportFileKind = Exclude<SessionImportFileKind, "native" | "unknown">;

export interface ImportedExternalSessionFile {
	source: ExternalSessionImportFileKind;
	sessionFile: string;
	status: "imported" | "existing";
}

export async function detectSessionImportFileKind(filePath: string): Promise<SessionImportFileKind> {
	const resolvedPath = resolve(filePath);
	if (!existsSync(resolvedPath)) {
		throw new SessionImportFileNotFoundError(resolvedPath);
	}
	const values = await readJsonLinePrefix(resolvedPath, 100);
	for (const value of values) {
		const record = asRecord(value);
		const type = asString(record?.type);
		if (type === "session") {
			return "native";
		}
		if (
			record?.payload &&
			(type === "session_meta" || type === "turn_context" || type === "event_msg" || type === "response_item")
		) {
			return "codex";
		}
		if ((type === "user" || type === "assistant") && record?.message) {
			return "claude";
		}
	}
	const document = asRecord(await readJsonDocument(resolvedPath));
	if (asRecord(document?.info) && asArray(document?.messages).length > 0) {
		return "opencode";
	}
	return "unknown";
}

export async function importExternalSessionFile(
	filePath: string,
	source: ExternalSessionImportFileKind,
	options: SessionImportOptions = {},
): Promise<ImportedExternalSessionFile> {
	const resolvedPath = resolve(filePath);
	const session =
		source === "claude"
			? await parseClaudeSession(resolvedPath)
			: source === "codex"
				? await parseCodexSession(resolvedPath)
				: await parseOpenCodeExportFile(resolvedPath);
	if (!session) {
		const label = source === "claude" ? "Claude Code" : source === "codex" ? "Codex" : "OpenCode";
		throw new Error(`No importable ${label} messages found`);
	}

	const agentDir = options.agentDir ?? getAgentDir();
	const sessionDir = getSessionsDir(agentDir);
	const contentHash = importedSessionContentHash(session);
	const sessionFile = importedSessionPath(session, contentHash, sessionDir);
	if (existsSync(sessionFile)) {
		return { source, sessionFile, status: "existing" };
	}

	persistImportedSession(session, contentHash, sessionDir, options.cwd ?? process.cwd(), "active");
	return { source, sessionFile, status: "imported" };
}
