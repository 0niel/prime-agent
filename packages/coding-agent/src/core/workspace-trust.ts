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
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import lockfile from "proper-lockfile";
import { CONFIG_DIR_NAME } from "../config.js";

const TRUST_FILE_NAME = "trusted-workspaces.json";

/**
 * Project settings keys that turn committed config into executed commands or
 * auto-loaded resources. Used for detection and documentation; enforcement
 * lives in SettingsManager and DefaultPackageManager.
 */
export const RISKY_PROJECT_SETTINGS_KEYS = [
	"extensions",
	"skills",
	"prompts",
	"themes",
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
		// The path does not exist: canonicalize the nearest existing ancestor so
		// symlinked prefixes still resolve consistently with existing paths.
		const missing: string[] = [];
		let current = resolved;
		while (true) {
			const parent = dirname(current);
			if (parent === current) {
				return resolved;
			}
			missing.unshift(basename(current));
			current = parent;
			try {
				return join(realpathSync.native(current), ...missing);
			} catch {
				// Keep walking up.
			}
		}
	}
}

/**
 * Whether `target` lies inside the project's committed config directory.
 * Guards against portable setups that point the global agent dir into the
 * workspace: such "global" files are project-controlled and must not be
 * treated as trusted user configuration.
 */
export function isWithinProjectConfigDir(target: string, cwd: string): boolean {
	const root = canonicalizeWorkspacePath(join(cwd, CONFIG_DIR_NAME));
	const resolved = canonicalizeWorkspacePath(target);
	return resolved === root || resolved.startsWith(root + sep);
}

/**
 * Whether the project's config directory is the user's own global config
 * directory (home-directory cwd with the default agent dir). Those files are
 * the user's own configuration, not checkout-controlled content, so the
 * aliasing guards must not treat them as hostile.
 */
export function isProjectConfigDirTheUserGlobalDir(cwd: string): boolean {
	return (
		canonicalizeWorkspacePath(join(cwd, CONFIG_DIR_NAME)) ===
		canonicalizeWorkspacePath(join(homedir(), CONFIG_DIR_NAME))
	);
}

interface WorkspaceTrustFile {
	version: 1;
	trusted: string[];
}

function readTrustFile(filePath: string): Set<string> {
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
	return trusted;
}

export class WorkspaceTrustStore {
	private constructor(
		private readonly filePath: string,
		private trusted: Set<string>,
	) {}

	static create(agentDir: string): WorkspaceTrustStore {
		// Canonicalize so differently-spelled agent dirs (/tmp vs /private/tmp)
		// share one file and one lock path.
		const filePath = join(canonicalizeWorkspacePath(agentDir), TRUST_FILE_NAME);
		return new WorkspaceTrustStore(filePath, readTrustFile(filePath));
	}

	isTrusted(cwd: string): boolean {
		return this.trusted.has(canonicalizeWorkspacePath(cwd));
	}

	trust(cwd: string): void {
		const canonical = canonicalizeWorkspacePath(cwd);
		this.mutate((trusted) => {
			trusted.add(canonical);
		});
	}

	untrust(cwd: string): boolean {
		const canonical = canonicalizeWorkspacePath(cwd);
		let removed = false;
		this.mutate((trusted) => {
			removed = trusted.delete(canonical);
		});
		return removed;
	}

	list(): string[] {
		return [...this.trusted].sort();
	}

	/**
	 * Locked read-modify-write against the shared file. Re-reading under the
	 * lock keeps concurrent processes from clobbering each other's trust and
	 * untrust operations with stale snapshots.
	 */
	private mutate(apply: (trusted: Set<string>) => void): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		this.ensureFileExists();
		const release = this.acquireLock();
		try {
			const trusted = readTrustFile(this.filePath);
			apply(trusted);
			this.writeFile(trusted);
			this.trusted = trusted;
		} finally {
			release();
		}
	}

	/**
	 * Create the store file for lock acquisition without ever clobbering
	 * committed content: linkSync fails atomically when another process won
	 * the create race, and the winner's file stands.
	 */
	private ensureFileExists(): void {
		if (existsSync(this.filePath)) {
			return;
		}
		const tmpPath = `${this.filePath}.${process.pid}.tmp`;
		const empty: WorkspaceTrustFile = { version: 1, trusted: [] };
		writeFileSync(tmpPath, `${JSON.stringify(empty, null, 2)}\n`, "utf-8");
		try {
			linkSync(tmpPath, this.filePath);
		} catch {
			// Lost the create race, or hard links are unsupported here.
		}
		if (!existsSync(this.filePath)) {
			// Hard links unsupported: move the staging file instead.
			try {
				renameSync(tmpPath, this.filePath);
			} catch {
				// Another writer won in the meantime.
			}
		}
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// Best effort.
		}
		if (!existsSync(this.filePath)) {
			throw new Error(`Failed to create workspace trust store at ${this.filePath}`);
		}
	}

	private writeFile(trusted: Set<string>): void {
		const contents: WorkspaceTrustFile = { version: 1, trusted: [...trusted].sort() };
		// Per-process tmp name: concurrent first-writers must not rename each
		// other's staging file out from under themselves.
		const tmpPath = `${this.filePath}.${process.pid}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(contents, null, 2)}\n`, "utf-8");
		renameSync(tmpPath, this.filePath);
	}

	private acquireLock(): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(this.filePath, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}
		throw (lastError as Error) ?? new Error("Failed to acquire workspace trust lock");
	}
}

