import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HostRequestHandler } from "./kernel/index.js";
import type { CustomMessage } from "./messages.js";

export const AGENT_MESSAGE_CUSTOM_TYPE = "agent_message";
export const AGENT_MESSAGE_SKILL_NAME = "agent-message";
export const AGENT_MESSAGE_IMPORT_NAME = "agent_message";
export const AGENT_MESSAGE_SOURCE = "agent_message";
export const AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL = "Agent message received";
export const DEFAULT_AGENT_MESSAGE_MAX_CHARS = 16_384;
export const DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION = 20;
export const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY = 3;
export const DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS = 1000;

export type AgentSessionMessageDeliveryMode = "auto" | "steer" | "follow_up";
export type AgentSessionMessageDeliveryStatus = "delivered" | "queued";
export type AgentSessionMessageRuntimeKind = "top-level" | "subagent";

export interface AgentSessionMessageEndpoint {
	activeSessionId: string;
	sessionId: string;
	sessionName?: string;
	runtimeKind?: AgentSessionMessageRuntimeKind;
}

export interface AgentSessionMessageSender extends Partial<AgentSessionMessageEndpoint> {
	clientId?: string;
}

export interface AgentSessionMessageAgentSummary extends AgentSessionMessageEndpoint {
	cwd: string;
	isStreaming: boolean;
	unfinishedActionCount: number;
	parentActiveSessionId?: string;
	rlmChildId?: string;
}

export interface AgentSessionMessageListResult {
	current?: AgentSessionMessageEndpoint;
	agents: AgentSessionMessageAgentSummary[];
}

export interface AgentSessionMessagePayload {
	id: string;
	source: typeof AGENT_MESSAGE_SOURCE;
	message: string;
	from?: AgentSessionMessageSender;
	target: AgentSessionMessageEndpoint;
	deliveryMode: AgentSessionMessageDeliveryMode;
}

export interface AgentSessionMessageDetails {
	id: string;
	message: string;
	from?: AgentSessionMessageSender;
	target?: AgentSessionMessageEndpoint;
}

export interface AgentSessionMessage extends CustomMessage<AgentSessionMessageDetails> {
	customType: typeof AGENT_MESSAGE_CUSTOM_TYPE;
	content: string;
	details: AgentSessionMessageDetails;
}

export interface AgentSessionMessageReceipt {
	id: string;
	source: typeof AGENT_MESSAGE_SOURCE;
	target: AgentSessionMessageEndpoint;
	from?: AgentSessionMessageSender;
	message: string;
	// Not named "status": the kernel host bridge envelope reserves that key.
	deliveryStatus: AgentSessionMessageDeliveryStatus;
	/** Present when deliveryStatus is "delivered": the message reached the target's context. */
	deliveredAt?: string;
	/** Present when deliveryStatus is "queued": the message waits behind the target's current work. */
	queuedAt?: string;
	deliveryMode: AgentSessionMessageDeliveryMode;
}

export interface AgentSessionMessageSendInput {
	target: string;
	message: string;
	deliveryMode?: AgentSessionMessageDeliveryMode;
}

export interface AgentSessionMessageController {
	listAgents(): AgentSessionMessageListResult;
	sendAgentMessage(input: AgentSessionMessageSendInput): Promise<AgentSessionMessageReceipt>;
}

export interface AgentSessionMessageSafetyStatus {
	paused: boolean;
	maxMessageChars: number;
	maxPendingPerSession: number;
	rateLimitCapacity: number;
	rateLimitRefillMs: number;
}

export function createAgentSessionMessageId(): string {
	return `agentmsg_${randomUUID()}`;
}

export function normalizeAgentSessionMessage(message: string, maxChars = DEFAULT_AGENT_MESSAGE_MAX_CHARS): string {
	const trimmed = message.trim();
	if (!trimmed) {
		throw new Error("Agent session message cannot be empty");
	}
	if (trimmed.length > maxChars) {
		throw new Error(`Agent session message is too long: ${trimmed.length} chars exceeds ${maxChars}`);
	}
	return trimmed;
}

