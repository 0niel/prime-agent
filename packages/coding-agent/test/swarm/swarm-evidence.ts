/**
 * Test-only, provider-neutral evidence substrate for the local swarm rehearsal.
 *
 * It deliberately does not import the agent runtime or any provider adapter. A
 * caller admits every assignment immediately and the fake provider records that
 * admission before it awaits any configured delay. That makes a later runtime
 * integration able to compare its own dispatch behaviour with this stable,
 * no-cost fixture without changing production dispatch behaviour.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

export const SUPPORTED_SWARM_FANOUTS = [1, 4, 16, 64] as const;
export const SWARM_EVIDENCE_SCHEMA_VERSION = "prime-agent.swarm-evidence/v1";
const MICRO_TOKENS = 1_000_000;

export type FakeProviderAction =
	| { readonly type: "delay"; readonly milliseconds: number }
	| { readonly type: "progress"; readonly message: string }
	| { readonly type: "failure"; readonly code: string; readonly message: string }
	| { readonly type: "restart"; readonly reason: string }
	| { readonly type: "completion"; readonly outputTokens?: number };

export interface FakeProviderFaultSchedule {
	readonly nodeId: string;
	readonly actions: readonly FakeProviderAction[];
}

export interface AssignmentSpec {
	readonly nodeId: string;
	readonly parentNodeId?: string;
	readonly role: string;
	readonly requested: {
		readonly provider: string;
		readonly model: string;
		readonly revision?: string;
		readonly effort?: string;
	};
	readonly resolved?: AssignmentSpec["requested"];
	readonly inputTokens?: number;
	readonly outputTokens?: number;
}

export interface PriceCard {
	readonly version: string;
	readonly inputPerMillionTokens: number;
	readonly outputPerMillionTokens: number;
}

export interface ProcessMemory {
	readonly pid: number;
	readonly parentPid?: number;
	readonly startTime?: string;
	readonly rssBytes: number;
	readonly heapUsedBytes?: number;
	readonly externalBytes?: number;
	readonly label?: string;
}

export interface ProcessSampler {
	/** Must return the supervisor and every currently known worker/descendant. */
	sample(): readonly ProcessMemory[];
	readonly source?: string;
}

export interface SwarmBenchmarkConfig {
	readonly scenario: string;
	readonly assignments: readonly AssignmentSpec[];
	readonly faultSchedule?: readonly FakeProviderFaultSchedule[];
	readonly priceCard: PriceCard;
	readonly metadata?: Readonly<Record<string, unknown>>;
	readonly processSampler?: ProcessSampler;
}

export interface SwarmManifest {
	readonly schemaVersion: typeof SWARM_EVIDENCE_SCHEMA_VERSION;
	readonly benchmarkVersion: "b00";
	readonly fingerprint: string;
	readonly scenario: string;
	readonly assignments: readonly AssignmentSpec[];
	readonly faultSchedule: readonly FakeProviderFaultSchedule[];
	readonly priceCard: PriceCard;
	readonly metadata: Readonly<Record<string, unknown>>;
	readonly runtime: {
		readonly node: string;
		readonly platform: string;
		readonly release: string;
		readonly arch: string;
	};
}

export type SwarmEvent = {
	readonly sequence: number;
	readonly elapsedMilliseconds: number;
	readonly type:
		| "dispatch_admitted"
		| "provider_request_started"
		| "progress"
		| "restart"
		| "provider_failure"
		| "provider_completed"
		| "delivery_completed"
		| "cleanup_completed";
	readonly nodeId: string;
	readonly detail?: Readonly<Record<string, unknown>>;
};

export interface ProcessSample {
	readonly sequence: number;
	readonly elapsedMilliseconds: number;
	readonly phase: "before_dispatch" | "after_admission" | "after_terminal" | "after_cleanup";
	readonly source: string;
	readonly processes: readonly ProcessMemory[];
	readonly totalRssBytes: number;
}

