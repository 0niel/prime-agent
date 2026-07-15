import { isBunBinary } from "../config.js";

export interface CliSubprocessLaunchSpec {
	command: string;
	args: string[];
}

export function createCliSubprocessLaunchSpec(
	args: readonly string[],
	executable = process.execPath,
	execArgs: readonly string[] = process.execArgv,
	entrypoint = process.argv[1],
): CliSubprocessLaunchSpec {
	if (isBunBinary) {
		return { command: executable, args: [...args] };
	}
	if (!entrypoint) {
		throw new Error("Cannot determine current CLI entrypoint for subprocess launch");
	}
	return { command: executable, args: [...execArgs, entrypoint, ...args] };
}
