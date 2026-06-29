import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "./extensions/types.js";

export type AgentCronJobStatus = "active" | "paused" | "completed" | "cancelled";
export type AgentCronScheduleKind = "once" | "cron" | "interval";
export type AgentCronJobSource = "cron" | "heartbeat" | "rlm_heartbeat";
export type AgentCronJobRuntimeKind = "top-level" | "subagent";
export type AgentHeartbeatUpdateAction = "pause" | "resume" | "clear";
export type AgentRlmHeartbeatStatusUpdate = "pause" | "resume";

export interface AgentCronSchedule {
	kind: AgentCronScheduleKind;
	expression: string;
	intervalMs?: number;
}

export interface AgentCronJob {
	id: string;
	status: AgentCronJobStatus;
	source?: AgentCronJobSource;
	runtimeKind?: AgentCronJobRuntimeKind;
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	label?: string;
	prompt: string;
	schedule: AgentCronSchedule;
	createdAt: string;
	updatedAt: string;
	nextRunAt?: string;
	lastRunAt?: string;
	lastSkippedAt?: string;
	lastError?: string;
	runCount: number;
}

export interface CreateAgentCronJobInput {
	activeSessionId: string;
	sessionId: string;
	sessionFile: string;
	cwd: string;
	label?: string;
	prompt: string;
	scheduleText: string;
	source?: AgentCronJobSource;
	runtimeKind?: AgentCronJobRuntimeKind;
	now?: Date;
}

export type AgentCronJobRunResult = "ran" | "skipped";

export interface AgentCronSchedulerHooks {
	runJob: (job: AgentCronJob) => Promise<AgentCronJobRunResult | undefined>;
	now?: () => Date;
	onError?: (job: AgentCronJob, error: unknown) => void;
}

export interface HeartbeatCronSessionActivity {
	isStreaming: boolean;
	isBashRunning: boolean;
	pendingMessageCount: number;
}

interface CronJobsFile {
	jobs?: unknown;
}

const MAX_TIMEOUT_MS = 2_147_483_647;
const ONE_SECOND_MS = 1000;
const ONE_MINUTE_MS = 60_000;
export const DEFAULT_HEARTBEAT_SCHEDULE = "every 5m";

export type ParsedHeartbeatCommand =
	| { type: "status" }
	| { type: "pause" }
	| { type: "resume" }
	| { type: "clear" }
	| { type: "set"; schedule: string; instruction: string };

export interface AgentCronToolController {
	getHeartbeat(): AgentCronJob | undefined;
}

export interface AgentRlmHeartbeatController {
	listRlmHeartbeats(options?: { includeInactive?: boolean }): AgentCronJob[];
	createRlmHeartbeat(input: { instruction: string; interval?: string; label?: string }): AgentCronJob;
	updateRlmHeartbeat(input: {
		id: string;
		instruction?: string;
		interval?: string;
		label?: string;
		status?: AgentRlmHeartbeatStatusUpdate;
	}): AgentCronJob | undefined;
	deleteRlmHeartbeat(id: string): AgentCronJob | undefined;
}

export class AgentCronJobStore {
	constructor(private readonly filePath: string) {}

	list(): AgentCronJob[] {
		return this.readJobs().sort((a, b) => compareOptionalIso(a.nextRunAt, b.nextRunAt));
	}

