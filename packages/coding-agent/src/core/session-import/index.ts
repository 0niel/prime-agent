import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir, getSessionsDir } from "../../config.js";
import { readFirstLineSync } from "../../utils/file-lines.js";
import { parseClaudeSession } from "./adapters/claude.js";
import { parseCodexSession } from "./adapters/codex.js";
import {
	listOpenCodeCliSessions,
	listOpenCodeSessions,
	parseOpenCodeCliSession,
	parseOpenCodeSession,
} from "./adapters/opencode.js";
import { parsePiSession } from "./adapters/pi.js";
import { importedSessionContentHash } from "./shared.js";
import { discoverSkillDirectories, importSkillDirectory } from "./skills.js";
import { collectImportedSessionKeys, persistImportedSession, sessionImportKey } from "./storage.js";
import {
	type ImportedSession,
	SESSION_IMPORT_SOURCES,
	type SessionImportInventory,
	type SessionImportOptions,
	type SessionImportReference,
	type SessionImportResult,
	type SessionImportSource,
	type SessionImportSourceResult,
} from "./types.js";

export {
	detectSessionImportFileKind,
	type ExternalSessionImportFileKind,
	type ImportedExternalSessionFile,
	importExternalSessionFile,
	type SessionImportFileKind,
} from "./file.js";
export type {
	SessionImportInventory,
	SessionImportOptions,
	SessionImportResult,
	SessionImportSource,
	SessionImportSourceResult,
} from "./types.js";
export { SESSION_IMPORT_SOURCES } from "./types.js";

const SOURCE_LABELS: Record<SessionImportSource, string> = {
	claude: "Claude Code",
	codex: "Codex",
	opencode: "OpenCode",
	pi: "Pi",
};
const MAX_RECENT_SESSIONS = 50;
const MAX_SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface JsonlSearchRoot {
	path: string;
	recursive: boolean;
	excludeDirectory?: (name: string) => boolean;
	includeFile?: (path: string) => boolean;
}

interface RecentFile {
	path: string;
	modifiedAt: number;
}

function listRecentJsonlFiles(roots: JsonlSearchRoot[], cutoff: number): string[] {
	const files = new Map<string, RecentFile>();
	const addFile = (path: string) => {
		try {
			const modifiedAt = statSync(path).mtimeMs;
			if (modifiedAt >= cutoff) {
				const normalized = resolve(path);
				files.set(normalized, { path: normalized, modifiedAt });
			}
		} catch {
			// Files can disappear or become unreadable while discovery is scanning.
		}
	};
	const visit = (root: JsonlSearchRoot, directory: string) => {
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isSymbolicLink()) {
				continue;
			}
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				if (root.recursive && !root.excludeDirectory?.(entry.name)) {
					visit(root, path);
				}
			} else if (entry.isFile() && entry.name.endsWith(".jsonl") && (root.includeFile?.(path) ?? true)) {
				addFile(path);
			}
		}
	};
	for (const root of roots) {
		visit(root, root.path);
	}
	return [...files.values()]
		.sort((a, b) => b.modifiedAt - a.modifiedAt || a.path.localeCompare(b.path))
		.slice(0, MAX_RECENT_SESSIONS)
		.map((file) => file.path);
}

function fileReferences(paths: string[]): SessionImportReference[] {
	return paths.map((path) => ({ kind: "file", path }));
}

function isTopLevelCodexSession(path: string): boolean {
	try {
		const firstLine = readFirstLineSync(path, 1024 * 1024);
		if (!firstLine) {
			return false;
		}
		const entry = JSON.parse(firstLine) as {
			type?: unknown;
			payload?: { thread_source?: unknown; source?: unknown };
		};
		if (entry.type !== "session_meta" || !entry.payload) {
			return false;
		}
		if (entry.payload.thread_source === "subagent") {
			return false;
		}
		const source = entry.payload.source;
		return !(typeof source === "object" && source !== null && "subagent" in source);
	} catch {
		return false;
	}
}

function uniqueExistingDirectories(paths: string[]): string[] {
	const seen = new Set<string>();
	return paths.filter((path) => {
		const normalized = resolve(path);
		if (seen.has(normalized) || !existsSync(normalized)) {
			return false;
		}
		seen.add(normalized);
		return true;
	});
}

function makeInventory(
	source: SessionImportSource,
	sessionReferences: SessionImportReference[],
	skillRoots: string[],
): SessionImportInventory | undefined {
	const skillDirectories = uniqueExistingDirectories(skillRoots).flatMap(discoverSkillDirectories);
	if (sessionReferences.length === 0 && skillDirectories.length === 0) {
		return undefined;
	}
	return {
		source,
		label: SOURCE_LABELS[source],
		sessionCount: sessionReferences.length,
		skillCount: skillDirectories.length,
		sessionReferences,
		skillDirectories,
	};
}

