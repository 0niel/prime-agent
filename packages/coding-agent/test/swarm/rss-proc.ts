export interface ProcessIdentity {
	pid: number;
	ppid: number;
	pgid: number;
	start: number;
}

export interface ProcessStat extends ProcessIdentity {
	state: string;
}

// Linux task-state letters emitted by /proc/PID/status.
const LINUX_PROCESS_STATES = new Set(["R", "S", "D", "Z", "T", "t", "W", "X", "x", "K", "P", "I"]);

/**
 * Confirms that two reads identify the same process-group member. State and
 * parent PID are deliberately transient and therefore are not identity.
 */
export function hasStableProcessIdentity(initial: ProcessStat, confirmation: ProcessStat): boolean {
	return (
		initial.pid === confirmation.pid && initial.start === confirmation.start && initial.pgid === confirmation.pgid
	);
}

/** The persisted artifact shape deliberately excludes transient procfs state. */
export interface ProcessRecord extends ProcessIdentity {
	rssKiB: number;
}

/**
 * Parses Linux /proc/PID/stat after the parenthesized comm field, which can
 * itself contain spaces and closing parentheses.
 */
export function parseProcessStat(pid: number, statLine: string): ProcessStat | undefined {
	const close = statLine.lastIndexOf(")");
	if (close < 0) return undefined;
	const fields = statLine
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	const state = fields[0]; // field 3
	const ppid = Number(fields[1]); // field 4
	const pgid = Number(fields[2]); // field 5
	const start = Number(fields[19]); // field 22
	if (!state || state.length !== 1 || ![ppid, pgid, start].every(Number.isSafeInteger)) return undefined;
	return { pid, ppid, pgid, start, state };
}

/**
 * A process without an mm has no Vm* fields. Linux exposes this both for
 * zombies and briefly for fork/exec children, which are conservatively kept
 * as zero-RSS records after an external stat reread confirms the identity.
 * State is only a status-file integrity check: it may change between reads.
 */
export function processRecordFromStatus(
	stat: ProcessStat,
	status: string,
	confirmation: ProcessStat,
): ProcessRecord | undefined {
	if (!hasStableProcessIdentity(stat, confirmation)) return undefined;

	const lines = status.split(/\r?\n/);
	const stateLines = lines.filter((line) => line.startsWith("State:"));
	const state = stateLines.length === 1 ? /^State:\s+(\S)(?:\s+\([^()]*\))?\s*$/.exec(stateLines[0])?.[1] : undefined;
	if (state === undefined || !LINUX_PROCESS_STATES.has(state)) return undefined;

	const vmLines = lines.filter((line) => line.startsWith("Vm"));
	const rssLines = vmLines.filter((line) => line.startsWith("VmRSS:"));
	if (rssLines.length === 0) {
		return vmLines.length === 0
			? { pid: stat.pid, ppid: stat.ppid, pgid: stat.pgid, start: stat.start, rssKiB: 0 }
			: undefined;
	}
	if (rssLines.length !== 1) return undefined;
	const rss = /^VmRSS:\s+(\d+)\s+kB\s*$/.exec(rssLines[0])?.[1];
	if (rss === undefined) return undefined;
	return { pid: stat.pid, ppid: stat.ppid, pgid: stat.pgid, start: stat.start, rssKiB: Number(rss) };
}