	create(input: CreateAgentCronJobInput): AgentCronJob {
		const now = input.now ?? new Date();
		const prompt = input.prompt.trim();
		if (!prompt) {
			throw new Error("Cron job prompt cannot be empty");
		}
		const parsed = parseAgentCronSchedule(input.scheduleText, now);
		const nowIso = now.toISOString();
		const job: AgentCronJob = {
			id: randomUUID(),
			status: "active",
			source: input.source ?? "cron",
			runtimeKind: input.runtimeKind,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: normalizeOptionalLabel(input.label),
			prompt,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.writeJobs([...this.readJobs(), job]);
		return job;
	}

	/**
	 * Active session ids are daemon-local. When a persisted session is restored,
	 * bind jobs stored for its stable session file to the new live session id.
	 * When a live session switches to another persisted file, move jobs stored for
	 * its stable active session id to the new file so future restores target the
	 * current session instead of the previous one.
	 */
	rebindSessionJobs(input: {
		activeSessionId: string;
		sessionId: string;
		sessionFile: string;
		cwd: string;
	}): AgentCronJob[] {
		const targetSessionFile = resolve(input.sessionFile);
		const reboundJobs: AgentCronJob[] = [];
		const jobs = this.readJobs().map((job) => {
			if (job.activeSessionId !== input.activeSessionId && resolve(job.sessionFile) !== targetSessionFile) {
				return job;
			}
			if (
				job.activeSessionId === input.activeSessionId &&
				job.sessionId === input.sessionId &&
				resolve(job.sessionFile) === targetSessionFile &&
				job.cwd === input.cwd
			) {
				return job;
			}
			const rebound = {
				...job,
				activeSessionId: input.activeSessionId,
				sessionId: input.sessionId,
				sessionFile: input.sessionFile,
				cwd: input.cwd,
			};
			reboundJobs.push(rebound);
			return rebound;
		});
		if (reboundJobs.length > 0) {
			this.writeJobs(jobs);
		}
		return reboundJobs;
	}

	getHeartbeat(activeSessionId: string): AgentCronJob | undefined {
		return this.readJobs()
			.filter((job) => {
				return (
					job.activeSessionId === activeSessionId &&
					job.source === "heartbeat" &&
					(job.status === "active" || job.status === "paused")
				);
			})
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
	}

	createHeartbeat(input: CreateAgentCronJobInput): AgentCronJob {
		const now = input.now ?? new Date();
		const parsed = parseAgentCronSchedule(input.scheduleText, now);
		if (parsed.schedule.kind === "once") {
			throw new Error("Heartbeat schedule must be recurring");
		}
		const existing = this.readJobs().map((job) => {
			if (
				job.activeSessionId === input.activeSessionId &&
				job.source === "heartbeat" &&
				(job.status === "active" || job.status === "paused")
			) {
				return { ...job, status: "cancelled" as const, nextRunAt: undefined, updatedAt: now.toISOString() };
			}
			return job;
		});
		const prompt = input.prompt.trim();
		if (!prompt) {
			throw new Error("Heartbeat instruction cannot be empty");
		}
		const nowIso = now.toISOString();
		const job: AgentCronJob = {
			id: randomUUID(),
			status: "active",
			source: "heartbeat",
			runtimeKind: input.runtimeKind,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: normalizeOptionalLabel(input.label),
			prompt,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.writeJobs([...existing, job]);
		return job;
	}

	listRlmHeartbeats(activeSessionId: string, options: { includeInactive?: boolean } = {}): AgentCronJob[] {
		return this.readJobs()
			.filter((job) => {
				if (job.activeSessionId !== activeSessionId || job.source !== "rlm_heartbeat") {
					return false;
				}
				if (options.includeInactive) {
					return true;
				}
				return job.status === "active" || job.status === "paused";
			})
			.sort((a, b) => compareOptionalIso(a.nextRunAt, b.nextRunAt));
	}

	createRlmHeartbeat(input: CreateAgentCronJobInput): AgentCronJob {
		const now = input.now ?? new Date();
		const parsed = parseAgentCronSchedule(input.scheduleText, now);
		if (parsed.schedule.kind === "once") {
			throw new Error("RLM heartbeat schedule must be recurring");
		}
		const prompt = input.prompt.trim();
		if (!prompt) {
			throw new Error("RLM heartbeat instruction cannot be empty");
		}
		const nowIso = now.toISOString();
		const job: AgentCronJob = {
			id: randomUUID(),
			status: "active",
			source: "rlm_heartbeat",
			runtimeKind: input.runtimeKind,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			sessionFile: input.sessionFile,
			cwd: input.cwd,
			label: normalizeOptionalLabel(input.label),
			prompt,
			schedule: parsed.schedule,
			createdAt: nowIso,
			updatedAt: nowIso,
			nextRunAt: parsed.nextRunAt.toISOString(),
			runCount: 0,
		};
		this.writeJobs([...this.readJobs(), job]);
		return job;
	}

	updateRlmHeartbeat(
		activeSessionId: string,
		id: string,
		update: {
			label?: string;
			prompt?: string;
			scheduleText?: string;
			status?: AgentRlmHeartbeatStatusUpdate;
			now?: Date;
		},
	): AgentCronJob | undefined {
		const now = update.now ?? new Date();
		let updated: AgentCronJob | undefined;
		let matchedRlmHeartbeat = false;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.activeSessionId !== activeSessionId || job.source !== "rlm_heartbeat") {
				return job;
			}
			matchedRlmHeartbeat = true;
			if (job.status === "cancelled" || job.status === "completed") {
				return job;
			}
			let nextJob: AgentCronJob = { ...job };
			if (update.label !== undefined) {
				nextJob = { ...nextJob, label: normalizeOptionalLabel(update.label) };
			}
			if (update.prompt !== undefined) {
				const prompt = update.prompt.trim();
				if (!prompt) {
					throw new Error("RLM heartbeat instruction cannot be empty");
				}
				nextJob = { ...nextJob, prompt };
			}
			if (update.scheduleText !== undefined) {
				const parsed = parseAgentCronSchedule(update.scheduleText, now);
				if (parsed.schedule.kind === "once") {
					throw new Error("RLM heartbeat schedule must be recurring");
				}
				nextJob =
					nextJob.status === "paused"
						? withoutNextRunAt({ ...nextJob, schedule: parsed.schedule })
						: { ...nextJob, schedule: parsed.schedule, nextRunAt: parsed.nextRunAt.toISOString() };
			}
			if (update.status === "pause") {
				nextJob = withoutNextRunAt({ ...nextJob, status: "paused" });
			} else if (update.status === "resume") {
				const nextRunAt = nextRunAtForSchedule(nextJob.schedule, now);
				if (!nextRunAt) {
					throw new Error("RLM heartbeat schedule must be recurring");
				}
				nextJob = { ...nextJob, status: "active", nextRunAt: nextRunAt.toISOString() };
			}
			updated = { ...nextJob, updatedAt: now.toISOString() };
			return updated;
		});
		if (matchedRlmHeartbeat && updated) {
			this.writeJobs(jobs);
		}
		return updated;
	}

	deleteRlmHeartbeat(activeSessionId: string, id: string, now = new Date()): AgentCronJob | undefined {
		let deleted: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.activeSessionId !== activeSessionId || job.source !== "rlm_heartbeat") {
				return job;
			}
			deleted = withoutNextRunAt({ ...job, status: "cancelled", updatedAt: now.toISOString() });
			return deleted;
		});
		if (deleted) {
			this.writeJobs(jobs);
		}
		return deleted;
	}

	cancelRlmHeartbeatsForSession(activeSessionId: string, now = new Date()): AgentCronJob[] {
		const cancelled: AgentCronJob[] = [];
		const jobs = this.readJobs().map((job) => {
			if (
				job.activeSessionId !== activeSessionId ||
				job.source !== "rlm_heartbeat" ||
				(job.status !== "active" && job.status !== "paused")
			) {
				return job;
			}
			const cancelledJob = withoutNextRunAt({ ...job, status: "cancelled", updatedAt: now.toISOString() });
			cancelled.push(cancelledJob);
			return cancelledJob;
		});
		if (cancelled.length > 0) {
			this.writeJobs(jobs);
		}
		return cancelled;
	}

	pauseHeartbeat(activeSessionId: string, now = new Date()): AgentCronJob | undefined {
		let paused: AgentCronJob | undefined;
		const current = this.getHeartbeat(activeSessionId);
		if (!current) {
			return undefined;
		}
		const jobs = this.readJobs().map((job) => {
			if (job.id !== current.id) {
				return job;
			}
			paused = { ...job, status: "paused", nextRunAt: undefined, updatedAt: now.toISOString() };
			return paused;
		});
		this.writeJobs(jobs);
		return paused;
	}

	resumeHeartbeat(activeSessionId: string, now = new Date()): AgentCronJob | undefined {
		let resumed: AgentCronJob | undefined;
		const current = this.getHeartbeat(activeSessionId);
		if (!current) {
			return undefined;
		}
		const nextRunAt = nextRunAtForSchedule(current.schedule, now);
		if (!nextRunAt) {
			throw new Error("Heartbeat schedule must be recurring");
		}
		const jobs = this.readJobs().map((job) => {
			if (job.id !== current.id) {
				return job;
			}
			resumed = { ...job, status: "active", nextRunAt: nextRunAt.toISOString(), updatedAt: now.toISOString() };
			return resumed;
		});
		this.writeJobs(jobs);
		return resumed;
	}

	clearHeartbeat(activeSessionId: string, now = new Date()): AgentCronJob | undefined {
		let cleared: AgentCronJob | undefined;
		const current = this.getHeartbeat(activeSessionId);
		if (!current) {
			return undefined;
		}
		const jobs = this.readJobs().map((job) => {
			if (job.id !== current.id) {
				return job;
			}
			cleared = { ...job, status: "cancelled", nextRunAt: undefined, updatedAt: now.toISOString() };
			return cleared;
		});
		this.writeJobs(jobs);
		return cleared;
	}

	cancel(id: string, now = new Date()): AgentCronJob | undefined {
		let cancelled: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id || job.status === "cancelled") {
				return job;
			}
			cancelled = { ...job, status: "cancelled", nextRunAt: undefined, updatedAt: now.toISOString() };
			return cancelled;
		});
		if (cancelled) {
			this.writeJobs(jobs);
		}
		return cancelled;
	}

	recordRunResult(id: string, result: { now?: Date; error?: unknown }): AgentCronJob | undefined {
		const now = result.now ?? new Date();
		let updated: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id) {
				return job;
			}
			if (job.status !== "active") {
				updated = job;
				return job;
			}
			const lastError = result.error === undefined ? undefined : errorMessage(result.error);
			const nextRunAt =
				job.schedule.kind === "cron"
					? nextRunAtForSchedule(job.schedule, new Date(now.getTime() + 1))
					: job.schedule.kind === "interval"
						? nextRunAtForSchedule(job.schedule, now)
						: undefined;
			updated = {
				...job,
				status: job.schedule.kind === "once" ? "completed" : "active",
				nextRunAt: nextRunAt?.toISOString(),
				lastRunAt: now.toISOString(),
				lastError,
				runCount: job.runCount + 1,
				updatedAt: now.toISOString(),
			};
			return updated;
		});
		if (updated) {
			this.writeJobs(jobs);
		}
		return updated;
	}

	recordSkipResult(id: string, result: { now?: Date }): AgentCronJob | undefined {
		const now = result.now ?? new Date();
		let updated: AgentCronJob | undefined;
		const jobs = this.readJobs().map((job) => {
			if (job.id !== id) {
				return job;
			}
			if (job.status !== "active") {
				updated = job;
				return job;
			}
			const nextRunAt = nextRunAtForSchedule(job.schedule, now);
			updated = {
				...job,
				nextRunAt: nextRunAt?.toISOString(),
				lastSkippedAt: now.toISOString(),
				updatedAt: now.toISOString(),
			};
			return updated;
		});
		if (updated) {
			this.writeJobs(jobs);
		}
		return updated;
	}

	due(now = new Date()): AgentCronJob[] {
		return this.readJobs().filter((job) => isDueJob(job, now));
	}

	getDueJob(id: string, now = new Date()): AgentCronJob | undefined {
		return this.readJobs().find((job) => job.id === id && isDueJob(job, now));
	}

	nextActiveRunAt(): Date | undefined {
		const times = this.readJobs()
			.filter((job) => job.status === "active" && job.nextRunAt !== undefined)
			.map((job) => new Date(job.nextRunAt!))
			.filter((date) => Number.isFinite(date.getTime()))
			.sort((a, b) => a.getTime() - b.getTime());
		return times[0];
	}

	private readJobs(): AgentCronJob[] {
		if (!existsSync(this.filePath)) {
			return [];
		}
		const parsed = JSON.parse(readFileSync(this.filePath, "utf-8")) as CronJobsFile;
		if (!Array.isArray(parsed.jobs)) {
			return [];
		}
		return parsed.jobs.filter(isAgentCronJob);
	}

	private writeJobs(jobs: readonly AgentCronJob[]): void {
		mkdirSync(dirname(this.filePath), { recursive: true });
		const mergedJobs = mergeFreshJobs(this.readJobs(), jobs);
		const tempPath = `${this.filePath}.tmp`;
		writeFileSync(tempPath, `${JSON.stringify({ jobs: mergedJobs }, null, 2)}\n`, "utf-8");
		renameSync(tempPath, this.filePath);
	}
}

