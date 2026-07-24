import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { v5 as uuidv5 } from "uuid";
import { readFirstLineSync } from "../../utils/file-lines.js";
import {
	buildSessionContext,
	type FileEntry,
	loadEntriesFromFile,
	type SessionHeader,
	SessionManager,
	type SessionStateStatus,
} from "../session-manager.js";
import type { ImportedSession, SessionImportSource } from "./types.js";

export function sessionImportKey(source: SessionImportSource, sourceId: string, contentHash: string): string {
	return `${source}\0${sourceId}\0${contentHash}`;
}

export function collectImportedSessionKeys(sessionDir: string): Set<string> {
	const keys = new Set<string>();
	let files: string[];
	try {
		files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl"));
	} catch {
		return keys;
	}

	for (const file of files) {
		try {
			const firstLine = readFirstLineSync(join(sessionDir, file));
			if (!firstLine) {
				continue;
			}
			const header = JSON.parse(firstLine) as Partial<SessionHeader>;
			const source = header.importedFrom?.source;
			const id = header.importedFrom?.id;
			const contentHash = header.importedFrom?.contentHash;
			if (source && id && contentHash) {
				keys.add(sessionImportKey(source as SessionImportSource, id, contentHash));
			}
		} catch {
			// Unreadable sessions cannot contribute a reliable deduplication key.
		}
	}
	return keys;
}

function sourceTimestamp(message: unknown): string {
	const timestampValue =
		typeof message === "object" && message !== null && "timestamp" in message
			? (message as { timestamp?: unknown }).timestamp
			: undefined;
	const timestamp =
		typeof timestampValue === "number" && Number.isFinite(timestampValue) ? timestampValue : Date.now();
	return new Date(timestamp).toISOString();
}

function importedSessionId(session: ImportedSession, contentHash: string): string {
	return uuidv5(`prime-agent-import:${session.source}:${session.sourceId}:${contentHash}`, uuidv5.URL);
}

export function importedSessionPath(session: ImportedSession, contentHash: string, sessionDir: string): string {
	return join(sessionDir, `${importedSessionId(session, contentHash)}.jsonl`);
}

function buildImportedEntries(
	session: ImportedSession,
	contentHash: string,
	fallbackCwd: string,
	status: SessionStateStatus,
): FileEntry[] {
	const manager = SessionManager.inMemory(session.cwd || fallbackCwd);
	for (const message of session.messages) {
		manager.appendMessage(message);
	}
	if (session.title) {
		manager.appendSessionInfo(session.title);
	}
	manager.appendSessionState({ status });

	const originalHeader = manager.getHeader();
	if (!originalHeader) {
		throw new Error("Unable to create imported session header");
	}
	const header: SessionHeader = {
		...originalHeader,
		id: importedSessionId(session, contentHash),
		timestamp: new Date(session.createdAt).toISOString(),
		importedFrom: {
			source: session.source,
			id: session.sourceId,
			contentHash,
		},
	};
	const lastMessageTimestamp = session.messages.reduce(
		(latest, message) => Math.max(latest, Number.isFinite(message.timestamp) ? message.timestamp : 0),
		session.createdAt,
	);
	const metadataTimestamp = new Date(lastMessageTimestamp).toISOString();
	const entries = manager.getEntries().map((entry) => {
		if (entry.type === "message") {
			return { ...entry, timestamp: sourceTimestamp(entry.message) };
		}
		if (entry.type === "session_info" || entry.type === "session_state") {
			return { ...entry, timestamp: metadataTimestamp };
		}
		return entry;
	});
	return [header, ...entries];
}

export function persistImportedSession(
	session: ImportedSession,
	contentHash: string,
	sessionDir: string,
	fallbackCwd: string,
	status: SessionStateStatus = "archived",
): string {
	mkdirSync(sessionDir, { recursive: true });
	const entries = buildImportedEntries(session, contentHash, fallbackCwd, status);
	const sessionId = importedSessionId(session, contentHash);
	const destination = importedSessionPath(session, contentHash, sessionDir);
	if (existsSync(destination)) {
		throw new Error(`Session destination already exists: ${destination}`);
	}

	const temporary = join(sessionDir, `.${sessionId}.import-${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		const loaded = loadEntriesFromFile(temporary);
		if (loaded.length !== entries.length || loaded[0]?.type !== "session") {
			throw new Error("Imported session failed validation");
		}
		const context = buildSessionContext(loaded.slice(1).filter((entry) => entry.type !== "session"));
		if (context.messages.length !== session.messages.length) {
			throw new Error("Imported session message count changed during validation");
		}
		linkSync(temporary, destination);
		unlinkSync(temporary);
		return destination;
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