export function normalizeAgentSessionMessageDeliveryMode(value: unknown): AgentSessionMessageDeliveryMode | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (value === "auto" || value === "steer" || value === "follow_up") {
		return value;
	}
	throw new Error('agent_message.send mode must be "auto", "steer", or "follow_up"');
}

export function assertDirectAgentMessageTarget(target: string): string {
	const normalized = target.trim();
	if (!normalized) {
		throw new Error("Agent message target cannot be empty");
	}
	if (normalized === "*" || normalized.toLowerCase() === "all" || normalized.toLowerCase() === "broadcast") {
		throw new Error("Broadcast agent messaging is not supported");
	}
	return normalized;
}

export function assertAgentMessageQueueCapacity(
	unfinishedActionCount: number,
	maxPending = DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
): void {
	if (unfinishedActionCount >= maxPending) {
		throw new Error(
			`Target session has too many pending messages: ${unfinishedActionCount} unfinished, limit is ${maxPending}`,
		);
	}
}

export function resolveAgentSessionMessageStreamingBehavior(
	isTargetStreaming: boolean,
	deliveryMode: AgentSessionMessageDeliveryMode | undefined,
): "steer" | "followUp" | undefined {
	const mode = deliveryMode ?? "auto";
	if (!isTargetStreaming) {
		return undefined;
	}
	if (mode === "steer") {
		return "steer";
	}
	if (mode === "follow_up") {
		return "followUp";
	}
	return "steer";
}

export function parseAgentSessionMessagePromptId(text: string): string | undefined {
	const lines = text.split("\n");
	if (lines[0] !== "Agent-to-agent message received." || lines[1] !== `Source: ${AGENT_MESSAGE_SOURCE}`) {
		return undefined;
	}
	const toLineIndex = lines[2]?.startsWith("From: ") ? 3 : 2;
	if (!lines[toLineIndex]?.startsWith("To: ")) {
		return undefined;
	}
	const match = /^Message id: (agentmsg_[^\n]+)$/.exec(lines[toLineIndex + 1] ?? "");
	return match?.[1];
}

export function isAgentSessionMessagePrompt(text: string): boolean {
	return parseAgentSessionMessagePromptId(text) !== undefined;
}

export function createAgentSessionMessagePrompt(payload: AgentSessionMessagePayload): string {
	const lines = ["Agent-to-agent message received.", `Source: ${payload.source}`];
	if (payload.from) {
		lines.push(`From: ${formatAgentSessionMessageSender(payload.from)}`);
	}
	lines.push(`To: ${formatAgentSessionMessageEndpoint(payload.target)}`);
	lines.push(`Message id: ${payload.id}`);
	lines.push("");
	lines.push(payload.message);
	return lines.join("\n");
}

export function createAgentSessionMessage(
	payload: AgentSessionMessagePayload,
	timestamp = Date.now(),
): AgentSessionMessage {
	return {
		role: "custom",
		customType: AGENT_MESSAGE_CUSTOM_TYPE,
		content: createAgentSessionMessagePrompt(payload),
		display: true,
		details: {
			id: payload.id,
			message: payload.message,
			from: payload.from,
			target: payload.target,
		},
		timestamp,
	};
}

export function isAgentSessionMessage(message: AgentMessage): message is AgentSessionMessage {
	if (message.role !== "custom" || message.customType !== AGENT_MESSAGE_CUSTOM_TYPE) {
		return false;
	}
	const details = message.details;
	return (
		typeof details === "object" &&
		details !== null &&
		typeof (details as { id?: unknown }).id === "string" &&
		typeof (details as { message?: unknown }).message === "string"
	);
}

export function createAgentSessionMessageReceipt(
	payload: AgentSessionMessagePayload,
	status: AgentSessionMessageDeliveryStatus,
	at = new Date().toISOString(),
): AgentSessionMessageReceipt {
	return {
		id: payload.id,
		source: payload.source,
		target: payload.target,
		from: payload.from,
		message: payload.message,
		deliveryStatus: status,
		...(status === "delivered" ? { deliveredAt: at } : { queuedAt: at }),
		deliveryMode: payload.deliveryMode,
	};
}