/**
 * Whether trust for this workspace can persist outside the workspace itself.
 * A trust store inside the workspace tree is checkout-controlled content: a
 * repository could commit `trusted-workspaces.json` and trust itself.
 */
export function canPersistWorkspaceTrust(cwd: string, agentDir: string): boolean {
	const canonicalCwd = canonicalizeWorkspacePath(cwd);
	const storePath = join(canonicalizeWorkspacePath(agentDir), TRUST_FILE_NAME);
	return storePath !== canonicalCwd && !storePath.startsWith(canonicalCwd + sep);
}

/**
 * Convenience for one-off checks at call sites that do not keep a store
 * around. Fail-closed when the store would live inside the workspace.
 */
export function isWorkspaceTrusted(cwd: string, agentDir: string): boolean {
	if (!canPersistWorkspaceTrust(cwd, agentDir)) {
		return false;
	}
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

interface PiManifestLike {
	extensions?: string[];
}

function readPiManifest(packageJsonPath: string): PiManifestLike | null {
	try {
		const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as { pi?: PiManifestLike };
		return pkg.pi ?? null;
	} catch {
		return null;
	}
}

/** Mirrors the discovery rules of DefaultPackageManager's extension collection. */
function hasExtensionEntry(dir: string): boolean {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifest(packageJsonPath);
		if (manifest?.extensions?.some((entry) => existsSync(resolve(dir, entry)))) {
			return true;
		}
	}
	return existsSync(join(dir, "index.ts")) || existsSync(join(dir, "index.js"));
}

function countExtensionEntries(extensionsDir: string): number {
	// The extensions directory itself may be a package (pi.extensions manifest
	// or index file), in which case its contents are not scanned individually.
	if (hasExtensionEntry(extensionsDir)) {
		return 1;
	}
	let entries: Dirent[];
	try {
		entries = readdirSync(extensionsDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	let count = 0;
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "package.json") continue;
		const fullPath = join(extensionsDir, entry.name);
		// Symlinks are followed like the loader does.
		let isFile = entry.isFile();
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(fullPath);
				isFile = stats.isFile();
				isDir = stats.isDirectory();
			} catch {
				continue;
			}
		}
		if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
			count++;
		} else if (isDir && hasExtensionEntry(fullPath)) {
			count++;
		}
	}
	return count;
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return null;
		}
		dir = parent;
	}
}

/** Mirrors DefaultPackageManager's ancestor `.agents/skills` discovery (cwd up to the git root). */
function collectAncestorAgentsSkillDirs(cwd: string): string[] {
	const dirs: string[] = [];
	const gitRepoRoot = findGitRepoRoot(cwd);
	const userAgentsSkillsDir = join(homedir(), ".agents", "skills");
	let dir = resolve(cwd);
	while (true) {
		const candidate = join(dir, ".agents", "skills");
		if (resolve(candidate) !== resolve(userAgentsSkillsDir)) {
			dirs.push(candidate);
		}
		if (gitRepoRoot && dir === gitRepoRoot) {
			break;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
	}
	return dirs;
}

/**
 * Synchronously detect project-committed configuration that workspace trust
 * gates. Used for the interactive consent prompt; the enforcement itself
 * lives in SettingsManager/DefaultPackageManager/DefaultResourceLoader.
 */
export function detectProjectScopedConfig(cwd: string): ProjectScopedConfigFinding[] {
	const findings: ProjectScopedConfigFinding[] = [];
	// Running from the home directory: the "project" config dir is the user's
	// own global one; there is nothing checkout-controlled to report.
	if (isProjectConfigDirTheUserGlobalDir(cwd)) {
		return findings;
	}
	const configDir = join(cwd, CONFIG_DIR_NAME);

	const extensionCount = countExtensionEntries(join(configDir, "extensions"));
	if (extensionCount > 0) {
		findings.push({
			path: join(configDir, "extensions"),
			summary: `project extensions (${extensionCount} ${extensionCount === 1 ? "entry" : "entries"}) execute automatically at session start`,
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

	for (const ancestorSkillsDir of collectAncestorAgentsSkillDirs(cwd)) {
		if (isNonEmptyDirectory(ancestorSkillsDir)) {
			findings.push({
				path: ancestorSkillsDir,
				summary: ".agents/skills is auto-discovered (Python skills install code into the agent kernel environment)",
			});
		}
	}

	for (const [dirName, label] of [
		["prompts", "prompt templates"],
		["themes", "themes"],
	] as const) {
		const dir = join(configDir, dirName);
		if (isNonEmptyDirectory(dir)) {
			findings.push({
				path: dir,
				summary: `project ${label} are auto-discovered`,
			});
		}
	}

	return findings;
}
