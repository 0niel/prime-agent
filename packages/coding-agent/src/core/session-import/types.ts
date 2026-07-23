import type { Message } from "@earendil-works/pi-ai";

export const SESSION_IMPORT_SOURCES = ["claude", "codex", "opencode", "pi"] as const;

export type SessionImportSource = (typeof SESSION_IMPORT_SOURCES)[number];

export interface SessionImportFileReference {
	kind: "file";
	path: string;
}

export interface OpenCodeSessionReference {
	kind: "opencode";
	databasePath: string;
	sessionId: string;
}

export interface OpenCodeCliSessionReference {
	kind: "opencode-cli";
	command: string;
	cwd: string;
	sessionId: string;
}

export type SessionImportReference =
	| SessionImportFileReference
	| OpenCodeSessionReference
	| OpenCodeCliSessionReference;

export interface SessionImportInventory {
	source: SessionImportSource;
	label: string;
	sessionCount: number;
	skillCount: number;
	sessionReferences: SessionImportReference[];
	skillDirectories: string[];
}

export interface ImportedSession {
	source: SessionImportSource;
	sourceId: string;
	cwd: string;
	title?: string;
	createdAt: number;
	messages: Message[];
}

export interface SessionImportSourceResult {
	source: SessionImportSource;
	sessionsImported: number;
	sessionsSkipped: number;
	sessionFailures: number;
	skillsImported: number;
	skillsSkipped: number;
	skillFailures: number;
}

export interface SessionImportResult {
	sources: SessionImportSourceResult[];
	sessionsImported: number;
	sessionsSkipped: number;
	sessionFailures: number;
	skillsImported: number;
	skillsSkipped: number;
	skillFailures: number;
}

export interface SessionImportOptions {
	homeDir?: string;
	agentDir?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	onProgress?: (message: string) => void;
}
