/**
 * Workspace trust: gates project-committed executable configuration behind
 * explicit user consent.
 *
 * A repository can commit `.prime/agent/extensions/*.ts` (auto-executed via
 * jiti at session start), `.prime/agent/settings.json` keys that turn into
 * executed commands (shellCommandPrefix, shellPath, npmCommand, mcpServers
 * stdio entries, package sources), Python skills (pip-installed into the
 * kernel venv and imported), and SYSTEM.md/APPEND_SYSTEM.md (auto-injected
 * into the system prompt). Loading any of that from a cloned, uninspected
 * repository is a drive-by code-execution vector, so project-scoped
 * configuration only applies to directories the user has explicitly trusted.
 *
 * Trust state lives in `<agentDir>/trusted-workspaces.json` and is shared by
 * every process on this machine (CLI client, daemon workers, SDK hosts).
 */

import type { Dirent } from "node:fs";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";

const TRUST_FILE_NAME = "trusted-workspaces.json";

/** Project settings keys that can turn committed config into executed commands. */
export const RISKY_PROJECT_SETTINGS_KEYS = [
	"extensions",
	"skills",
	"packages",
	"mcpServers",
	"shellCommandPrefix",
	"shellPath",
	"npmCommand",
	"sessionDir",
] as const;

/** Canonicalize a workspace path so trust entries survive symlinks (e.g. /tmp on macOS). */
export function canonicalizeWorkspacePath(path: string): string {
	const resolved = resolve(path);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

interface WorkspaceTrustFile {
	version: 1;
	trusted: string[];
}

export class WorkspaceTrustStore {
	private constructor(
		private readonly filePath: string,
		private readonly trusted: Set<string>,
	) {}

	static create(agentDir: string): WorkspaceTrustStore {
		const filePath = join(agentDir, TRUST_FILE_NAME);
		const trusted = new Set<string>();
		try {
			const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<WorkspaceTrustFile>;
			if (Array.isArray(parsed.trusted)) {
				for (const entry of parsed.trusted) {
					if (typeof entry === "string") {
						trusted.add(entry);
					}
				}
			}
		} catch {
			// Missing or unreadable trust file means nothing is trusted.
		}
		return new WorkspaceTrustStore(filePath, trusted);
	}

	isTrusted(cwd: string): boolean {
		return this.trusted.has(canonicalizeWorkspacePath(cwd));
	}

	trust(cwd: string): void {
		this.trusted.add(canonicalizeWorkspacePath(cwd));
		this.save();
	}

	untrust(cwd: string): boolean {
		const removed = this.trusted.delete(canonicalizeWorkspacePath(cwd));
		if (removed) {
			this.save();
		}
		return removed;
	}

	list(): string[] {
		return [...this.trusted].sort();
	}

	private save(): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const contents: WorkspaceTrustFile = { version: 1, trusted: this.list() };
		const tmpPath = `${this.filePath}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
		renameSync(tmpPath, this.filePath);
	}
}

/** Convenience for one-off checks at call sites that do not keep a store around. */
export function isWorkspaceTrusted(cwd: string, agentDir: string): boolean {
	return WorkspaceTrustStore.create(agentDir).isTrusted(cwd);
}

export interface ProjectScopedConfigFinding {
	path: string;
	summary: string;
}

function isNonEmptyDirectory(dir: string): boolean {
	try {
		return statSync(dir).isDirectory() && readdirSync(dir).some((entry) => !entry.startsWith("."));
	} catch {
		return false;
	}
}

function collectExtensionFiles(dir: string): string[] {
	const files: string[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return files;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			files.push(join(dir, entry.name));
		} else if (entry.isDirectory()) {
			for (const indexName of ["index.ts", "index.js"]) {
				const indexPath = join(dir, entry.name, indexName);
				if (existsSync(indexPath)) {
					files.push(indexPath);
					break;
				}
			}
		}
	}
	return files;
}

/**
 * Synchronously detect project-committed configuration that workspace trust
 * gates. Used for the interactive consent prompt and headless notices; the
 * enforcement itself lives in SettingsManager/DefaultPackageManager.
 */
export function detectProjectScopedConfig(cwd: string): ProjectScopedConfigFinding[] {
	const findings: ProjectScopedConfigFinding[] = [];
	const configDir = join(cwd, CONFIG_DIR_NAME);

	const extensionFiles = collectExtensionFiles(join(configDir, "extensions"));
	if (extensionFiles.length > 0) {
		findings.push({
			path: join(configDir, "extensions"),
			summary: `project extensions (${extensionFiles.length} file${extensionFiles.length === 1 ? "" : "s"}) execute automatically at session start`,
		});
	}

	const settingsPath = join(configDir, "settings.json");
	try {
		const projectSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
		const riskyKeys = RISKY_PROJECT_SETTINGS_KEYS.filter((key) => projectSettings[key] !== undefined);
		if (riskyKeys.length > 0) {
			findings.push({
				path: settingsPath,
				summary: `project settings.json sets ${riskyKeys.join(", ")}`,
			});
		}
	} catch {
		// No readable project settings.
	}

	for (const fileName of ["SYSTEM.md", "APPEND_SYSTEM.md"]) {
		const promptPath = join(configDir, fileName);
		if (existsSync(promptPath)) {
			findings.push({
				path: promptPath,
				summary: `project ${fileName} is injected into the system prompt`,
			});
		}
	}

	const skillsDir = join(configDir, "skills");
	if (isNonEmptyDirectory(skillsDir)) {
		findings.push({
			path: skillsDir,
			summary: "project skills are auto-discovered (Python skills install code into the agent kernel environment)",
		});
	}

	const agentsSkillsDir = join(cwd, ".agents", "skills");
	if (isNonEmptyDirectory(agentsSkillsDir)) {
		findings.push({
			path: agentsSkillsDir,
			summary: ".agents/skills is auto-discovered (Python skills install code into the agent kernel environment)",
		});
	}

	return findings;
}
