import { createHash, randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { cpus, release, type } from "node:os";
import {
	createStreamingJsonParseState,
	getLegacyStreamingJsonInputExaminedForTesting,
	getStreamingJsonInputExaminedForTesting,
	parseStreamingJson,
	resetStreamingJsonParseInstrumentationForTesting,
} from "../src/utils/json-parse.js";

const BENCHMARK_NAME = "N01-streaming-structured-output-parse-cpu";
type Mode = "legacy" | "incremental";
type Options = {
	name: string;
	output: string;
	escapedBytes: number;
	unicodeBytes: number;
	repetitions: number;
};

function requiredOption(args: string[], name: string): string {
	const index = args.indexOf(name);
	if (index === -1 || args[index + 1] === undefined) throw new Error(`${name} requires a value`);
	return args[index + 1];
}

function positiveIntegerOption(args: string[], name: string, defaultValue: number): number {
	const index = args.indexOf(name);
	if (index === -1) return defaultValue;
	const parsed = Number(args[index + 1]);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}

function parseOptions(args: string[]): Options {
	const name = requiredOption(args, "--name");
	if (name !== BENCHMARK_NAME) throw new Error(`--name must be ${BENCHMARK_NAME}`);
	return {
		name,
		output: requiredOption(args, "--json"),
		escapedBytes: positiveIntegerOption(args, "--escaped-bytes", 1024 * 1024),
		unicodeBytes: positiveIntegerOption(args, "--unicode-bytes", 256 * 1024),
		repetitions: positiveIntegerOption(args, "--repetitions", 7),
	};
}

function corpus(bytes: number, unicode: boolean): string {
	const unit = unicode ? "😀\u2028 nested é " : '\\"escaped\\n nested ';
	return JSON.stringify({
		outer: Array.from({ length: Math.ceil(bytes / unit.length) }, (_, index) => ({ index, text: unit })),
	});
}

function chunks(document: string, size: number): string[] {
	return Array.from({ length: Math.ceil(document.length / size) }, (_, index) =>
		document.slice(index * size, (index + 1) * size),
	);
}

function measured(document: string, input: string[], mode: Mode) {
	resetStreamingJsonParseInstrumentationForTesting();
	const resourcesBefore = process.resourceUsage();
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
	const resourcesAfter = process.resourceUsage();
	return {
		wallNs: Number(process.hrtime.bigint() - wallBefore),
		cpuUs:
			resourcesAfter.userCPUTime -
			resourcesBefore.userCPUTime +
			(resourcesAfter.systemCPUTime - resourcesBefore.systemCPUTime),
		inputExamined: examined,
		chunkCount: input.length,
	};
}

function stats(values: number[]) {
	const sorted = [...values].sort((a, b) => a - b);
	return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1) };
}

function writeJsonAtomically(output: string, value: unknown): void {
	const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, output);
}

function run(options: Options): void {
	const results = [
		{
			name: `escaped-nested-${options.escapedBytes}-64`,
			document: corpus(options.escapedBytes, false),
			chunkSize: 64,
		},
		{ name: `unicode-nested-${options.unicodeBytes}-7`, document: corpus(options.unicodeBytes, true), chunkSize: 7 },
	].map(({ name, document, chunkSize }) => {
		const input = chunks(document, chunkSize);
		measured(document, input, "legacy");
		measured(document, input, "incremental");
		const samples: Record<Mode, ReturnType<typeof measured>[]> = { legacy: [], incremental: [] };
		for (let repetition = 0; repetition < options.repetitions; repetition++) {
			const order: Mode[] = repetition % 2 === 0 ? ["legacy", "incremental"] : ["incremental", "legacy"];
			for (const mode of order) samples[mode].push(measured(document, input, mode));
		}
		const legacyCpuUs = stats(samples.legacy.map((sample) => sample.cpuUs));
		const incrementalCpuUs = stats(samples.incremental.map((sample) => sample.cpuUs));
		if (samples.incremental[0].inputExamined !== document.length * 2)
			throw new Error("incremental input examination is not linear");
		if (incrementalCpuUs.median >= legacyCpuUs.median)
			throw new Error("incremental median CPU did not beat legacy replay");
		return {
			name,
			inputHash: createHash("sha256").update(document).digest("hex"),
			inputLength: document.length,
			chunkCount: input.length,
			repetitions: options.repetitions,
			order: "alternating legacy/incremental by repetition",
			legacy: {
				wallNs: stats(samples.legacy.map((sample) => sample.wallNs)),
				cpuUs: legacyCpuUs,
				inputExamined: samples.legacy[0].inputExamined,
			},
			incremental: {
				wallNs: stats(samples.incremental.map((sample) => sample.wallNs)),
				cpuUs: incrementalCpuUs,
				inputExamined: samples.incremental[0].inputExamined,
			},
		};
	});
	writeJsonAtomically(options.output, {
		name: options.name,
		command: process.argv.join(" "),
		node: process.version,
		os: {
			platform: process.platform,
			release: release(),
			arch: process.arch,
			type: type(),
		},
		cpu: cpus()[0]?.model ?? "unknown",
		results,
	});
}

run(parseOptions(process.argv.slice(2)));