export interface AgentSessionMessageRateLimiterOptions {
	capacity?: number;
	refillMs?: number;
	now?: () => number;
}

export class AgentSessionMessageRateLimiter {
	private readonly capacity: number;
	private readonly refillMs: number;
	private readonly now: () => number;
	private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

	constructor(options: AgentSessionMessageRateLimiterOptions = {}) {
		this.capacity = options.capacity ?? DEFAULT_AGENT_MESSAGE_RATE_LIMIT_CAPACITY;
		this.refillMs = options.refillMs ?? DEFAULT_AGENT_MESSAGE_RATE_LIMIT_REFILL_MS;
		this.now = options.now ?? (() => Date.now());
	}

	tryConsume(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
		const now = this.now();
		const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now };
		const elapsed = Math.max(0, now - bucket.updatedAt);
		const refilledTokens = Math.floor(elapsed / this.refillMs);
		if (refilledTokens > 0) {
			bucket.tokens = Math.min(this.capacity, bucket.tokens + refilledTokens);
			bucket.updatedAt += refilledTokens * this.refillMs;
		}
		if (bucket.tokens <= 0) {
			this.buckets.set(key, bucket);
			return { ok: false, retryAfterMs: Math.max(1, bucket.updatedAt + this.refillMs - now) };
		}
		bucket.tokens -= 1;
		this.buckets.set(key, bucket);
		return { ok: true };
	}

	refund(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket) {
			return;
		}
		bucket.tokens = Math.min(this.capacity, bucket.tokens + 1);
		this.buckets.set(key, bucket);
	}

	clear(key?: string): void {
		if (key) {
			this.buckets.delete(key);
			return;
		}
		this.buckets.clear();
	}

	clearMatching(predicate: (key: string) => boolean): void {
		for (const key of this.buckets.keys()) {
			if (predicate(key)) {
				this.buckets.delete(key);
			}
		}
	}
}

export function createAgentMessageHostHandlers(
	controller: AgentSessionMessageController,
): Record<string, HostRequestHandler> {
	return {
		"agent_message.list": async () => controller.listAgents() as unknown as Record<string, unknown>,
		"agent_message.send": async (payload) => {
			if (typeof payload.target !== "string") {
				throw new Error("agent_message.send target must be a string");
			}
			if (typeof payload.message !== "string") {
				throw new Error("agent_message.send message must be a string");
			}
			return (await controller.sendAgentMessage({
				target: payload.target,
				message: payload.message,
				deliveryMode: normalizeAgentSessionMessageDeliveryMode(payload.mode),
			})) as unknown as Record<string, unknown>;
		},
	};
}

function formatAgentSessionMessageMetadata(value: string): string {
	return value.replace(/[\s,]+/g, " ").trim();
}

function formatAgentSessionMessageSender(sender: AgentSessionMessageSender): string {
	const parts: string[] = [];
	if (sender.sessionName) {
		const sessionName = formatAgentSessionMessageMetadata(sender.sessionName);
		if (sessionName) {
			parts.push(sessionName);
		}
	}
	if (sender.activeSessionId) {
		parts.push(`active ${formatAgentSessionMessageMetadata(sender.activeSessionId)}`);
	}
	if (sender.sessionId) {
		parts.push(`session ${formatAgentSessionMessageMetadata(sender.sessionId)}`);
	}
	if (sender.clientId) {
		parts.push(`client ${formatAgentSessionMessageMetadata(sender.clientId)}`);
	}
	return parts.length > 0 ? parts.join(", ") : "unknown sender";
}

function formatAgentSessionMessageEndpoint(endpoint: AgentSessionMessageEndpoint): string {
	const name = endpoint.sessionName ? `${formatAgentSessionMessageMetadata(endpoint.sessionName)}, ` : "";
	return `${name}active ${formatAgentSessionMessageMetadata(endpoint.activeSessionId)}, session ${formatAgentSessionMessageMetadata(endpoint.sessionId)}`;
}
