const exitOnInput = process.argv.includes("--exit-on-input");
const respondThenExit = process.argv.includes("--respond-then-exit");
const ignoreSigterm = process.argv.includes("--ignore-sigterm");

process.stdin.on("data", (data) => {
	if (respondThenExit) {
		const request = JSON.parse(data.toString());
		process.stdout.write(
			`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { sessionId: "final", padding: "x".repeat(2 * 1024 * 1024) } })}\n`,
			() => process.exit(0),
		);
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
