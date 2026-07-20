import { spawn } from "node:child_process";

const exitOnInput = process.argv.includes("--exit-on-input");
const respondThenExit = process.argv.includes("--respond-then-exit");
const ignoreSigterm = process.argv.includes("--ignore-sigterm");
const holdStdoutAfterExit = process.argv.includes("--hold-stdout-after-exit");
const exitDuringStart = process.argv.includes("--exit-during-start");

const holdStdoutOpen = () => {
	spawn(
		process.execPath,
		[
			"-e",
			`const fallback = setTimeout(() => process.exit(0), 5000);
const interval = setInterval(() => process.stdout.write("."), 10);
process.stdout.on("error", () => {
	clearTimeout(fallback);
	clearInterval(interval);
	process.exit(0);
});`,
		],
		{ stdio: ["ignore", "inherit", "ignore"] },
	);
};

if (exitDuringStart) {
	holdStdoutOpen();
	process.exit(23);
}

process.stdin.on("data", (data) => {
	if (respondThenExit) {
		const request = JSON.parse(data.toString());
		process.stdout.write(
			`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "final", padding: "x".repeat(2 * 1024 * 1024) } })}\n`,
			() => process.exit(0),
		);
	} else if (holdStdoutAfterExit) {
		holdStdoutOpen();
		process.exit(23);
	} else if (exitOnInput) {
		process.exit(23);
	}
});

const keepAlive = setInterval(() => {}, 2_147_483_647);
const stop = () => {
	clearInterval(keepAlive);
	process.exit(0);
};

process.on("SIGINT", stop);
process.on("SIGTERM", ignoreSigterm ? () => {} : stop);
