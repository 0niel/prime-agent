export interface ProcessIdentity {
	pid: number;
	ppid: number;
	pgid: number;
	start: number;
}

export interface ProcessStat extends ProcessIdentity {
	state: string;
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
 * A zombie has no address space, so Linux omits VmRSS from its status file.
 * Retaining it at zero keeps ownership/reaping conservative until it vanishes.
 */
export function processRecordFromStatus(stat: ProcessStat, status: string): ProcessRecord | undefined {
	const rss = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
	if (rss === undefined && stat.state !== "Z") return undefined;
	return {
		pid: stat.pid,
		ppid: stat.ppid,
		pgid: stat.pgid,
		start: stat.start,
		rssKiB: rss === undefined ? 0 : Number(rss),
	};
}
