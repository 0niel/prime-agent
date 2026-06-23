import { Buffer } from "node:buffer";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { appendRotatingLog, getAgentTracesLogPath, VERSION } from "../config.js";
import { readFirstLineSync } from "../utils/file-lines.js";
import type { AuthStorage } from "./auth-storage.js";
import {
	loadPrimeCliConfig,
	PRIME_AGENT_TRACES_PROVIDER_ID,
	PRIME_INFERENCE_PROVIDER_ID,
	resolvePrimeAgentTracesBaseUrl,
} from "./prime-inference-auth.js";
import type { SessionHeader, SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

const MAX_TRACE_BYTES = 20 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const TRACE_UPLOAD_DEBOUNCE_MS = 1_000;
const TRACE_UPLOAD_MIN_INTERVAL_MS = 60_000;
const TRACE_UPLOAD_RETRY_DELAY_MS = 500;

export type AgentTraceCredentialSource = "environment" | "stored" | "prime-inference" | "prime-cli";

export interface AgentTraceCredential {
	apiKey: string;
	source: AgentTraceCredentialSource;
	label: string;
}

export type AgentTraceUploadResult =
	| {
			status: "uploaded";
			sessionId: string;
			traceId: string;
			bytesStored: number;
			key?: string;
	  }
	| { status: "disabled" }
	| { status: "missing_credentials" }
	| { status: "no_session_file" }
	| { status: "empty_session" }
	| { status: "invalid_session"; message: string }
	| { status: "too_large"; size: number; maxBytes: number }
	| { status: "failed"; statusCode?: number; message: string };

export interface AgentTraceUploadOptions {
	sessionFile: string | undefined;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	baseUrl?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	reloadConfig?: boolean;
	requestTimeoutMs?: number;
	signal?: AbortSignal;
}

export interface AgentTraceSessionUploadOptions extends Omit<AgentTraceUploadOptions, "sessionFile"> {
	sessionManager: SessionManager;
}

export interface AgentTraceUploadInstallOptions {
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	baseUrl?: string;
	configPath?: string;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
}

function stringEnv(name: string): string | undefined {
	const value = process.env[name];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	if (!(error instanceof Error)) {
		return String(error);
	}
	const cause = (error as { cause?: unknown }).cause;
	if (isRecord(cause)) {
		const code = typeof cause.code === "string" ? cause.code : undefined;
		const causeMessage = typeof cause.message === "string" ? cause.message : undefined;
		const detail = code ?? causeMessage;
		if (detail && detail !== error.message) {
			return `${error.message} (${detail})`;
		}
	}
	return error.message;
}

const RETRIABLE_NETWORK_CODES = new Set([
	"ECONNRESET",
	"ECONNREFUSED",
	"ECONNABORTED",
	"EPIPE",
	"ETIMEDOUT",
	"ENETUNREACH",
	"ENETDOWN",
	"EAI_AGAIN",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
]);

function isRetriableNetworkError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === "AbortError") {
		return false;
	}
	const cause = (error as { cause?: unknown }).cause;
	return isRecord(cause) && typeof cause.code === "string" && RETRIABLE_NETWORK_CODES.has(cause.code);
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
	const value = data[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(data: Record<string, unknown>, key: string): number | undefined {
	const value = data[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isSessionHeader(value: unknown): value is SessionHeader {
	return (
		isRecord(value) &&
		value.type === "session" &&
		typeof value.id === "string" &&
		typeof value.timestamp === "string" &&
		typeof value.cwd === "string" &&
		(value.parentSession === undefined || typeof value.parentSession === "string")
	);
}

function readSessionHeader(sessionFile: string): SessionHeader | undefined {
	try {
		const firstLine = readFirstLineSync(sessionFile);
		if (!firstLine?.trim()) {
			return undefined;
		}
		const parsed = JSON.parse(firstLine) as unknown;
		return isSessionHeader(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Active-branch git for the indexing headers: walk leaf to root, not the last git_state in
 * file order (which may belong to a sibling branch). */
export function activeGitContext(
	body: string,
	header: SessionHeader,
): { repoUrl?: string; commit?: string } | undefined {
	const byId = new Map<string, { parentId: string | null; type: string; git?: unknown }>();
	let leafId: string | null = null;
	for (const line of body.split("\n")) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(parsed) || parsed.type === "session" || typeof parsed.id !== "string") continue;
		byId.set(parsed.id, {
			parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
			type: typeof parsed.type === "string" ? parsed.type : "",
			git: parsed.git,
		});
		leafId = parsed.id;
	}

	let current = leafId ? byId.get(leafId) : undefined;
	for (let depth = 0; current && depth < byId.size + 1; depth += 1) {
		if (current.type === "git_state" && isRecord(current.git)) {
			return current.git as { repoUrl?: string; commit?: string };
		}
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return header.git;
}

function resolveParentSessionPath(sessionFile: string, parentSession: string): string {
	return isAbsolute(parentSession) ? parentSession : resolve(dirname(sessionFile), parentSession);
}

function resolveTraceContext(
	sessionFile: string,
	header: SessionHeader,
): { traceId: string; parentSessionId?: string } {
	let traceId = header.id;
	let parentSessionId: string | undefined;
	let currentFile = sessionFile;
	let currentHeader = header;

	for (let depth = 0; depth < 32; depth += 1) {
		if (!currentHeader.parentSession) {
			break;
		}

		const parentPath = resolveParentSessionPath(currentFile, currentHeader.parentSession);
		const parentHeader = readSessionHeader(parentPath);
		if (!parentHeader) {
			break;
		}

		if (depth === 0) {
			parentSessionId = parentHeader.id;
		}
		traceId = parentHeader.id;
		currentFile = parentPath;
		currentHeader = parentHeader;
	}

	return { traceId, parentSessionId };
}

function parseResponseObject(text: string): Record<string, unknown> | undefined {
	if (!text.trim()) {
		return undefined;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

async function readResponseMessage(response: Response): Promise<string> {
	const text = await response.text().catch(() => "");
	if (!text.trim()) {
		return response.statusText || "Unknown error";
	}

	const parsed = parseResponseObject(text);
	if (parsed) {
		const error = parsed.error;
		if (isRecord(error)) {
			const message = stringField(error, "message");
			if (message) return message;
		}
		const detail = stringField(parsed, "detail");
		if (detail) return detail;
		const message = stringField(parsed, "message");
		if (message) return message;
	}

	return text.trim();
}

async function fetchWithTimeout(
	fetchFn: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });

	try {
		return await fetchFn(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timeout = setTimeout(finish, ms);
		const onAbort = () => finish();
		function finish() {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function fetchWithRetry(
	fetchFn: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<Response> {
	try {
		return await fetchWithTimeout(fetchFn, url, init, timeoutMs, signal);
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		if (!isRetriableNetworkError(error)) {
			throw error;
		}
		await delay(TRACE_UPLOAD_RETRY_DELAY_MS, signal);
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		return await fetchWithTimeout(fetchFn, url, init, timeoutMs, signal);
	}
}

export async function getPrimeAgentTraceCredential(
	authStorage: AuthStorage,
	options: { reloadAuth?: boolean; configPath?: string } = {},
): Promise<AgentTraceCredential | undefined> {
	const traceEnvKey = stringEnv("PRIME_AGENT_TRACES_API_KEY");
	if (traceEnvKey) {
		return { apiKey: traceEnvKey, source: "environment", label: "PRIME_AGENT_TRACES_API_KEY" };
	}

	if (options.reloadAuth !== false) {
		authStorage.reload();
	}

	const traceKey = await authStorage.getApiKey(PRIME_AGENT_TRACES_PROVIDER_ID, { includeFallback: false });
	if (traceKey) {
		return { apiKey: traceKey, source: "stored", label: "Prime Agent Traces credential" };
	}

	const primeEnvKey = stringEnv("PRIME_API_KEY");
	if (primeEnvKey) {
		return { apiKey: primeEnvKey, source: "environment", label: "PRIME_API_KEY" };
	}

	const primeCredential = authStorage.get(PRIME_INFERENCE_PROVIDER_ID);
	if (primeCredential) {
		const primeKey = await authStorage.getApiKey(PRIME_INFERENCE_PROVIDER_ID, { includeFallback: false });
		if (primeKey) {
			return { apiKey: primeKey, source: "prime-inference", label: "Prime Inference credential" };
		}
	}

	const primeCliKey = loadPrimeCliConfig(options.configPath).apiKey;
	if (primeCliKey) {
		return { apiKey: primeCliKey, source: "prime-cli", label: "Prime CLI credential" };
	}

	return undefined;
}

async function getAgentTracesEnabled(
	options: Pick<AgentTraceUploadOptions, "reloadConfig" | "settingsManager">,
): Promise<boolean> {
	if (options.reloadConfig !== false) {
		await options.settingsManager.reload().catch(() => undefined);
	}
	return options.settingsManager.getAgentTracesEnabled();
}

export async function uploadAgentTraceFile(options: AgentTraceUploadOptions): Promise<AgentTraceUploadResult> {
	const result = await performAgentTraceUpload(options);
	logAgentTraceOutcome(options.sessionFile, result);
	return result;
}

function logAgentTraceOutcome(sessionFile: string | undefined, result: AgentTraceUploadResult): void {
	let line: string | undefined;
	switch (result.status) {
		case "uploaded":
			line = `uploaded session ${result.sessionId} (${result.bytesStored} bytes)`;
			break;
		case "failed":
			line = `upload failed${result.statusCode ? ` (HTTP ${result.statusCode})` : ""}: ${result.message}`;
			break;
		case "too_large":
			line = `upload skipped: session is ${result.size} bytes (limit ${result.maxBytes})`;
			break;
		case "invalid_session":
			line = `upload skipped: ${result.message}`;
			break;
		case "missing_credentials":
			line = "upload skipped: no Prime credential configured (run /traces login)";
			break;
		default:
			return;
	}
	const suffix = sessionFile ? ` [${sessionFile}]` : "";
	appendRotatingLog(getAgentTracesLogPath(), `[${new Date().toISOString()}] ${line}${suffix}`);
}

async function performAgentTraceUpload(options: AgentTraceUploadOptions): Promise<AgentTraceUploadResult> {
	if (!(await getAgentTracesEnabled(options))) {
		return { status: "disabled" };
	}
	if (!options.sessionFile) {
		return { status: "no_session_file" };
	}

	let fileSize: number;
	try {
		const stats = await stat(options.sessionFile);
		if (!stats.isFile()) {
			return { status: "no_session_file" };
		}
		fileSize = stats.size;
	} catch {
		return { status: "no_session_file" };
	}
	if (fileSize === 0) {
		return { status: "empty_session" };
	}
	if (fileSize > MAX_TRACE_BYTES) {
		return { status: "too_large", size: fileSize, maxBytes: MAX_TRACE_BYTES };
	}

	const header = readSessionHeader(options.sessionFile);
	if (!header) {
		return { status: "invalid_session", message: "Session file is missing a valid session header" };
	}

	const credential = await getPrimeAgentTraceCredential(options.authStorage, {
		configPath: options.configPath,
		reloadAuth: options.reloadConfig !== false,
	});
	if (!credential) {
		return { status: "missing_credentials" };
	}

	if (!(await getAgentTracesEnabled(options))) {
		return { status: "disabled" };
	}

	let body: string;
	try {
		body = await readFile(options.sessionFile, "utf8");
	} catch (error) {
		return { status: "failed", message: describeError(error) };
	}
	if (!body.trim()) {
		return { status: "empty_session" };
	}

	const traceContext = resolveTraceContext(options.sessionFile, header);
	const bodyBytes = Buffer.byteLength(body, "utf8");
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.apiKey}`,
		"Content-Type": "application/x-ndjson",
		Accept: "application/json",
		"Content-Length": String(bodyBytes),
		"X-Trace-Id": traceContext.traceId,
		"X-Cwd": header.cwd,
		"X-Agent-Version": VERSION,
	};
	if (traceContext.parentSessionId) {
		headers["X-Parent-Session"] = traceContext.parentSessionId;
	}
	const git = activeGitContext(body, header);
	if (git?.repoUrl) {
		headers["X-Git-Repo"] = git.repoUrl;
	}
	if (git?.commit) {
		headers["X-Git-Commit"] = git.commit;
	}

	if (!(await getAgentTracesEnabled(options))) {
		return { status: "disabled" };
	}

	const baseUrl = resolvePrimeAgentTracesBaseUrl(options.baseUrl);
	const url = `${baseUrl}/api/v1/agent-traces/sessions/${encodeURIComponent(header.id)}`;
	const fetchFn = options.fetchFn ?? fetch;

	let response: Response;
	try {
		response = await fetchWithRetry(
			fetchFn,
			url,
			{
				method: "PUT",
				headers,
				body,
			},
			options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			options.signal,
		);
	} catch (error) {
		return { status: "failed", message: describeError(error) };
	}

	if (!response.ok) {
		return {
			status: "failed",
			statusCode: response.status,
			message: await readResponseMessage(response),
		};
	}

	const responseText = await response.text().catch(() => "");
	const responseData = parseResponseObject(responseText);
	return {
		status: "uploaded",
		sessionId: responseData ? (stringField(responseData, "session_id") ?? header.id) : header.id,
		traceId: responseData ? (stringField(responseData, "trace_id") ?? traceContext.traceId) : traceContext.traceId,
		bytesStored: responseData ? (numberField(responseData, "bytes_stored") ?? bodyBytes) : bodyBytes,
		key: responseData ? stringField(responseData, "key") : undefined,
	};
}

export function uploadAgentTraceSession(options: AgentTraceSessionUploadOptions): Promise<AgentTraceUploadResult> {
	return uploadAgentTraceFile({
		...options,
		sessionFile: options.sessionManager.getSessionFile(),
	});
}

class AgentTraceUploadController {
	private timeout: NodeJS.Timeout | undefined;
	private pending = false;
	private inFlight: Promise<AgentTraceUploadResult> | undefined;
	private flushPromise: Promise<AgentTraceUploadResult | undefined> | undefined;
	private lastUploadStartedAt: number | undefined;
	private lastUploadedSignature: string | undefined;

	constructor(
		private readonly sessionManager: SessionManager,
		private options: AgentTraceUploadInstallOptions,
	) {}

	update(options: AgentTraceUploadInstallOptions): void {
		this.options = options;
	}

	schedule = (): void => {
		this.pending = true;
		if (this.timeout) {
			clearTimeout(this.timeout);
		}
		const elapsed = this.lastUploadStartedAt === undefined ? 0 : Date.now() - this.lastUploadStartedAt;
		const throttleDelay =
			this.lastUploadStartedAt === undefined ? 0 : Math.max(0, TRACE_UPLOAD_MIN_INTERVAL_MS - elapsed);
		this.timeout = setTimeout(
			() => {
				this.timeout = undefined;
				void this.flush().catch(() => undefined);
			},
			Math.max(TRACE_UPLOAD_DEBOUNCE_MS, throttleDelay),
		);
	};

	private async getCurrentFileSignature(): Promise<string | undefined> {
		const sessionFile = this.sessionManager.getSessionFile();
		if (!sessionFile) {
			return undefined;
		}
		try {
			const stats = await stat(sessionFile);
			return `${sessionFile}:${stats.size}:${stats.mtimeMs}`;
		} catch {
			return undefined;
		}
	}

	async flush(): Promise<AgentTraceUploadResult | undefined> {
		if (this.flushPromise) {
			const result = await this.flushPromise;
			if (!this.pending) {
				return result;
			}
			return (await this.flush()) ?? result;
		}

		this.flushPromise = this.runFlush();
		try {
			return await this.flushPromise;
		} finally {
			this.flushPromise = undefined;
		}
	}

	private async runFlush(): Promise<AgentTraceUploadResult | undefined> {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = undefined;
		}
		if (this.inFlight) {
			await this.inFlight.catch(() => undefined);
		}
		if (!this.pending) {
			return undefined;
		}

		const signature = await this.getCurrentFileSignature();
		if (signature && signature === this.lastUploadedSignature) {
			this.pending = false;
			return undefined;
		}

		this.pending = false;
		this.lastUploadStartedAt = Date.now();
		this.inFlight = uploadAgentTraceSession({
			...this.options,
			sessionManager: this.sessionManager,
		});
		try {
			const result = await this.inFlight;
			if (result.status === "uploaded" && signature) {
				this.lastUploadedSignature = signature;
			}
			return result;
		} finally {
			this.inFlight = undefined;
		}
	}
}

const traceUploadControllers = new WeakMap<SessionManager, AgentTraceUploadController>();

export function installAgentTraceUpload(sessionManager: SessionManager, options: AgentTraceUploadInstallOptions): void {
	let controller = traceUploadControllers.get(sessionManager);
	if (controller) {
		controller.update(options);
		return;
	}

	controller = new AgentTraceUploadController(sessionManager, options);
	traceUploadControllers.set(sessionManager, controller);
	sessionManager.onPersist(controller.schedule);
}

export async function flushAgentTraceUpload(
	sessionManager: SessionManager,
): Promise<AgentTraceUploadResult | undefined> {
	return traceUploadControllers.get(sessionManager)?.flush();
}
