import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createStreamingJsonParseState, parseStreamingJson } from "../src/utils/json-parse.js";

const args = process.argv.slice(2);
const name = args[args.indexOf("--name") + 1];
const output = args[args.indexOf("--json") + 1];
if (name !== "N01-streaming-structured-output-parse-cpu" || !output)
	throw new Error("Use --name N01-streaming-structured-output-parse-cpu --json FILE");
function corpus(bytes: number, unicode: boolean): string {
	const unit = unicode ? "😀\\u2028 nested é " : '\\"escaped\\n nested ';
	return JSON.stringify({
		outer: Array.from({ length: Math.ceil(bytes / unit.length) }, (_, index) => ({ index, text: unit })),
	});
}
function measure(document: string, size: number, incremental: boolean) {
	const chunks = Array.from({ length: Math.ceil(document.length / size) }, (_, i) =>
		document.slice(i * size, (i + 1) * size),
	);
	const before = process.cpuUsage();
	const start = process.hrtime.bigint();
	let final: unknown;
	if (incremental) {
		const state = createStreamingJsonParseState();
		for (const chunk of chunks) state.append(chunk);
		final = state.finalize();
	} else {
		let prefix = "";
		for (const chunk of chunks) {
			prefix += chunk;
			parseStreamingJson(prefix);
		}
		final = JSON.parse(prefix);
	}
	const cpu = process.cpuUsage(before);
	const wallNs = Number(process.hrtime.bigint() - start);
	if (JSON.stringify(final) !== document) throw new Error("parser paths differ");
	return {
		wallNs,
		cpuUs: cpu.user + cpu.system,
		chunks: chunks.length,
		inputExamined: incremental ? document.length * 2 : (document.length * chunks.length) / 2,
	};
}
function stats(values: number[]) {
	const ordered = [...values].sort((a, b) => a - b);
	return { min: ordered[0], median: ordered[Math.floor(ordered.length / 2)], max: ordered.at(-1) };
}
const corpora = [
	{ name: "1MiB-escaped-nested-64", document: corpus(1024 * 1024, false), size: 64 },
	{ name: "256KiB-unicode-nested-7", document: corpus(256 * 1024, true), size: 7 },
];
const results = corpora.map(({ name, document, size }) => {
	measure(document, size, true); // unreported warm-up
	const legacy = Array.from({ length: 7 }, () => measure(document, size, false));
	const incremental = Array.from({ length: 7 }, () => measure(document, size, true));
	return {
		name,
		inputHash: createHash("sha256").update(document).digest("hex"),
		chunkCount: incremental[0].chunks,
		legacy: { wallNs: stats(legacy.map((x) => x.wallNs)), cpuUs: stats(legacy.map((x) => x.cpuUs)) },
		incremental: {
			wallNs: stats(incremental.map((x) => x.wallNs)),
			cpuUs: stats(incremental.map((x) => x.cpuUs)),
			inputExamined: incremental[0].inputExamined,
		},
	};
});
writeFileSync(
	output,
	JSON.stringify(
		{
			name,
			node: process.version,
			platform: process.platform,
			arch: process.arch,
			cpu: process.arch,
			command: process.argv.join(" "),
			results,
		},
		null,
		2,
	),
);