export class AgentCronScheduler {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private stopped = true;

	constructor(
		private readonly store: AgentCronJobStore,
		private readonly hooks: AgentCronSchedulerHooks,
	) {}

	start(): void {
		this.stopped = false;
		this.scheduleNext();
	}

	stop(): void {
		this.stopped = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	wake(): void {
		if (this.stopped) {
			return;
		}
		this.scheduleNext(0);
	}

	async runDue(now = this.now()): Promise<number> {
		if (this.running) {
			return 0;
		}
		this.running = true;
		let handled = 0;
		try {
			for (const dueJob of this.store.due(now)) {
				const job = this.store.getDueJob(dueJob.id, now);
				if (!job) {
					continue;
				}
				let runResult: AgentCronJobRunResult | undefined;
				let error: unknown;
				try {
					runResult = await this.hooks.runJob(job);
				} catch (runError) {
					error = runError;
					this.hooks.onError?.(job, runError);
				}
				if (runResult === "skipped" && error === undefined) {
					this.store.recordSkipResult(job.id, { now: this.now() });
					continue;
				}
				handled++;
				this.store.recordRunResult(job.id, { now: this.now(), error });
			}
		} finally {
			this.running = false;
			if (!this.stopped) {
				this.scheduleNext();
			}
		}
		return handled;
	}

	private scheduleNext(delayMs?: number): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		const now = this.now();
		const nextDelay =
			delayMs ??
			(() => {
				const next = this.store.nextActiveRunAt();
				if (!next) {
					return undefined;
				}
				return Math.max(0, next.getTime() - now.getTime());
			})();
		if (nextDelay === undefined) {
			return;
		}
		this.timer = setTimeout(
			() => {
				void this.runDue();
			},
			Math.min(nextDelay, MAX_TIMEOUT_MS),
		);
	}