export interface CostAttribution {
	readonly id: string;
	readonly kind: "node" | "role" | "run";
	readonly directInputTokens: number;
	readonly directOutputTokens: number;
	readonly directCost: number;
	readonly downstreamInputTokens: number;
	readonly downstreamOutputTokens: number;
	readonly downstreamCost: number;
}

export interface EvidenceArtifact {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
	readonly schemaVersion: typeof SWARM_EVIDENCE_SCHEMA_VERSION;
}

export interface SwarmEvidence {
	readonly manifest: SwarmManifest;
	readonly events: readonly SwarmEvent[];
	readonly processSamples: readonly ProcessSample[];
	readonly costAttribution: readonly CostAttribution[];
	readonly summary: {
		readonly admitted: number;
		readonly started: number;
		readonly completed: number;
		readonly failed: number;
		readonly delivered: number;
		readonly cleanedUp: number;
		readonly independentDispatch: boolean;
	};
}

/**
 * Snapshot the host process and its descendants with native `ps` on Unix. This
 * deliberately reports an unavailable source on Windows instead of publishing a
 * misleading parent-only RSS value. Production workers can inject their own
 * supervisor-aware sampler. Shared pages are counted once per reported process,
 * which is the conventional summed-RSS measurement.
 */
export const currentProcessSampler: ProcessSampler = {
	source:
		process.platform === "win32"
			? "unsupported: process-tree RSS requires a native Windows sampler"
			: "ps: pid/ppid/rss-kib/lstart; summed RSS counts shared pages per process",
	sample(): readonly ProcessMemory[] {
		if (process.platform === "win32") return [];
		try {
			const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,lstart="], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			})
				.split("\n")
				.map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/))
				.filter((match): match is RegExpMatchArray => match !== null)
				.map((match) => ({
					pid: Number(match[1]),
					parentPid: Number(match[2]),
					rssBytes: Number(match[3]) * 1024,
					startTime: match[4],
					label: "process-tree",
				}));
			const wanted = new Set([process.pid]);
			for (let changed = true; changed; ) {
				changed = false;
				for (const row of rows)
					if (row.parentPid !== undefined && wanted.has(row.parentPid) && !wanted.has(row.pid)) {
						wanted.add(row.pid);
						changed = true;
					}
			}
			return rows.filter((row) => wanted.has(row.pid));
		} catch {
			return [];
		}
	},
};

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function fingerprint(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function money(tokens: number, pricePerMillion: number): number {
	return (tokens * pricePerMillion) / MICRO_TOKENS;
}

function defaultActions(assignment: AssignmentSpec): readonly FakeProviderAction[] {
	return [{ type: "completion", outputTokens: assignment.outputTokens ?? 16 }];
}

function validate(config: SwarmBenchmarkConfig): void {
	if (!config.scenario.trim()) throw new Error("scenario must not be empty");
	if (config.assignments.length === 0) throw new Error("at least one assignment is required");
	if (new Set(config.assignments.map((assignment) => assignment.nodeId)).size !== config.assignments.length) {
		throw new Error("assignment nodeId values must be unique");
	}
	for (const assignment of config.assignments) {
		if (!assignment.role || !assignment.requested.provider || !assignment.requested.model) {
			throw new Error(`assignment ${assignment.nodeId} requires role, provider, and model`);
		}
	}
	for (const action of config.faultSchedule?.flatMap((schedule) => schedule.actions) ?? []) {
		if (action.type === "delay" && (!Number.isFinite(action.milliseconds) || action.milliseconds < 0)) {
			throw new Error("delay milliseconds must be a non-negative finite number");
		}
	}
}

/** Creates a repeatable manifest: its fingerprint excludes host-specific runtime facts. */
export function createSwarmManifest(config: SwarmBenchmarkConfig): SwarmManifest {
	validate(config);
	const faultSchedule = config.faultSchedule ?? [];
	const fingerprintInput: Omit<SwarmManifest, "fingerprint" | "runtime"> = {
		schemaVersion: SWARM_EVIDENCE_SCHEMA_VERSION,
		benchmarkVersion: "b00",
		scenario: config.scenario,
		assignments: config.assignments,
		faultSchedule,
		priceCard: config.priceCard,
		metadata: config.metadata ?? {},
	};
	return {
		...fingerprintInput,
		fingerprint: fingerprint(fingerprintInput),
		runtime: { node: process.version, platform: platform(), release: release(), arch: arch() },
	};
}

/**
 * Runs all assignments with Promise.all, with no local admission object, queue,
 * semaphore, retry, or synthetic provider response. Failures are evidence, not
 * thrown benchmark errors, so a fault campaign retains the complete trace.
 */
export async function runSwarmBenchmark(config: SwarmBenchmarkConfig): Promise<SwarmEvidence> {
	const manifest = createSwarmManifest(config);
	const sampler = config.processSampler ?? currentProcessSampler;
	const actionsByNode = new Map((config.faultSchedule ?? []).map((schedule) => [schedule.nodeId, schedule.actions]));
	let sequence = 0;
	const startedAt = performance.now();
	const events: SwarmEvent[] = [];
	const processSamples: ProcessSample[] = [];
	const record = (type: SwarmEvent["type"], nodeId: string, detail?: Readonly<Record<string, unknown>>) => {
		events.push({ sequence: ++sequence, elapsedMilliseconds: performance.now() - startedAt, type, nodeId, detail });
	};
	const sample = (phase: ProcessSample["phase"]) => {
		const processes = sampler.sample();
		processSamples.push({
			sequence: ++sequence,
			elapsedMilliseconds: performance.now() - startedAt,
			phase,
			source: sampler.source ?? "injected process sampler",
			processes,
			totalRssBytes: processes.reduce((total, processMemory) => total + processMemory.rssBytes, 0),
		});
	};

	sample("before_dispatch");
	for (const assignment of config.assignments) record("dispatch_admitted", assignment.nodeId);
	const runAssignment = async (assignment: AssignmentSpec) => {
		const resolved = assignment.resolved ?? assignment.requested;
		record("provider_request_started", assignment.nodeId, {
			role: assignment.role,
			requested: assignment.requested,
			resolved,
		});
		// Yield only after recording start so every independently admitted request
		// starts before a synchronous fixture completion can become terminal.
		await Promise.resolve();
		let terminal: "completed" | "failed" = "completed";
		let outputTokens = assignment.outputTokens ?? 16;
		for (const action of actionsByNode.get(assignment.nodeId) ?? defaultActions(assignment)) {
			switch (action.type) {
				case "delay":
					await new Promise<void>((resolve) => setTimeout(resolve, action.milliseconds));
					break;
				case "progress":
					record("progress", assignment.nodeId, { message: action.message });
					break;
				case "restart":
					record("restart", assignment.nodeId, { reason: action.reason });
					break;
				case "failure":
					terminal = "failed";
					record("provider_failure", assignment.nodeId, { code: action.code, message: action.message });
					break;
				case "completion":
					outputTokens = action.outputTokens ?? outputTokens;
					break;
			}
			if (terminal === "failed") break;
		}
		if (terminal === "completed") {
			record("provider_completed", assignment.nodeId, { outputTokens });
			record("delivery_completed", assignment.nodeId);
		}
		record("cleanup_completed", assignment.nodeId);
		return { assignment, terminal, outputTokens: terminal === "completed" ? outputTokens : 0 };
	};

	const runs = config.assignments.map(runAssignment); // Immediate, independent provider admission; do not replace with a shared limiter.
	sample("after_admission");
	const results = await Promise.all(runs);
	sample("after_terminal");
	sample("after_cleanup");

	const byNode = new Map(results.map((result) => [result.assignment.nodeId, result]));
	const costs = new Map<string, CostAttribution>();
	const calculate = (id: string): CostAttribution => {
		const existing = costs.get(id);
		if (existing) return existing;
		const result = byNode.get(id);
		if (!result)
			return {
				id,
				kind: "node",
				directInputTokens: 0,
				directOutputTokens: 0,
				directCost: 0,
				downstreamInputTokens: 0,
				downstreamOutputTokens: 0,
				downstreamCost: 0,
			};
		const inputTokens = result.assignment.inputTokens ?? 32;
		const directCost =
			money(inputTokens, config.priceCard.inputPerMillionTokens) +
			money(result.outputTokens, config.priceCard.outputPerMillionTokens);
		const children = results
			.filter((candidate) => candidate.assignment.parentNodeId === id)
			.map((candidate) => calculate(candidate.assignment.nodeId));
		const attribution = {
			id,
			kind: "node" as const,
			directInputTokens: inputTokens,
			directOutputTokens: result.outputTokens,
			directCost,
			downstreamInputTokens: inputTokens + children.reduce((total, child) => total + child.downstreamInputTokens, 0),
			downstreamOutputTokens:
				result.outputTokens + children.reduce((total, child) => total + child.downstreamOutputTokens, 0),
			downstreamCost: directCost + children.reduce((total, child) => total + child.downstreamCost, 0),
		};
		costs.set(id, attribution);
		return attribution;
	};
	for (const result of results) calculate(result.assignment.nodeId);
	const nodeCosts = [...costs.values()];
	const roleCosts = [...new Set(results.map((result) => result.assignment.role))].map((role) => {
		const members = results
			.filter((result) => result.assignment.role === role)
			.map((result) => calculate(result.assignment.nodeId));
		return {
			id: role,
			kind: "role" as const,
			directInputTokens: members.reduce((total, cost) => total + cost.directInputTokens, 0),
			directOutputTokens: members.reduce((total, cost) => total + cost.directOutputTokens, 0),
			directCost: members.reduce((total, cost) => total + cost.directCost, 0),
			downstreamInputTokens: members.reduce((total, cost) => total + cost.directInputTokens, 0),
			downstreamOutputTokens: members.reduce((total, cost) => total + cost.directOutputTokens, 0),
			downstreamCost: members.reduce((total, cost) => total + cost.directCost, 0),
		};
	});
	const roots = results
		.filter((result) => !result.assignment.parentNodeId || !byNode.has(result.assignment.parentNodeId))
		.map((result) => calculate(result.assignment.nodeId));
	const runCost: CostAttribution = {
		id: "run",
		kind: "run",
		directInputTokens: 0,
		directOutputTokens: 0,
		directCost: 0,
		downstreamInputTokens: roots.reduce((total, cost) => total + cost.downstreamInputTokens, 0),
		downstreamOutputTokens: roots.reduce((total, cost) => total + cost.downstreamOutputTokens, 0),
		downstreamCost: roots.reduce((total, cost) => total + cost.downstreamCost, 0),
	};
	const firstTerminal = events.findIndex(
		(event) => event.type === "provider_completed" || event.type === "provider_failure",
	);
	const startedBeforeFirstTerminal =
		firstTerminal < 0 ||
		events.slice(0, firstTerminal).filter((event) => event.type === "provider_request_started").length ===
			results.length;
	return {
		manifest,
		events,
		processSamples,
		costAttribution: [...nodeCosts, ...roleCosts, runCost].sort((left, right) => left.id.localeCompare(right.id)),
		summary: {
			admitted: config.assignments.length,
			started: events.filter((event) => event.type === "provider_request_started").length,
			completed: results.filter((result) => result.terminal === "completed").length,
			failed: results.filter((result) => result.terminal === "failed").length,
			delivered: events.filter((event) => event.type === "delivery_completed").length,
			cleanedUp: events.filter((event) => event.type === "cleanup_completed").length,
			independentDispatch: startedBeforeFirstTerminal,
		},
	};
}

const SECRET_KEY = /(?:authorization|api[_-]?key|token|password|secret|credential)/i;
// Benchmark evidence is content-free: payload text is replaced, never stored.
const CONTENT_KEY = /(?:message|text|thinking|prompt|output|argument|result|diagnostic|error|filename|cwd|path)/i;
const SECRET_VALUE = /(?:bearer\s+\S+|sk-[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16})/i;

/** Redacts both sensitive field names and common credential-shaped string values before any disk write. */
export function redactEvidence<T>(value: T, key?: string): T {
	if (key && (SECRET_KEY.test(key) || CONTENT_KEY.test(key))) return "[REDACTED]" as T;
	if (typeof value === "string") return (SECRET_VALUE.test(value) ? "[REDACTED]" : value) as T;
	if (Array.isArray(value)) return value.map((item) => redactEvidence(item)) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
				entryKey,
				redactEvidence(entryValue, entryKey),
			]),
		) as T;
	}
	return value;
}

