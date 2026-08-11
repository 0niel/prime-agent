import { VERSION } from "../../config.js";
import type { McpDeclaration } from "./mcp-declarations.js";

/** The probe never constructs a network client. Callers must inject a local test transport. */
export interface McpProbeTransport {
	open(request: McpProbeOpenRequest): Promise<McpProbeSession>;
}

export interface McpProbeOpenRequest {
	url: string;
	signal: AbortSignal;
}

export interface McpProbeSession {
	request(request: McpProbeRequest): Promise<unknown>;
	notification(notification: McpProbeNotification): Promise<void> | void;
	close(): Promise<void> | void;
}

export interface McpProbeRequest {
	method: "initialize" | "tools/list";
	params?: Record<string, unknown>;
	signal: AbortSignal;
}

export interface McpProbeNotification {
	method: "notifications/initialized";
	signal: AbortSignal;
}

export interface McpDeclarationProbeOptions {
	/** Explicit offline mode blocks before the injected transport is opened. */
	offline?: boolean;
	/** A project declaration must have passed the C05 trust boundary first. */
	trusted?: boolean;
	/** Total wall-clock budget for opening and protocol requests. */
	timeoutMs?: number;
}

export interface McpDeclarationProbeResult {
	initialized: true;
	toolsListed: true;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;

function boundedTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value) || value <= 0) throw new Error("MCP probe timeout must be a positive finite number.");
	return Math.min(Math.floor(value), MAX_TIMEOUT_MS);
}

function publicProbeError(kind: "disabled" | "offline" | "untrusted" | "timeout" | "failed"): Error {
	// Never expose endpoint, transport, or protocol error text: any of these can
	// carry an accidentally credential-bearing URL or response payload.
	if (kind === "disabled") return new Error("MCP probe is unavailable because this declaration is disabled.");
	if (kind === "offline") return new Error("MCP probe is unavailable while offline.");
	if (kind === "untrusted") return new Error("MCP probe is unavailable because this declaration is not trusted.");
	if (kind === "timeout") return new Error("MCP probe timed out.");
	return new Error("MCP probe failed.");
}

function withDeadline<T>(promise: Promise<T> | T, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(publicProbeError("timeout"));
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
		Promise.resolve(promise)
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

/**
 * Executes the smallest possible read-only MCP handshake using an injected
 * transport. It has no SDK, fetch, auth, or endpoint implementation, and is
 * therefore usable only by an explicitly supplied local fake/adapter.
 */
export async function runMcpDeclarationProbe(
	declaration: McpDeclaration,
	transport: McpProbeTransport,
	options: McpDeclarationProbeOptions = {},
): Promise<McpDeclarationProbeResult> {
	// These guards intentionally precede *all* transport work.
	if (!declaration.enabled) throw publicProbeError("disabled");
	if (options.offline) throw publicProbeError("offline");
	if (options.trusted !== true) throw publicProbeError("untrusted");

	const timeoutMs = boundedTimeout(options.timeoutMs);
	const operationController = new AbortController();
	const operationDeadline = setTimeout(() => operationController.abort(), timeoutMs);
	let session: McpProbeSession | undefined;
	let failure: Error | undefined;
	try {
		session = await withDeadline(
			transport.open({ url: declaration.url, signal: operationController.signal }),
			operationController.signal,
		);
		await withDeadline(
			session.request({
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "Prime Agent", version: VERSION },
				},
				signal: operationController.signal,
			}),
			operationController.signal,
		);
		await withDeadline(
			session.notification({ method: "notifications/initialized", signal: operationController.signal }),
			operationController.signal,
		);
		await withDeadline(
			session.request({ method: "tools/list", signal: operationController.signal }),
			operationController.signal,
		);
	} catch (error) {
		operationController.abort();
		failure = error instanceof Error && error.message === "MCP probe timed out." ? error : publicProbeError("failed");
	} finally {
		clearTimeout(operationDeadline);
		if (session) {
			// Cleanup deliberately gets a fresh controller. An operation timeout aborts
			// its signal, but must not prevent a bounded attempt to release the session.
			const cleanupController = new AbortController();
			const cleanupDeadline = setTimeout(() => cleanupController.abort(), timeoutMs);
			try {
				await withDeadline(session.close(), cleanupController.signal);
			} catch {
				// The primary operation error always wins. Both paths intentionally
				// redact adapter details, including errors emitted during close.
				if (!failure)
					failure = cleanupController.signal.aborted ? publicProbeError("timeout") : publicProbeError("failed");
			} finally {
				clearTimeout(cleanupDeadline);
			}
		}
	}
	if (failure) throw failure;
	return { initialized: true, toolsListed: true };
}
