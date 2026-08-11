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
	close(): Promise<void> | void;
}

export interface McpProbeRequest {
	method: "initialize" | "tools/list";
	params?: Record<string, unknown>;
	signal: AbortSignal;
}

export interface McpDeclarationProbeOptions {
	/** Explicit offline mode blocks before the injected transport is opened. */
	offline?: boolean;
	/** A project declaration must have passed the C05 trust boundary first. */
	trusted?: boolean;
	/** Total wall-clock budget for opening, both protocol requests, and close. */
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
		Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
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
	const controller = new AbortController();
	const deadlineTimer = setTimeout(() => controller.abort(), timeoutMs);
	let session: McpProbeSession | undefined;
	let failure = false;
	try {
		session = await withDeadline(transport.open({ url: declaration.url, signal: controller.signal }), controller.signal);
		await withDeadline(
			session.request({
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "Prime Agent" },
				},
				signal: controller.signal,
			}),
			controller.signal,
		);
		await withDeadline(session.request({ method: "tools/list", signal: controller.signal }), controller.signal);
		return { initialized: true, toolsListed: true };
	} catch (error) {
		failure = true;
		controller.abort();
		throw error instanceof Error && error.message === "MCP probe timed out."
			? error
			: publicProbeError("failed");
	} finally {
		if (session) {
			try {
				// Invoke close even after cancellation. The injected session owns its
				// local cleanup and cannot be left open by a failed handshake.
				await withDeadline(session.close(), controller.signal);
			} catch {
				// A close failure must never disclose transport data. Preserve an
				// earlier request failure, but do not report a false success when
				// cleanup itself failed or exceeded the total deadline.
				if (!failure) {
					throw controller.signal.aborted ? publicProbeError("timeout") : publicProbeError("failed");
				}
			}
		}
		clearTimeout(deadlineTimer);
	}
}