	private now(): Date {
		return this.hooks.now?.() ?? new Date();
	}
}

export function parseAgentCronSchedule(
	input: string,
	now = new Date(),
): { schedule: AgentCronSchedule; nextRunAt: Date } {
	const text = stripMatchingQuotes(input.trim());
	if (!text) {
		throw new Error("Cron schedule cannot be empty");
	}

	const inMatch = /^in\s+(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i.exec(text);
	if (inMatch) {
		const amount = Number.parseInt(inMatch[1]!, 10);
		const unit = inMatch[2]!.toLowerCase();
		const multiplier = unit.startsWith("m")
			? ONE_MINUTE_MS
			: unit.startsWith("h")
				? 60 * ONE_MINUTE_MS
				: 24 * 60 * ONE_MINUTE_MS;
		return {
			schedule: { kind: "once", expression: text },
			nextRunAt: new Date(now.getTime() + amount * multiplier),
		};
	}

	const everyMatch =
		/^(?:every|each)\s+(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.exec(
			text,
		);
	if (everyMatch) {
		const amount = Number.parseInt(everyMatch[1]!, 10);
		const unit = everyMatch[2]!.toLowerCase();
		const multiplier = unit.startsWith("s")
			? ONE_SECOND_MS
			: unit.startsWith("m")
				? ONE_MINUTE_MS
				: 60 * ONE_MINUTE_MS;
		const intervalMs = amount * multiplier;
		if (intervalMs < 10 * ONE_SECOND_MS) {
			throw new Error("Recurring interval must be at least 10 seconds");
		}
		return {
			schedule: { kind: "interval", expression: text, intervalMs },
			nextRunAt: new Date(now.getTime() + intervalMs),
		};
	}

	if (text.toLowerCase().startsWith("at ")) {
		const when = new Date(text.slice(3).trim());
		if (!Number.isFinite(when.getTime())) {
			throw new Error("Invalid one-shot schedule. Use: at <ISO date>");
		}
		if (when.getTime() <= now.getTime()) {
			throw new Error("One-shot schedule must be in the future");
		}
		return { schedule: { kind: "once", expression: text }, nextRunAt: when };
	}

	const expression = normalizeCronAlias(text);
	const nextRunAt = nextCronRunAfter(expression, now);
	return { schedule: { kind: "cron", expression }, nextRunAt };
}

export function normalizeHeartbeatSchedule(input: string | undefined): string {
	const text = input?.trim();
	if (!text) {
		return DEFAULT_HEARTBEAT_SCHEDULE;
	}
	if (/^\d+\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)$/i.test(text)) {
		return `every ${text}`;
	}
	return text;
}

export function parseHeartbeatCommand(input: string): ParsedHeartbeatCommand {
	const text = input.replace(/^\/heartbeat\b/, "").trim();
	if (!text || text === "status") {
		return { type: "status" };
	}
	if (text === "pause") {
		return { type: "pause" };
	}
	if (text === "resume") {
		return { type: "resume" };
	}
	if (text === "clear" || text === "stop") {
		return { type: "clear" };
	}

	const option = consumeEveryOption(text);
	if (option) {
		if (!option.rest) {
			throw new Error("Usage: /heartbeat [--every <interval>] <instruction>");
		}
		return {
			type: "set",
			schedule: normalizeHeartbeatSchedule(option.interval),
			instruction: option.rest,
		};
	}

	const leadingSchedule = consumeLeadingEverySchedule(text);
	if (leadingSchedule) {
		if (!leadingSchedule.rest) {
			throw new Error("Usage: /heartbeat [--every <interval>] <instruction>");
		}
		return {
			type: "set",
			schedule: normalizeHeartbeatSchedule(leadingSchedule.interval),
			instruction: leadingSchedule.rest,
		};
	}

	return { type: "set", schedule: DEFAULT_HEARTBEAT_SCHEDULE, instruction: text };
}

export function nextRunAtForSchedule(schedule: AgentCronSchedule, after: Date): Date | undefined {
	if (schedule.kind === "once") {
		return undefined;
	}
	if (schedule.kind === "interval") {
		if (!schedule.intervalMs || schedule.intervalMs <= 0) {
			throw new Error(`Invalid interval schedule: ${schedule.expression}`);
		}
		return new Date(after.getTime() + schedule.intervalMs);
	}
	return nextCronRunAfter(schedule.expression, after);
}

export function formatAgentCronJob(job: AgentCronJob): string {
	const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "-";
	const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "-";
	const preview = job.prompt.replace(/\s+/g, " ").slice(0, 80);
	const error = job.lastError ? ` error=${job.lastError}` : "";
	const label = job.label ? ` label="${job.label}"` : "";
	const skipped = job.lastSkippedAt ? ` skipped=${new Date(job.lastSkippedAt).toLocaleString()}` : "";
	return `${job.id} ${job.status}${label} next=${next} last=${last}${skipped} runs=${job.runCount} schedule="${job.schedule.expression}" prompt="${preview}"${error}`;
}

export function createAgentHeartbeatToolDefinitions(controller: AgentCronToolController): ToolDefinition[] {
	return [
		{
			name: "get_heartbeat",
			label: "Get Heartbeat",
			description: "Get the persistent heartbeat configured for this daemon-backed session, if one exists.",
			promptGuidelines: [
				"Use get_heartbeat to inspect the current heartbeat before changing it, or when the user asks about heartbeat status.",
			],
			parameters: Type.Object({}, { additionalProperties: false }),
			execute: async () => {
				const job = controller.getHeartbeat();
				return {
					content: [{ type: "text", text: JSON.stringify({ heartbeat: job ?? null }, null, 2) }],
					details: job ?? null,
				};
			},
		},
	];
}

function consumeEveryOption(text: string): { interval: string; rest: string } | undefined {
	const match =
		/^--every(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours))|(\S+))(?:\s+|$)([\s\S]*)$/i.exec(
			text,
		);
	if (!match) {
		return undefined;
	}
	return {
		interval: match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
		rest: match[5]?.trim() ?? "",
	};
}

