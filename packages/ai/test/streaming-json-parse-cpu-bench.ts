import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { cpus, release, type } from "node:os";
import {
	createStreamingJsonParseState,
	getLegacyStreamingJsonInputExaminedForTesting,
	getStreamingJsonInputExaminedForTesting,
	parseStreamingJson,
	resetStreamingJsonParseInstrumentationForTesting,
} from "../src/utils/json-parse.js";

const args = process.argv.slice(2);
const name = args[args.indexOf("--name") + 1];
const output = args[args.indexOf("--json") + 1];
if (name !== "N01-streaming-structured-output-parse-cpu" || !output)
	throw new Error("Use --name N01-streaming-structured-output-parse-cpu --json FILE");

function corpus(bytes: number, unicode: boolean): string {
	const unit = unicode ? "😀\u2028 nested é " : '\\"escaped\\n nested ';
	return JSON.stringify({
		outer: Array.from({ length: Math.ceil(bytes / unit.length) }, (_, index) => ({ index, text: unit })),
	});
}
function chunks(document: string, size: number): string[] {
	return Array.from({ length: Math.ceil(document.length / size) }, (_, i) => document.slice(i * size, (i + 1) * size));
}
function measured(document: string, chunkSize: number, mode: "legacy" | "incremental") {
	const input = chunks(document, chunkSize);
	resetStreamingJsonParseInstrumentationForTesting();
	const cpuBefore = process.cpuUsage();
	const wallBefore = process.hrtime.bigint();
	let result: unknown;
	let examined: number;
	if (mode === "legacy") {
		let prefix = "";
		for (const chunk of input) {
			prefix += chunk;
			parseStreamingJson(prefix);
		}
		result = JSON.parse(prefix);
		examined = getLegacyStreamingJsonInputExaminedForTesting() + document.length;
	} else {
		const state = createStreamingJsonParseState();
		for (const chunk of input) state.append(chunk);
		result = state.finalize();
		examined = getStreamingJsonInputExaminedForTesting(state).total;
	}
	if (JSON.stringify(result) !== document) throw new Error(`${mode} result differs from source document`);
	const cpu = process.cpuUsage(cpuBefore);
	return {
		wallNs: Number(process.hrtime.bigint() - wallBefore),
		cpuUs: cpu.user + cpu.system,
		inputExamined: examined,
		chunkCount: input.length,
	};
}
function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
}
function option(name: string, defaultValue: number): number {
	const index = args.indexOf(name);
	if (index === -1) return defaultValue;
	const value = args[index + 1];
	if (value === undefined) throw new Error(`${name} requires a value`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

// Defaults are deliberately local-friendly: the legacy baseline reparses each
// prefix, so small chunks make its examined-input total grow quadratically.
// The remote command below retains the original 1 MiB corpus sizes.
const repetitions = option("--repetitions", 5);
const escapedBytes = option("--escaped-bytes", 32 * 1024);
const unicodeBytes = option("--unicode-bytes", 8 * 1024);
const escapedChunkSize = option("--escaped-chunk-size", 64);
const unicodeChunkSize = option("--unicode-chunk-size", 7);
const results = [
	{
		name: `escaped-nested-${escapedBytes}-${escapedChunkSize}`,
		document: corpus(escapedBytes, false),
		chunkSize: escapedChunkSize,
	},
	{
		name: `unicode-nested-${unicodeBytes}-${unicodeChunkSize}`,
		document: corpus(unicodeBytes, true),
		chunkSize: unicodeChunkSize,
	},
].map(({ name: corpusName, document, chunkSize }) => {
	measured(document, chunkSize, "legacy");
	measured(document, chunkSize, "incremental"); // unreported warm-ups
	const legacy = Array.from({ length: repetitions }, () => measured(document, chunkSize, "legacy"));
	const incremental = Array.from({ length: repetitions }, () => measured(document, chunkSize, "incremental"));
	const legacyCpuUs = stats(legacy.map((sample) => sample.cpuUs));
	const incrementalCpuUs = stats(incremental.map((sample) => sample.cpuUs));
	if (incremental[0].inputExamined !== document.length * 2)
		throw new Error("incremental input examination is not linear");
	if (incrementalCpuUs.median >= legacyCpuUs.median)
		throw new Error("incremental median CPU did not beat legacy replay");
	return {
		name: corpusName,
		inputHash: createHash("sha256").update(document).digest("hex"),
		inputLength: document.length,
		chunkCount: incremental[0].chunkCount,
		repetitions,
		legacy: {
			wallNs: stats(legacy.map((sample) => sample.wallNs)),
			cpuUs: legacyCpuUs,
			inputExamined: legacy[0].inputExamined,
		},
		incremental: {
			wallNs: stats(incremental.map((sample) => sample.wallNs)),
			cpuUs: incrementalCpuUs,
			inputExamined: incremental[0].inputExamined,
		},
	};
});
writeFileSync(
	output,
	JSON.stringify(
		{
			name,
			command: process.argv.join(" "),
			node: process.version,
			os: {
				platform: process.platform,
				release: release(),
				version: process.version,
				arch: process.arch,
				type: type(),
			},
			cpu: cpus()[0]?.model ?? "unknown",
			results,
		},
		null,
		2,
	),
);
