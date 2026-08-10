/**
 * Preserve a parent TypeScript runtime when present. Otherwise use tsx's Node
 * preload so the disposable child can execute the .ts worker directly.
 */
export function childExecArgsWithTsxImport(execArgs: readonly string[]): string[] {
	for (let index = 0; index < execArgs.length; index += 1) {
		const argument = execArgs[index]!;
		if (argument === "--import" && execArgs[index + 1] === "tsx") return [...execArgs];
		if (argument === "--import=tsx") return [...execArgs];
		// An explicit Node loader owns module loading for this child; do not
		// stack tsx on top of a caller-selected TypeScript loader.
		if (argument === "--loader" || argument.startsWith("--loader=")) return [...execArgs];
	}
	return [...execArgs, "--import", "tsx"];
}