function consumeLeadingEverySchedule(text: string): { interval: string; rest: string } | undefined {
	const match =
		/^(every|each)\s+\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b/i.exec(text);
	if (!match) {
		return undefined;
	}
	return {
		interval: match[0],
		rest: text
			.slice(match[0].length)
			.trim()
			.replace(/^--\s*/, "")
			.trim(),
	};
}

export function isHeartbeatCronJob(job: AgentCronJob): boolean {
	return job.source === "heartbeat" || job.source === "rlm_heartbeat";
}

export function shouldDeferHeartbeatCronJob(job: AgentCronJob, activity: HeartbeatCronSessionActivity): boolean {
	return (
		isHeartbeatCronJob(job) && (activity.isStreaming || activity.isBashRunning || activity.pendingMessageCount > 0)
	);
}

function nextCronRunAfter(expression: string, after: Date): Date {
	const fields = parseCronExpression(expression);
	const candidate = new Date(after.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	const deadline = candidate.getTime() + 366 * 24 * 60 * ONE_MINUTE_MS;
	while (candidate.getTime() <= deadline) {
		if (matchesCronFields(candidate, fields)) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error(`Cron schedule did not match within one year: ${expression}`);
}

function parseCronExpression(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(
			"Unsupported cron schedule. Use 'in 10m', 'at <ISO date>', @hourly, or five fields: minute hour day month weekday",
		);
	}
	return {
		minute: parseCronField(parts[0]!, 0, 59),
		hour: parseCronField(parts[1]!, 0, 23),
		dayOfMonth: parseCronField(parts[2]!, 1, 31),
		month: parseCronField(parts[3]!, 1, 12),
		dayOfWeek: parseCronField(parts[4]!, 0, 7),
	};
}

interface CronFields {
	minute: Set<number>;
	hour: Set<number>;
	dayOfMonth: Set<number>;
	month: Set<number>;
	dayOfWeek: Set<number>;
}

function parseCronField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		if (!part) {
			throw new Error(`Invalid cron field: ${field}`);
		}
		const [rangeText, stepText] = part.split("/");
		const step = stepText === undefined ? 1 : parseCronNumber(stepText, 1, max);
		let start: number;
		let end: number;
		if (rangeText === "*") {
			start = min;
			end = max;
		} else if (rangeText?.includes("-")) {
			const [startText, endText] = rangeText.split("-");
			start = parseCronNumber(startText, min, max);
			end = parseCronNumber(endText, min, max);
			if (start > end) {
				throw new Error(`Invalid cron range: ${rangeText}`);
			}
		} else {
			start = parseCronNumber(rangeText, min, max);
			end = start;
		}
		for (let value = start; value <= end; value += step) {
			values.add(value);
		}
	}
	return values;
}