function discoverOpenCodeReferences(
	home: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
	cutoff: number,
): SessionImportReference[] {
	const configuredDataDirectories = env.OPENCODE_DATA_HOME
		? [env.OPENCODE_DATA_HOME]
		: env.XDG_DATA_HOME
			? [join(env.XDG_DATA_HOME, "opencode")]
			: [];
	const candidates = uniqueExistingDirectories([
		...configuredDataDirectories,
		join(home, ".local", "share", "opencode"),
		join(home, "Library", "Application Support", "opencode"),
	])
		.map((directory) => join(directory, "opencode.db"))
		.filter(existsSync);

	const candidatesById = new Map<string, { id: string; reference: SessionImportReference; modifiedAt: number }>();
	for (const databasePath of candidates) {
		try {
			for (const session of listOpenCodeSessions(databasePath, cutoff, MAX_RECENT_SESSIONS)) {
				const existing = candidatesById.get(session.id);
				if (!existing || session.modifiedAt > existing.modifiedAt) {
					candidatesById.set(session.id, {
						id: session.id,
						reference: { kind: "opencode", databasePath, sessionId: session.id },
						modifiedAt: session.modifiedAt,
					});
				}
			}
		} catch {
			// A bad database should not prevent trying the remaining OpenCode locations.
		}
	}
	if (candidatesById.size > 0) {
		return [...candidatesById.values()]
			.sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id))
			.slice(0, MAX_RECENT_SESSIONS)
			.map((candidate) => candidate.reference);
	}

	const commands = [
		env.OPENCODE_BIN,
		join(home, ".opencode", "bin", process.platform === "win32" ? "opencode.exe" : "opencode"),
		"opencode",
	].filter((command): command is string => !!command);
	for (const command of commands) {
		const sessions = listOpenCodeCliSessions(command, cwd, cutoff, MAX_RECENT_SESSIONS);
		if (!sessions || sessions.length === 0) {
			continue;
		}
		return sessions.map((session) => ({ kind: "opencode-cli", command, cwd, sessionId: session.id }));
	}
	return [];
}

