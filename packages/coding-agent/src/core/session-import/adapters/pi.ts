import type { Message } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	loadEntriesFromFile,
	migrateSessionEntries,
	type SessionHeader,
	type SessionInfoEntry,
} from "../../session-manager.js";
import { deriveSessionTitle, sanitizeImportedMessages } from "../shared.js";
import type { ImportedSession } from "../types.js";

function isMessage(value: unknown): value is Message {
	if (typeof value !== "object" || value === null || !("role" in value)) {
		return false;
	}
	const role = (value as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

export async function parsePiSession(filePath: string): Promise<ImportedSession | undefined> {
	const entries = loadEntriesFromFile(filePath);
	if (entries.length === 0 || entries[0]?.type !== "session") {
		return undefined;
	}
	migrateSessionEntries(entries);
	const header = entries[0] as SessionHeader;
	const sessionEntries = entries.slice(1).filter((entry) => entry.type !== "session");
	const context = buildSessionContext(sessionEntries);
	const messages = sanitizeImportedMessages(context.messages.filter(isMessage));
	if (messages.length === 0) {
		return undefined;
	}

	const titleEntry = [...sessionEntries]
		.reverse()
		.find((entry): entry is SessionInfoEntry => entry.type === "session_info" && !!entry.name?.trim());
	return {
		source: "pi",
		sourceId: header.id,
		cwd: header.cwd,
		title: titleEntry?.name?.trim() || deriveSessionTitle(messages),
		createdAt: Date.parse(header.timestamp) || Date.now(),
		messages,
	};
}
