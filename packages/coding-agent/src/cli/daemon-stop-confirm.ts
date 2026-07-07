/**
 * Shared confirmation for stopping a running daemon that has live sessions.
 *
 * Both `prime-agent update --self` and interactive startup (when taking over a
 * stale-version daemon) need to ask before discarding live active sessions that
 * cannot be restored after the daemon restarts. They keep the same safety
 * semantics here and only vary the wording via `copy`.
 *
 * Kept out of daemon-launch.ts so the early fire-and-forget launch path stays
 * light on imports (no readline/chalk); this module is only reached on the
 * interactive, post-startup paths.
 */

import { createInterface } from "node:readline";
import chalk from "chalk";
import { isSessionAtRiskFromDaemonStop, type RunningDaemonProbe } from "./daemon-launch.js";

/** Prompt for a yes/no answer at a TTY. Empty/anything-but-yes resolves false (default No). */
export function promptYesNo(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			const normalized = answer.trim().toLowerCase();
			resolve(normalized === "y" || normalized === "yes");
		});
	});
}

export function pluralizeSessions(count: number): { noun: string; pronoun: string } {
	return count === 1 ? { noun: "session", pronoun: "it" } : { noun: "sessions", pronoun: "them" };
}

export interface DaemonSessionLossCopy {
	/** Full sentence describing the unrestorable sessions and what stopping the daemon does. */
	atRiskDetail(count: number): string;
	/** Full sentence for the reachable-but-unlistable case (work may be lost). */
	unlistableDetail: string;
	/** Question appended after the detail when prompting at a TTY (before " [y/N]"). */
	question: string;
	/** Remediation appended after the detail when not at a TTY. */
	nonTtyHint: string;
}

/**
 * Returns true when it is safe to proceed with stopping the daemon: it is not
 * reachable, `force` is set, no live sessions are at risk, or the user
 * confirmed at a TTY. Returns false to abort (at-risk/unlistable and either
 * declined or non-TTY). Restorable top-level sessions are reopened after the
 * fresh daemon starts.
 */
export async function confirmDaemonSessionLoss(
	probe: RunningDaemonProbe,
	options: { force: boolean; copy: DaemonSessionLossCopy },
): Promise<boolean> {
	const { force, copy } = options;
	if (!probe.reachable || force) {
		return true;
	}
	let detail: string;
	if (probe.activeSessions === undefined) {
		// Reachable but couldn't list sessions: assume work may be lost.
		detail = copy.unlistableDetail;
	} else {
		const atRiskSessions = probe.activeSessions.filter(isSessionAtRiskFromDaemonStop);
		if (atRiskSessions.length === 0) {
			return true;
		}
		detail = copy.atRiskDetail(atRiskSessions.length);
	}
	if (!process.stdin.isTTY) {
		console.error(chalk.red(`${detail} ${copy.nonTtyHint}`));
		return false;
	}
	return promptYesNo(`${detail} ${copy.question}`);
}