function parseCronNumber(value: string | undefined, min: number, max: number): number {
	if (!value || !/^\d+$/.test(value)) {
		throw new Error(`Invalid cron number: ${value ?? ""}`);
	}
	const parsed = Number.parseInt(value, 10);
	if (parsed < min || parsed > max) {
		throw new Error(`Cron number out of range: ${value}`);
	}
	return parsed;
}

function matchesCronFields(date: Date, fields: CronFields): boolean {
	const day = date.getDay();
	const dayMatches = fields.dayOfWeek.has(day) || (day === 0 && fields.dayOfWeek.has(7));
	return (
		fields.minute.has(date.getMinutes()) &&
		fields.hour.has(date.getHours()) &&
		fields.dayOfMonth.has(date.getDate()) &&
		fields.month.has(date.getMonth() + 1) &&
		dayMatches
	);
}

function normalizeCronAlias(text: string): string {
	switch (text) {
		case "@hourly":
			return "0 * * * *";
		case "@daily":
			return "0 0 * * *";
		case "@weekly":
			return "0 0 * * 0";
		case "@monthly":
			return "0 0 1 * *";
		default:
			return text;
	}
}

function stripMatchingQuotes(value: string): string {
	if (
		value.length >= 2 &&
		((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
	) {
		return value.slice(1, -1);
	}
	return value;
}

function isDueJob(job: AgentCronJob, now: Date): boolean {
	return job.status === "active" && job.nextRunAt !== undefined && Date.parse(job.nextRunAt) <= now.getTime();
}

function mergeFreshJobs(currentJobs: readonly AgentCronJob[], nextJobs: readonly AgentCronJob[]): AgentCronJob[] {
	const merged = new Map<string, AgentCronJob>();
	for (const job of currentJobs) {
		merged.set(job.id, job);
	}
	for (const job of nextJobs) {
		const current = merged.get(job.id);
		if (!current || isAtLeastAsFresh(job, current)) {
			merged.set(job.id, job);
		}
	}
	return [...merged.values()];
}

function isAtLeastAsFresh(candidate: AgentCronJob, current: AgentCronJob): boolean {
	const candidateTime = Date.parse(candidate.updatedAt);
	const currentTime = Date.parse(current.updatedAt);
	if (!Number.isFinite(currentTime)) {
		return true;
	}
	if (!Number.isFinite(candidateTime)) {
		return false;
	}
	return candidateTime >= currentTime;
}

function compareOptionalIso(left: string | undefined, right: string | undefined): number {
	if (left === right) {
		return 0;
	}
	if (left === undefined) {
		return 1;
	}
	if (right === undefined) {
		return -1;
	}
	return Date.parse(left) - Date.parse(right);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeOptionalLabel(label: string | undefined): string | undefined {
	const trimmed = label?.trim();
	return trimmed ? trimmed : undefined;
}

function withoutNextRunAt(job: AgentCronJob): AgentCronJob {
	const { nextRunAt: _nextRunAt, ...rest } = job;
	return rest;
}

function isAgentCronJob(value: unknown): value is AgentCronJob {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<AgentCronJob>;
	return (
		typeof candidate.id === "string" &&
		(candidate.status === "active" ||
			candidate.status === "paused" ||
			candidate.status === "completed" ||
			candidate.status === "cancelled") &&
		(candidate.source === undefined ||
			candidate.source === "cron" ||
			candidate.source === "heartbeat" ||
			candidate.source === "rlm_heartbeat") &&
		(candidate.runtimeKind === undefined ||
			candidate.runtimeKind === "top-level" ||
			candidate.runtimeKind === "subagent") &&
		typeof candidate.activeSessionId === "string" &&
		typeof candidate.sessionId === "string" &&
		typeof candidate.sessionFile === "string" &&
		typeof candidate.cwd === "string" &&
		(candidate.label === undefined || typeof candidate.label === "string") &&
		typeof candidate.prompt === "string" &&
		typeof candidate.schedule === "object" &&
		candidate.schedule !== null &&
		(candidate.schedule.kind === "once" ||
			candidate.schedule.kind === "cron" ||
			(candidate.schedule.kind === "interval" &&
				typeof candidate.schedule.intervalMs === "number" &&
				candidate.schedule.intervalMs > 0)) &&
		typeof candidate.schedule.expression === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string" &&
		typeof candidate.runCount === "number"
	);
}
