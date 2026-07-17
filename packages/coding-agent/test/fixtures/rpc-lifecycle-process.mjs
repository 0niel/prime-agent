const exitOnInput = process.argv.includes("--exit-on-input");
const ignoreSigterm = process.argv.includes("--ignore-sigterm");

process.stdin.on("data", () => {
	if (exitOnInput) {
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