export function discoverSessionImports(options: SessionImportOptions = {}): SessionImportInventory[] {
	const home = options.homeDir ?? homedir();
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	const cutoff = Date.now() - MAX_SESSION_AGE_MS;
	const claudeDir = resolve(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"));
	const codexDir = resolve(env.CODEX_HOME ?? join(home, ".codex"));
	const piDir = resolve(env.PI_CODING_AGENT_DIR ?? env.PI_AGENT_DIR ?? join(home, ".pi", "agent"));
	const configuredOpenCodeSkillDirectories = env.OPENCODE_CONFIG_DIR
		? [join(env.OPENCODE_CONFIG_DIR, "skills")]
		: env.XDG_CONFIG_HOME
			? [join(env.XDG_CONFIG_HOME, "opencode", "skills")]
			: [];

	const inventories = [
		makeInventory(
			"claude",
			fileReferences(
				listRecentJsonlFiles(
					[
						{
							path: join(claudeDir, "projects"),
							recursive: true,
							excludeDirectory: (name) => name === "subagents",
						},
					],
					cutoff,
				),
			),
			[join(claudeDir, "skills")],
		),
		makeInventory(
			"codex",
			fileReferences(
				listRecentJsonlFiles(
					[
						{ path: join(codexDir, "sessions"), recursive: true, includeFile: isTopLevelCodexSession },
						{ path: join(codexDir, "archived_sessions"), recursive: true, includeFile: isTopLevelCodexSession },
					],
					cutoff,
				),
			),
			[join(codexDir, "skills")],
		),
		makeInventory("opencode", discoverOpenCodeReferences(home, env, cwd, cutoff), [
			...configuredOpenCodeSkillDirectories,
			join(home, ".config", "opencode", "skills"),
			join(home, ".opencode", "skills"),
		]),
		resolve(piDir) === agentDir
			? undefined
			: makeInventory(
					"pi",
					fileReferences(
						listRecentJsonlFiles(
							[
								{ path: join(piDir, "sessions"), recursive: true },
								{ path: piDir, recursive: false },
							],
							cutoff,
						),
					),
					[join(piDir, "skills")],
				),
	];
	return inventories.filter((inventory): inventory is SessionImportInventory => inventory !== undefined);
}

async function parseSessionReference(
	source: SessionImportSource,
	reference: SessionImportReference,
): Promise<ImportedSession | undefined> {
	if (reference.kind === "opencode-cli") {
		return source === "opencode"
			? parseOpenCodeCliSession(reference.command, reference.cwd, reference.sessionId)
			: undefined;
	}
	if (reference.kind === "opencode") {
		return source === "opencode" ? parseOpenCodeSession(reference.databasePath, reference.sessionId) : undefined;
	}
	switch (source) {
		case "claude":
			return parseClaudeSession(reference.path);
		case "codex":
			return parseCodexSession(reference.path);
		case "pi":
			return parsePiSession(reference.path);
		case "opencode":
			return undefined;
	}
}

function emptySourceResult(source: SessionImportSource): SessionImportSourceResult {
	return {
		source,
		sessionsImported: 0,
		sessionsSkipped: 0,
		sessionFailures: 0,
		skillsImported: 0,
		skillsSkipped: 0,
		skillFailures: 0,
	};
}

function combineResults(sources: SessionImportSourceResult[]): SessionImportResult {
	return {
		sources,
		sessionsImported: sources.reduce((sum, result) => sum + result.sessionsImported, 0),
		sessionsSkipped: sources.reduce((sum, result) => sum + result.sessionsSkipped, 0),
		sessionFailures: sources.reduce((sum, result) => sum + result.sessionFailures, 0),
		skillsImported: sources.reduce((sum, result) => sum + result.skillsImported, 0),
		skillsSkipped: sources.reduce((sum, result) => sum + result.skillsSkipped, 0),
		skillFailures: sources.reduce((sum, result) => sum + result.skillFailures, 0),
	};
}

export async function importSessionsAndSkills(
	inventories: SessionImportInventory[],
	selectedSources: readonly SessionImportSource[],
	options: SessionImportOptions = {},
): Promise<SessionImportResult> {
	const agentDir = options.agentDir ?? getAgentDir();
	const fallbackCwd = options.cwd ?? process.cwd();
	const sessionDir = getSessionsDir(agentDir);
	const skillDir = join(agentDir, "skills");
	const selected = new Set(selectedSources);
	const importedKeys = collectImportedSessionKeys(sessionDir);
	const sourceResults: SessionImportSourceResult[] = [];

	for (const inventory of inventories) {
		if (!selected.has(inventory.source)) {
			continue;
		}
		const result = emptySourceResult(inventory.source);
		sourceResults.push(result);
		options.onProgress?.(`Importing ${inventory.label}...`);

		for (const reference of inventory.sessionReferences) {
			try {
				const session = await parseSessionReference(inventory.source, reference);
				if (!session) {
					result.sessionsSkipped++;
					continue;
				}
				const contentHash = importedSessionContentHash(session);
				const key = sessionImportKey(session.source, session.sourceId, contentHash);
				if (importedKeys.has(key)) {
					result.sessionsSkipped++;
					continue;
				}
				persistImportedSession(session, contentHash, sessionDir, fallbackCwd);
				importedKeys.add(key);
				result.sessionsImported++;
			} catch {
				result.sessionFailures++;
			}
		}

		for (const sourceSkillDir of inventory.skillDirectories) {
			try {
				const status = importSkillDirectory(sourceSkillDir, skillDir);
				if (status === "imported") {
					result.skillsImported++;
				} else {
					result.skillsSkipped++;
				}
			} catch {
				result.skillFailures++;
			}
		}
	}

	return combineResults(sourceResults);
}

export function formatSessionImportResult(result: SessionImportResult): string {
	const imported: string[] = [];
	if (result.sessionsImported > 0) {
		imported.push(`${result.sessionsImported} session${result.sessionsImported === 1 ? "" : "s"}`);
	}
	if (result.skillsImported > 0) {
		imported.push(`${result.skillsImported} skill${result.skillsImported === 1 ? "" : "s"}`);
	}
	const failures = result.sessionFailures + result.skillFailures;
	if (imported.length === 0) {
		return failures > 0
			? `No data imported; ${failures} item${failures === 1 ? "" : "s"} could not be read`
			: "No new data to import";
	}
	return `Imported ${imported.join(" and ")}${failures > 0 ? `; skipped ${failures} unreadable item${failures === 1 ? "" : "s"}` : ""}`;
}

export function orderedSelectedSources(sources: Iterable<SessionImportSource>): SessionImportSource[] {
	const selected = new Set(sources);
	return SESSION_IMPORT_SOURCES.filter((source) => selected.has(source));
}
