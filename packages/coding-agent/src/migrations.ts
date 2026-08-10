/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import {
	chmodSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "fs";
import { basename, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir, getBinDir, getSessionsDir } from "./config.js";
import { FileAuthStorageBackend } from "./core/auth-storage.js";
import { migrateKeybindingsConfig } from "./core/keybindings.js";
import { FileSettingsStorage } from "./core/settings-manager.js";
import { resolveManagedFilePathSync, writeFileAtomicallySync } from "./utils/atomic-file.js";
import { readFirstLineSync } from "./utils/file-lines.js";

const MIGRATION_GUIDE_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md#extensions-migration";
const EXTENSIONS_DOC_URL =
	"https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md";

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

function isLockContention(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ELOCKED";
}

function cleanupCommittedLegacyAuth(
	agentDir: string,
	authPath: string,
	oauthPath: string,
	migratedOauthPath: string,
): void {
	let auth: Record<string, unknown>;
	try {
		const parsed = JSON.parse(readFileSync(authPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		auth = parsed as Record<string, unknown>;
	} catch {
		return;
	}

	try {
		new FileSettingsStorage(agentDir, agentDir).withLock("global", (current) => {
			if (!current) return undefined;
			const settings = JSON.parse(current) as { apiKeys?: unknown };
			if (typeof settings.apiKeys !== "object" || settings.apiKeys === null || Array.isArray(settings.apiKeys)) {
				return undefined;
			}
			const keys = settings.apiKeys as Record<string, unknown>;
			let changed = false;
			for (const [provider, key] of Object.entries(keys)) {
				const credential = auth[provider] as { type?: unknown; key?: unknown } | undefined;
				if (credential?.type === "api_key" && credential.key === key) {
					delete keys[provider];
					changed = true;
				}
			}
			if (!changed) return undefined;
			if (Object.keys(keys).length === 0) delete settings.apiKeys;
			return JSON.stringify(settings, null, 2);
		});
	} catch {
		// Authoritative auth exists; contended or invalid legacy settings are best-effort cleanup only.
	}

	if (!existsSync(oauthPath)) return;
	try {
		const parsed = JSON.parse(readFileSync(oauthPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
		const remaining = { ...(parsed as Record<string, unknown>) };
		let changed = false;
		for (const [provider, credential] of Object.entries(remaining)) {
			if (stableJson(auth[provider]) === stableJson({ type: "oauth", ...(credential as object) })) {
				delete remaining[provider];
				changed = true;
			}
		}
		if (!changed) return;
		if (Object.keys(remaining).length > 0) {
			writeFileAtomicallySync(oauthPath, JSON.stringify(remaining, null, 2), { mode: 0o600 });
		} else if (!existsSync(migratedOauthPath)) {
			renameSync(oauthPath, migratedOauthPath);
		} else {
			rmSync(oauthPath, { force: true });
		}
	} catch {
		// Leave newer or unreadable legacy OAuth data untouched.
	}
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	chmodSync(agentDir, 0o700);
	const configuredAuthPath = join(agentDir, "auth.json");
	const authPath = resolveManagedFilePathSync(configuredAuthPath, "auth");
	const oauthPath = join(agentDir, "oauth.json");
	const migratedOauthPath = `${oauthPath}.migrated`;
	if (existsSync(authPath)) {
		chmodSync(authPath, 0o600);
		cleanupCommittedLegacyAuth(agentDir, authPath, oauthPath, migratedOauthPath);
		return [];
	}
	let oauthSourcePath: string | undefined;
	let providers: string[] = [];
	let authCommitted = false;

	try {
		const settingsStorage = new FileSettingsStorage(agentDir, agentDir);
		settingsStorage.withLock(
			"global",
			(currentSettings) => {
				let settings: { apiKeys?: unknown } | undefined;
				const settingsApiKeys: Record<string, string> = {};
				if (currentSettings) {
					try {
						settings = JSON.parse(currentSettings) as { apiKeys?: unknown };
						if (
							typeof settings.apiKeys === "object" &&
							settings.apiKeys !== null &&
							!Array.isArray(settings.apiKeys)
						) {
							for (const [provider, key] of Object.entries(settings.apiKeys)) {
								if (typeof key === "string") {
									settingsApiKeys[provider] = key;
								}
							}
						}
					} catch {
						// Leave unreadable settings untouched.
					}
				}

				providers = new FileAuthStorageBackend(authPath).withLock((currentAuth) => {
					if (currentAuth !== undefined) {
						return { result: [] };
					}

					const migrated: Record<string, unknown> = {};
					const nextProviders: string[] = [];
					oauthSourcePath = existsSync(oauthPath)
						? oauthPath
						: existsSync(migratedOauthPath)
							? migratedOauthPath
							: undefined;
					if (oauthSourcePath) {
						try {
							const oauth = JSON.parse(readFileSync(oauthSourcePath, "utf-8")) as unknown;
							if (typeof oauth === "object" && oauth !== null && !Array.isArray(oauth)) {
								for (const [provider, credential] of Object.entries(oauth)) {
									migrated[provider] = { type: "oauth", ...(credential as object) };
									nextProviders.push(provider);
								}
							}
						} catch {
							// Leave an unreadable legacy file untouched.
						}
					}

					for (const [provider, key] of Object.entries(settingsApiKeys)) {
						if (!(provider in migrated)) {
							migrated[provider] = { type: "api_key", key };
							nextProviders.push(provider);
						}
					}

					if (nextProviders.length === 0) {
						return { result: [] };
					}
					return {
						result: nextProviders,
						next: JSON.stringify(migrated, null, 2),
					};
				});
				authCommitted = providers.length > 0;

				if (!authCommitted || !settings || Object.keys(settingsApiKeys).length === 0) {
					return undefined;
				}
				const currentApiKeys = settings.apiKeys as Record<string, unknown>;
				for (const [provider, migratedKey] of Object.entries(settingsApiKeys)) {
					if (currentApiKeys[provider] === migratedKey) {
						delete currentApiKeys[provider];
					}
				}
				if (Object.keys(currentApiKeys).length === 0) {
					delete settings.apiKeys;
				}
				return JSON.stringify(settings, null, 2);
			},
			{ lockIfMissing: true },
		);
	} catch (error) {
		let authoritativeAuth = authCommitted;
		try {
			const committedPath = resolveManagedFilePathSync(configuredAuthPath, "auth");
			authoritativeAuth ||= existsSync(committedPath);
			if (authoritativeAuth) cleanupCommittedLegacyAuth(agentDir, committedPath, oauthPath, migratedOauthPath);
		} catch {
			// Preserve the original failure when no authoritative regular auth file can be verified.
		}
		if (!authoritativeAuth && !isLockContention(error)) throw error;
		// Live lock contention and post-commit legacy cleanup are best-effort during startup.
	}

	if (providers.length === 0) return providers;

	if (oauthSourcePath === oauthPath && !existsSync(migratedOauthPath)) {
		try {
			renameSync(oauthPath, migratedOauthPath);
		} catch {
			// The committed auth file is authoritative; legacy cleanup is best-effort.
		}
	}

	return providers;
}

/**
 * Migrate sessions from ~/.pi/agent/*.jsonl to the session root.
 *
 * Bug in v0.30.0: Sessions were saved to ~/.pi/agent/ instead of
 * ~/.pi/agent/sessions/. This migration moves them to the configured
 * session root.
 *
 * See: https://github.com/earendil-works/pi-mono/issues/320
 */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	// Find all .jsonl files directly in agentDir (not in subdirectories)
	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	if (files.length === 0) return;

	for (const file of files) {
		try {
			// Read first line to get session header
			const firstLine = readFirstLineSync(file);
			if (!firstLine?.trim()) continue;

			const header = JSON.parse(firstLine);
			if (header.type !== "session") continue;

			const correctDir = getSessionsDir(agentDir);

			// Create directory if needed
			if (!existsSync(correctDir)) {
				mkdirSync(correctDir, { recursive: true });
			}

			// Move the file
			const newPath = join(correctDir, basename(file));

			if (existsSync(newPath)) continue; // Skip if target exists

			renameSync(file, newPath);
		} catch {
			// Skip files that can't be migrated
		}
	}
}

function isSessionJsonlFile(filePath: string): boolean {
	try {
		const firstLine = readFirstLineSync(filePath);
		if (!firstLine?.trim()) {
			return false;
		}
		const header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
		return header.type === "session" && typeof header.id === "string";
	} catch {
		return false;
	}
}

function isLegacySessionDirName(name: string): boolean {
	return /^--.+--$/.test(name);
}

/**
 * Migrate legacy per-cwd session directories into the flat session root.
 *
 * Older versions stored sessions under ~/.prime/agent/sessions/--cwd--/*.jsonl.
 * The daemon list/continue paths now scan the flat session root, so move any
 * existing nested JSONL session files up one level.
 */
export function migrateLegacySessionDirsToSessionRoot(): void {
	const agentDir = getAgentDir();
	const sessionsDir = getSessionsDir(agentDir);

	let entries: Dirent[];
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.isDirectory() || !isLegacySessionDirName(entry.name)) {
			continue;
		}

		const legacyDir = join(sessionsDir, entry.name);
		let files: string[];
		try {
			files = readdirSync(legacyDir).filter((file) => file.endsWith(".jsonl"));
		} catch {
			continue;
		}

		for (const file of files) {
			const oldPath = join(legacyDir, file);
			let newPath = join(sessionsDir, file);
			if (!isSessionJsonlFile(oldPath)) {
				continue;
			}
			if (existsSync(newPath)) {
				if (filesHaveSameContent(oldPath, newPath)) {
					// Already migrated; leave the legacy copy alone.
					continue;
				}
				// A different session shares the basename; move it under a unique name
				// so it stays discoverable by the flat-root list and continue paths.
				newPath = uniqueSessionRootPath(sessionsDir, file);
			}
			try {
				renameSync(oldPath, newPath);
			} catch {
				// Leave the legacy file in place if it cannot be moved.
			}
		}

		try {
			if (readdirSync(legacyDir).length === 0) {
				rmdirSync(legacyDir);
			}
		} catch {
			// Ignore cleanup errors; migrated files are already in the flat root.
		}
	}
}

function filesHaveSameContent(a: string, b: string): boolean {
	try {
		if (statSync(a).size !== statSync(b).size) {
			return false;
		}
		return readFileSync(a, "utf-8") === readFileSync(b, "utf-8");
	} catch {
		return false;
	}
}

function uniqueSessionRootPath(sessionsDir: string, file: string): string {
	const base = file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : file;
	for (let n = 1; ; n++) {
		const candidate = join(sessionsDir, `${base}-${n}.jsonl`);
		if (!existsSync(candidate)) {
			return candidate;
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
	} catch {
		// Ignore malformed files during migration
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by pi, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = join(cwd, CONFIG_DIR_NAME);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings and wait for keypress.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));
	console.log(chalk.dim(`\nPress any key to continue...`));

	await new Promise<void>((resolve) => {
		process.stdin.setRawMode?.(true);
		process.stdin.resume();
		process.stdin.once("data", () => {
			process.stdin.setRawMode?.(false);
			process.stdin.pause();
			resolve();
		});
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateLegacySessionDirsToSessionRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