/** Writes redacted, content-free evidence plus a hash-covered artifact manifest. */
export async function writeSwarmEvidence(directory: string, evidence: SwarmEvidence): Promise<void> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const redacted = redactEvidence(evidence);
	const files: Readonly<Record<string, unknown>> = {
		"events.jsonl": `${redacted.events.map((event) => canonicalJson(event)).join("\n")}\n`,
		"process-samples.json": redacted.processSamples,
		"cost-attribution.json": redacted.costAttribution,
		"summary.json": redacted.summary,
	};
	await Promise.all(
		Object.entries(files).map(([name, value]) =>
			writeFile(join(directory, name), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, {
				encoding: "utf8",
				mode: 0o600,
			}),
		),
	);
	const artifacts: EvidenceArtifact[] = await Promise.all(
		Object.keys(files)
			.sort()
			.map(async (name) => {
				const path = join(directory, name);
				const [contents, info] = await Promise.all([readFile(path), stat(path)]);
				if (!info.isFile()) throw new Error(`evidence artifact is not a regular file: ${name}`);
				return {
					path: name,
					bytes: info.size,
					sha256: createHash("sha256").update(contents).digest("hex"),
					schemaVersion: SWARM_EVIDENCE_SCHEMA_VERSION,
				};
			}),
	);
	await writeFile(
		join(directory, "manifest.json"),
		`${JSON.stringify({ ...redacted.manifest, artifacts }, null, 2)}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
}

/** Fail closed when a manifest points outside its directory or an artifact changes. */
export async function verifySwarmEvidence(directory: string): Promise<void> {
	const root = await realpath(directory);
	const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as {
		artifacts?: EvidenceArtifact[];
	};
	if (!Array.isArray(manifest.artifacts)) throw new Error("manifest has no artifact index");
	for (const artifact of manifest.artifacts) {
		if (!artifact.path || artifact.path.includes("/") || artifact.path.includes("\\"))
			throw new Error("invalid evidence artifact path");
		const path = join(root, artifact.path);
		const [resolved, contents, info] = await Promise.all([realpath(path), readFile(path), stat(path)]);
		if (!resolved.startsWith(`${root}/`) || !info.isFile())
			throw new Error(`unsafe evidence artifact: ${artifact.path}`);
		if (
			contents.byteLength !== artifact.bytes ||
			createHash("sha256").update(contents).digest("hex") !== artifact.sha256
		)
			throw new Error(`evidence artifact hash mismatch: ${artifact.path}`);
	}
}

export function createFixedFanoutScenario(fanout: (typeof SUPPORTED_SWARM_FANOUTS)[number]): SwarmBenchmarkConfig {
	return {
		scenario: `fixed-fanout-${fanout}`,
		assignments: Array.from({ length: fanout }, (_, index) => ({
			nodeId: `child-${index + 1}`,
			parentNodeId: "root",
			role: "worker",
			requested: { provider: "local-fake", model: "deterministic-v1", revision: "b00", effort: "low" },
			inputTokens: 32,
			outputTokens: 16,
		})),
		priceCard: { version: "local-fake-v1", inputPerMillionTokens: 1, outputPerMillionTokens: 2 },
	};
}
