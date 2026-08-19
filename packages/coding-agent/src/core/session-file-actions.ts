import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { getSessionArtifactPathForFile } from "./session-manager.js";

export type DeleteSessionFileResult = { ok: true; method: "trash" | "unlink" } | { ok: false; error: string };

export interface DeleteSessionFileOptions {
	afterFileRemoved?: () => void;
}

/**
 * Permanently remove a session's artifact directory (durable schedule state,
 * kernel snapshot, RLM scratch files, …), which lives at
 * `<dirname(sessionDir)>/session-artifacts/<id>`.
 * Only invoked on delete, never on deactivation.
 */
export async function deleteSessionArtifacts(sessionPath: string): Promise<void> {
	// A degenerate name (".jsonl") would resolve to the artifacts root itself.
	if (!basename(sessionPath).replace(/\.jsonl$/, "")) return;
	await rm(getSessionArtifactPathForFile(sessionPath), { recursive: true, force: true });
}

/** Remove the session `.jsonl`, trying the `trash` CLI first, then falling back to unlink. */
async function removeSessionFile(sessionPath: string): Promise<DeleteSessionFileResult> {
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" - ").slice(0, 200)}`;
	};

	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, error };
	}
}

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink.
 * Also permanently removes the session's artifact directory, but only
 * once the session file itself is gone — otherwise a failed delete would orphan a
 * session whose kernel snapshot has already been destroyed.
 */
export async function deleteSessionFile(
	sessionPath: string,
	options: DeleteSessionFileOptions = {},
): Promise<DeleteSessionFileResult> {
	const result = await removeSessionFile(sessionPath);
	if (result.ok) {
		options.afterFileRemoved?.();
		await deleteSessionArtifacts(sessionPath);
	}
	return result;
}

// Entry types present from session bootstrap alone; a file holding only these
// plus session_state never received a message or user configuration.
const EMPTY_SESSION_ENTRY_TYPES = new Set([
	"session",
	"model_change",
	"thinking_level_change",
	"service_tier_change",
	"session_state",
]);

/**
 * True when a session file is an abandoned empty draft: no messages and no
 * user content, only bootstrap entries and daemon-written session_state.
 */
export function isEmptySessionFile(sessionPath: string): boolean {
	let content: string;
	try {
		content = readFileSync(sessionPath, "utf8");
	} catch {
		return false;
	}
	let sawHeader = false;
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: { type?: unknown };
		try {
			entry = JSON.parse(line);
		} catch {
			return false;
		}
		if (typeof entry.type !== "string" || !EMPTY_SESSION_ENTRY_TYPES.has(entry.type)) {
			return false;
		}
		if (entry.type === "session") sawHeader = true;
	}
	return sawHeader;
}

/**
 * Delete abandoned empty session files from a session directory. `shouldSkip`
 * lets the caller exclude files that are live in some other way (open in the
 * daemon, leased by a live process, or bound to scheduled jobs).
 */
export async function sweepEmptySessionFiles(
	sessionDir: string,
	shouldSkip: (sessionPath: string) => boolean,
): Promise<string[]> {
	if (!existsSync(sessionDir)) return [];
	const removed: string[] = [];
	for (const entry of readdirSync(sessionDir)) {
		if (!entry.endsWith(".jsonl")) continue;
		const sessionPath = join(sessionDir, entry);
		if (!isEmptySessionFile(sessionPath) || shouldSkip(sessionPath)) continue;
		const result = await deleteSessionFile(sessionPath).catch(() => undefined);
		if (result?.ok) {
			removed.push(sessionPath);
		}
	}
	return removed;
}
