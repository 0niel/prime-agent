import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import { getSessionsDir } from "../../config.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { deleteSessionFile } from "../../core/session-file-actions.js";
import {
	readSessionInfo,
	readSessionInfoFromBuffer,
	type SessionInfo,
	SessionManager,
} from "../../core/session-manager.js";

export const DAEMON_CATALOG_ROLE_ENV = "PRIME_AGENT_INTERNAL_DAEMON_CATALOG";

interface SessionInfoWire extends Omit<SessionInfo, "created" | "modified"> {
	created: string;
	modified: string;
}

type CatalogRequest =
	| { type: "request"; id: string; command: "list"; cwd?: string; sessionDir?: string }
	| { type: "request"; id: string; command: "family"; sessionDir?: string }
	| { type: "request"; id: string; command: "resolve"; selector: string; cwd: string; sessionDir?: string }
	| { type: "request"; id: string; command: "siblings"; sessionPath: string; sessionDir?: string }
	| { type: "request"; id: string; command: "rename"; sessionPath: string; name: string }
	| { type: "request"; id: string; command: "delete"; sessionPath: string }
	| { type: "request"; id: string; command: "archive"; sessionPath: string; sessionId: string }
	| {
			type: "request";
			id: string;
			command: "mark_interrupted";
			sessionPath: string;
			activeSessionId: string;
			operations: string[];
	  }
	| { type: "request"; id: string; command: "shutdown" };

type CatalogOutbound =
	| { type: "ready" }
	| { type: "progress"; id: string; loaded: number; total: number }
	| { type: "session"; id: string; session: SessionInfoWire }
	| { type: "response"; id: string; success: true; data?: unknown }
	| { type: "response"; id: string; success: false; error: string };

interface CatalogListCallbacks {
	onProgress?: (loaded: number, total: number) => void;
	onSession?: (session: SessionInfo) => void;
}

function serializeSessionInfo(session: SessionInfo): SessionInfoWire {
	return {
		...session,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
	};
}

function deserializeSessionInfo(session: SessionInfoWire): SessionInfo {
	return {
		...session,
		created: new Date(session.created),
		modified: new Date(session.modified),
	};
}

interface SavedRlmSubagentRegistryEntry {
	type?: unknown;
	childId?: unknown;
	sessionFile?: unknown;
	status?: unknown;
}

const MAX_RLM_REGISTRY_BYTES = 1024 * 1024;
const MAX_RLM_REGISTRY_RECORDS = 10_000;
const MAX_RLM_FAMILY_EDGES = 10_000;
const MAX_RLM_FAMILY_NODES = 10_000;
const MAX_RLM_FAMILY_DEPTH = 64;

interface ManagedRoot {
	lexical: string;
	fd: number;
}

interface ManagedRoots {
	session: ManagedRoot;
	artifacts: ManagedRoot | undefined;
}

interface TrustedFile {
	path: string;
	contents: Buffer;
	mtimeMs: number;
	dev: string;
	ino: string;
}

interface TrustedSession extends SessionInfo {
	/** The header claim is intentionally separate from SessionInfo's legacy fallback. */
	persistedDepth: number;
	persistedParentPath?: string;
}

function rlmSubagentRegistryPath(parent: SessionInfo, roots: ManagedRoots): string | undefined {
	const parentDir = dirname(parent.path);
	const artifactDir =
		parentDir === roots.session.lexical ? roots.artifacts?.lexical : join(parentDir, "session-artifacts");
	return artifactDir ? join(artifactDir, parent.id, "rlm-subagents.jsonl") : undefined;
}

function isWithin(root: string, target: string): boolean {
	const path = relative(root, target);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function invalidFamilyTopology(reason: string): Error {
	return new Error(`Invalid RLM artifact family topology: ${reason}`);
}

let openAuthorityFdCountForTest = 0;
/** @internal */
export function getOpenCatalogAuthorityFdCountForTest(): number {
	return openAuthorityFdCountForTest;
}

function openAuthorityRoot(path: string, optional = false): ManagedRoot | undefined {
	try {
		// O_NOFOLLOW binds authority to the directory itself, never a pathname target.
		const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		openAuthorityFdCountForTest++;
		return { lexical: path, fd };
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw invalidFamilyTopology(`managed authority root is unavailable: ${String(error)}`);
	}
}

function managedRoots(sessionDir: string | undefined): ManagedRoots {
	const sessionLexical = resolve(sessionDir ?? "");
	const session = openAuthorityRoot(sessionLexical)!;
	try {
		const artifacts = openAuthorityRoot(join(dirname(sessionLexical), "session-artifacts"), true);
		return { session, artifacts };
	} catch (error) {
		closeSync(session.fd);
		openAuthorityFdCountForTest--;
		throw error;
	}
}

function closeManagedRoots(roots: ManagedRoots): void {
	closeSync(roots.session.fd);
	openAuthorityFdCountForTest--;
	if (roots.artifacts) {
		closeSync(roots.artifacts.fd);
		openAuthorityFdCountForTest--;
	}
}

const OPENAT_READ_HELPER = String.raw`import base64,json,os,stat,sys
MAX=134217728
def reject(): raise ValueError("invalid")
def flags(directory=False):
 value=os.O_RDONLY|os.O_NOFOLLOW
 if directory: value|=os.O_DIRECTORY
 return value
def main():
 req=json.loads(sys.stdin.buffer.read(131073))
 parts=req.get("parts"); limit=req.get("limit")
 if not isinstance(parts,list) or not parts or not isinstance(limit,int) or limit<0 or limit>MAX: reject()
 if any(not isinstance(p,str) or not p or p in (".","..") or "/" in p or "\\" in p for p in parts): reject()
 current=os.dup(3)
 try:
  for part in parts[:-1]:
   nxt=os.open(part,flags(True),dir_fd=current); os.close(current); current=nxt
  fd=os.open(parts[-1],flags(False),dir_fd=current)
  try:
   before=os.fstat(fd)
   if not stat.S_ISREG(before.st_mode) or before.st_size>limit: reject()
   chunks=[]; total=0
   while True:
    chunk=os.read(fd,min(65536,limit+1-total))
    if not chunk: break
    chunks.append(chunk); total+=len(chunk)
    if total>limit: reject()
   after=os.fstat(fd)
   if (before.st_dev,before.st_ino,before.st_mode)!=(after.st_dev,after.st_ino,after.st_mode): reject()
   print(json.dumps({"data":base64.b64encode(b"".join(chunks)).decode("ascii"),"mtimeMs":after.st_mtime_ns/1000000,"dev":str(after.st_dev),"ino":str(after.st_ino)},separators=(",",":")))
  finally: os.close(fd)
 finally: os.close(current)
try: main()
except FileNotFoundError: sys.exit(44)
except Exception: sys.stderr.write("catalog openat helper failed\n"); sys.exit(1)
`;

/** Test-only seam runs after authority selection but before descriptor-relative traversal. */
let beforeTrustedOpenForTest: ((path: string) => void) | undefined;
/** @internal */
export function setCatalogBeforeTrustedOpenForTest(hook: ((path: string) => void) | undefined): void {
	beforeTrustedOpenForTest = hook;
}

function readTrustedFile(rawPath: string, roots: ManagedRoots, maxBytes: number): TrustedFile {
	if (!isAbsolute(rawPath) || rawPath !== resolve(rawPath))
		throw invalidFamilyTopology("session path is not canonical");
	const root = [roots.session, roots.artifacts].find((candidate) => candidate && isWithin(candidate.lexical, rawPath));
	if (!root) throw invalidFamilyTopology("session path escapes managed roots");
	const suffix = relative(root.lexical, rawPath);
	const parts = suffix.split(sep);
	if (!suffix || parts.some((part) => !part || part === "." || part === "..")) {
		throw invalidFamilyTopology("session path lacks a trusted file component");
	}
	beforeTrustedOpenForTest?.(rawPath);
	const result = spawnSync(
		process.execPath === process.env.PRIME_AGENT_KERNEL_PYTHON
			? process.execPath
			: (process.env.PRIME_AGENT_KERNEL_PYTHON ?? "python3"),
		["-I", "-c", OPENAT_READ_HELPER],
		{
			input: JSON.stringify({ parts, limit: maxBytes }),
			encoding: "utf8",
			timeout: 5_000,
			maxBuffer: maxBytes * 2 + 64 * 1024,
			stdio: ["pipe", "pipe", "pipe", root.fd],
			shell: false,
		},
	);
	if (result.status === 44) throw invalidFamilyTopology("descriptor-relative artifact is absent");
	if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
		throw invalidFamilyTopology("descriptor-relative artifact read failed");
	}
	try {
		const wire = JSON.parse(result.stdout) as { data?: unknown; mtimeMs?: unknown; dev?: unknown; ino?: unknown };
		if (
			typeof wire.data !== "string" ||
			typeof wire.mtimeMs !== "number" ||
			typeof wire.dev !== "string" ||
			typeof wire.ino !== "string"
		)
			throw new Error("invalid");
		return {
			path: rawPath,
			contents: Buffer.from(wire.data, "base64"),
			mtimeMs: wire.mtimeMs,
			dev: wire.dev,
			ino: wire.ino,
		};
	} catch {
		throw invalidFamilyTopology("descriptor-relative artifact response is invalid");
	}
}

async function readTrustedSession(path: string, roots: ManagedRoots): Promise<TrustedSession> {
	const trusted = readTrustedFile(path, roots, 128 * 1024 * 1024);
	const headerLine = trusted.contents
		.toString("utf8", 0, Math.min(trusted.contents.length, 256 * 1024))
		.split(/\r?\n/, 1)[0];
	let header: { type?: unknown; id?: unknown; parentSession?: unknown; rlmDepth?: unknown };
	try {
		header = JSON.parse(headerLine ?? "") as typeof header;
	} catch {
		throw invalidFamilyTopology("session header is malformed");
	}
	const hasParent = header.parentSession !== undefined;
	const hasDepth = Number.isSafeInteger(header.rlmDepth) && (header.rlmDepth as number) >= 0;
	if (
		header.type !== "session" ||
		typeof header.id !== "string" ||
		header.id === "" ||
		(hasParent && typeof header.parentSession !== "string") ||
		(hasParent && header.parentSession === "") ||
		(hasParent && !hasDepth) ||
		(!hasParent && header.rlmDepth !== undefined && !hasDepth)
	)
		throw invalidFamilyTopology("session header lacks trustworthy topology claims");
	const persistedDepth = hasDepth ? (header.rlmDepth as number) : 0;
	const info = await readSessionInfoFromBuffer(path, trusted.contents, { mtimeMs: trusted.mtimeMs });
	if (!info || info.id !== header.id) throw invalidFamilyTopology("session metadata does not match its header");
	return {
		...info,
		path,
		rlmDepth: persistedDepth,
		persistedDepth,
		...(hasParent ? { persistedParentPath: header.parentSession as string } : {}),
	};
}

async function readLatestRegistry(
	path: string,
	roots: ManagedRoots,
): Promise<SavedRlmSubagentRegistryEntry[] | undefined> {
	let contents: string;
	try {
		contents = readTrustedFile(path, roots, MAX_RLM_REGISTRY_BYTES).contents.toString("utf8");
	} catch (error) {
		if ((error as Error).message.includes("descriptor-relative artifact is absent")) return undefined;
		throw error;
	}
	const latest = new Map<string, SavedRlmSubagentRegistryEntry>();
	let records = 0;
	for (const line of contents.split(/\r?\n/)) {
		if (!line.trim()) continue;
		if (++records > MAX_RLM_REGISTRY_RECORDS) throw invalidFamilyTopology("registry record limit exhausted");
		let entry: SavedRlmSubagentRegistryEntry;
		try {
			entry = JSON.parse(line) as SavedRlmSubagentRegistryEntry;
		} catch {
			throw invalidFamilyTopology("registry contains malformed JSON");
		}
		if (
			entry.type !== "rlm_subagent" ||
			typeof entry.childId !== "string" ||
			entry.childId === "" ||
			typeof entry.sessionFile !== "string" ||
			entry.sessionFile === "" ||
			(entry.status !== "running" && entry.status !== "completed" && entry.status !== "deleted")
		) {
			throw invalidFamilyTopology("registry contains an invalid edge");
		}
		latest.set(entry.childId, entry);
	}
	return [...latest.values()];
}

export async function listCatalogFamilySessions(sessionDir?: string): Promise<SessionInfo[]> {
	const effectiveSessionDir = sessionDir ?? getSessionsDir();
	const roots = await SessionManager.listAll(undefined, effectiveSessionDir);
	const authority = managedRoots(effectiveSessionDir);
	try {
		const sessions = new Map<string, TrustedSession>();
		const ids = new Map<string, string>();
		for (const root of roots) {
			const trusted = await readTrustedSession(root.path, authority);
			if (trusted.persistedDepth !== 0 || trusted.persistedParentPath !== undefined) {
				throw invalidFamilyTopology("managed session seed claims a parent");
			}
			const existingPath = ids.get(trusted.id);
			if (existingPath && existingPath !== trusted.path)
				throw invalidFamilyTopology("family contains a duplicate session id");
			ids.set(trusted.id, trusted.path);
			sessions.set(trusted.path, trusted);
		}
		let edges = 0;
		const visited = new Set<string>();
		const visit = async (parent: TrustedSession, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
			if (depth > MAX_RLM_FAMILY_DEPTH) throw invalidFamilyTopology("family depth limit exhausted");
			const parentPath = parent.path;
			if (ancestors.has(parentPath)) throw invalidFamilyTopology("family contains a cycle");
			if (visited.has(parentPath)) return;
			visited.add(parentPath);
			const registryPath = rlmSubagentRegistryPath(parent, authority);
			if (!registryPath) return;
			const entries = await readLatestRegistry(registryPath, authority);
			if (!entries) return;
			const childAncestors = new Set(ancestors);
			childAncestors.add(parentPath);
			for (const entry of entries) {
				if (entry.status === "deleted") continue;
				if (++edges > MAX_RLM_FAMILY_EDGES) throw invalidFamilyTopology("family edge limit exhausted");
				const childPath = entry.sessionFile as string;
				if (childAncestors.has(childPath)) throw invalidFamilyTopology("family contains a cycle");
				const child = await readTrustedSession(childPath, authority);
				if (child.id !== entry.childId) throw invalidFamilyTopology("registry child id does not match session id");
				if (child.persistedParentPath === undefined)
					throw invalidFamilyTopology("child lacks a persisted parent path");
				const claimedParentPath = resolve(dirname(child.path), child.persistedParentPath);
				readTrustedFile(claimedParentPath, authority, 128 * 1024 * 1024);
				if (claimedParentPath !== parentPath)
					throw invalidFamilyTopology("child parent path does not match traversed parent");
				if (child.persistedDepth !== parent.persistedDepth + 1)
					throw invalidFamilyTopology("child depth does not equal parent depth plus one");
				const existingPath = ids.get(child.id);
				if (existingPath && existingPath !== child.path)
					throw invalidFamilyTopology("family contains a duplicate session id");
				const existing = sessions.get(child.path);
				if (
					existing &&
					(existing.id !== child.id ||
						existing.persistedParentPath !== child.persistedParentPath ||
						existing.persistedDepth !== child.persistedDepth)
				) {
					throw invalidFamilyTopology("family contains a conflicting duplicate");
				}
				if (!existing && sessions.size >= MAX_RLM_FAMILY_NODES)
					throw invalidFamilyTopology("family node limit exhausted");
				ids.set(child.id, child.path);
				sessions.set(child.path, child);
				await visit(child, depth + 1, childAncestors);
			}
		};
		for (const root of [...sessions.values()]) await visit(root, 0, new Set());
		return [...sessions.values()];
	} finally {
		closeManagedRoots(authority);
	}
}
export async function listSavedSessionSiblings(sessionPath: string, sessionDir?: string): Promise<SessionInfo[]> {
	const family = await listCatalogFamilySessions(sessionDir);
	const targetPath = resolve(sessionPath);
	const target = family.find((session) => session.path === targetPath);
	if (!target) throw new Error(`Session not found: ${sessionPath}`);
	if (!target.parentSessionPath) return [target];
	const parentPath = resolve(dirname(target.path), target.parentSessionPath);
	return family.filter(
		(session) =>
			session.parentSessionPath !== undefined &&
			resolve(dirname(session.path), session.parentSessionPath) === parentPath,
	);
}

/** @internal Exported to pin catalog selector semantics without spawning a catalog process. */
export function resolveCatalogSessionMatch(
	sessions: readonly SessionInfo[],
	selector: string,
): SessionInfo | undefined {
	// Deliberate broadening for create/resume as well as a2a wake: exact names
	// participate alongside id prefixes. Therefore a name that collides with an
	// id prefix is now ambiguous instead of the id-prefix match winning.
	const matches = sessions.filter((session) => session.id.startsWith(selector) || session.name === selector);
	if (matches.length > 1) {
		throw new Error(`Ambiguous session selector "${selector}"`);
	}
	return matches[0];
}

function isCatalogOutbound(value: unknown): value is CatalogOutbound {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown };
	return (
		candidate.type === "ready" ||
		((candidate.type === "progress" || candidate.type === "session" || candidate.type === "response") &&
			typeof candidate.id === "string")
	);
}

function isCatalogRequest(value: unknown): value is CatalogRequest {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; id?: unknown; command?: unknown };
	return (
		candidate.type === "request" &&
		typeof candidate.id === "string" &&
		(candidate.command === "list" ||
			candidate.command === "family" ||
			candidate.command === "resolve" ||
			candidate.command === "siblings" ||
			candidate.command === "rename" ||
			candidate.command === "delete" ||
			candidate.command === "archive" ||
			candidate.command === "mark_interrupted" ||
			candidate.command === "shutdown")
	);
}

function sendCatalogMessage(message: CatalogOutbound): void {
	if (process.send) {
		process.send(message);
	}
}

export function isDaemonCatalogProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[DAEMON_CATALOG_ROLE_ENV] === "1";
}

export async function runDaemonCatalogProcess(): Promise<never> {
	process.on("disconnect", () => process.exit(0));
	process.on("message", (value: unknown) => {
		if (!isCatalogRequest(value)) {
			return;
		}
		void handleCatalogRequest(value);
	});
	sendCatalogMessage({ type: "ready" });
	return new Promise(() => {});
}

async function handleCatalogRequest(request: CatalogRequest): Promise<void> {
	try {
		switch (request.command) {
			case "list": {
				const callbacks = {
					onProgress: (loaded: number, total: number) =>
						sendCatalogMessage({ type: "progress", id: request.id, loaded, total }),
					onSession: (session: SessionInfo) =>
						sendCatalogMessage({ type: "session", id: request.id, session: serializeSessionInfo(session) }),
				};
				const sessions = request.cwd
					? await SessionManager.list(request.cwd, request.sessionDir, callbacks)
					: await SessionManager.listAll(callbacks, request.sessionDir);
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: sessions.map(serializeSessionInfo) },
				});
				return;
			}
			case "family": {
				const sessions = await listCatalogFamilySessions(request.sessionDir);
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { sessions: sessions.map(serializeSessionInfo) },
				});
				return;
			}
			case "resolve": {
				const localMatch = resolveCatalogSessionMatch(
					await SessionManager.list(request.cwd, request.sessionDir),
					request.selector,
				);
				if (localMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: localMatch.path },
					});
					return;
				}
				const globalMatch = resolveCatalogSessionMatch(
					await SessionManager.listAll(undefined, request.sessionDir),
					request.selector,
				);
				if (globalMatch) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { sessionPath: globalMatch.path },
					});
					return;
				}
				throw new Error(`No session found matching '${request.selector}'`);
			}
			case "siblings":
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: {
						sessions: (await listSavedSessionSiblings(request.sessionPath, request.sessionDir)).map(
							serializeSessionInfo,
						),
					},
				});
				return;
			case "rename":
				SessionManager.open(request.sessionPath).appendSessionInfo(request.name.trim());
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			case "delete":
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: await deleteSessionFile(request.sessionPath),
				});
				return;
			case "archive": {
				const session = await readSessionInfo(request.sessionPath);
				if (!session || session.id !== request.sessionId) {
					sendCatalogMessage({
						type: "response",
						id: request.id,
						success: true,
						data: { archived: false },
					});
					return;
				}
				if (session.state?.status !== "archived") {
					SessionManager.open(request.sessionPath).appendSessionState({ status: "archived" });
				}
				sendCatalogMessage({
					type: "response",
					id: request.id,
					success: true,
					data: { archived: true },
				});
				return;
			}
			case "mark_interrupted":
				SessionManager.open(request.sessionPath).appendCustomMessageEntry(
					"prime-agent.worker_recovery",
					"<prime_agent_worker_interrupted>\nThe isolated session worker stopped during in-flight work. The saved transcript was recovered, but uncertain model, tool, bash, or child-agent work was not replayed. Inspect external side effects before continuing.\n</prime_agent_worker_interrupted>",
					false,
					{
						activeSessionId: request.activeSessionId,
						operations: request.operations,
					},
				);
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				return;
			case "shutdown":
				sendCatalogMessage({ type: "response", id: request.id, success: true });
				setImmediate(() => process.exit(0));
				return;
		}
	} catch (error) {
		sendCatalogMessage({
			type: "response",
			id: request.id,
			success: false,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export class DaemonCatalogClient {
	private child?: ChildProcess;
	private starting?: Promise<void>;
	private readonly pending = new Map<
		string,
		{
			resolve: (data: unknown) => void;
			reject: (error: Error) => void;
			callbacks?: CatalogListCallbacks;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(private readonly onDiagnostic: (message: string) => void) {}

	async start(): Promise<void> {
		if (this.child?.connected) {
			return;
		}
		if (this.starting) {
			return this.starting;
		}
		this.starting = this.spawnCatalog().finally(() => {
			this.starting = undefined;
		});
		return this.starting;
	}

	async list(cwd?: string, sessionDir?: string, callbacks?: CatalogListCallbacks): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>(
			{ type: "request", id: randomUUID(), command: "list", cwd, sessionDir },
			callbacks,
		);
		return data.sessions.map(deserializeSessionInfo);
	}

	async family(sessionDir?: string): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>({
			type: "request",
			id: randomUUID(),
			command: "family",
			sessionDir,
		});
		return data.sessions.map(deserializeSessionInfo);
	}

	async siblings(sessionPath: string, sessionDir?: string): Promise<SessionInfo[]> {
		const data = await this.request<{ sessions: SessionInfoWire[] }>({
			type: "request",
			id: randomUUID(),
			command: "siblings",
			sessionPath,
			sessionDir,
		});
		return data.sessions.map(deserializeSessionInfo);
	}

	async rename(sessionPath: string, name: string): Promise<void> {
		await this.request({ type: "request", id: randomUUID(), command: "rename", sessionPath, name });
	}

	async resolve(selector: string, cwd: string, sessionDir?: string): Promise<string> {
		const data = await this.request<{ sessionPath: string }>({
			type: "request",
			id: randomUUID(),
			command: "resolve",
			selector,
			cwd,
			sessionDir,
		});
		return data.sessionPath;
	}

	delete(sessionPath: string): Promise<DeleteSessionFileResult> {
		return this.request({ type: "request", id: randomUUID(), command: "delete", sessionPath });
	}

	async archive(sessionPath: string, sessionId: string): Promise<boolean> {
		const data = await this.request<{ archived: boolean }>({
			type: "request",
			id: randomUUID(),
			command: "archive",
			sessionPath,
			sessionId,
		});
		return data.archived;
	}

	async markInterrupted(sessionPath: string, activeSessionId: string, operations: string[]): Promise<void> {
		await this.request({
			type: "request",
			id: randomUUID(),
			command: "mark_interrupted",
			sessionPath,
			activeSessionId,
			operations,
		});
	}

	async stop(): Promise<void> {
		const child = this.child;
		if (!child) {
			return;
		}
		await this.request({ type: "request", id: randomUUID(), command: "shutdown" }).catch(() => undefined);
		child.disconnect();
		this.child = undefined;
	}

	private async spawnCatalog(): Promise<void> {
		const launch = createCliSubprocessLaunchSpec(["--version"]);
		const child = spawn(launch.command, launch.args, {
			cwd: process.cwd(),
			env: createCliSubprocessEnv({ ...process.env, [DAEMON_CATALOG_ROLE_ENV]: "1" }),
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		this.child = child;
		child.on("message", (value: unknown) => this.handleMessage(value));
		child.on("error", (error) => this.handleClose(child, error));
		child.on("exit", (code, signal) =>
			this.handleClose(child, new Error(`Daemon catalog exited (${signal ?? code ?? "unknown"})`)),
		);
		await new Promise<void>((resolveReady, rejectReady) => {
			const timeout = setTimeout(() => {
				cleanup();
				const error = new Error("Timed out starting daemon catalog");
				this.handleClose(child, error);
				if (child.connected) {
					child.disconnect();
				}
				child.kill("SIGKILL");
				rejectReady(error);
			}, 5000);
			const cleanup = () => {
				clearTimeout(timeout);
				child.off("message", onMessage);
				child.off("error", onError);
			};
			const onMessage = (value: unknown) => {
				if (isCatalogOutbound(value) && value.type === "ready") {
					cleanup();
					resolveReady();
				}
			};
			const onError = (error: Error) => {
				cleanup();
				rejectReady(error);
			};
			child.on("message", onMessage);
			child.once("error", onError);
		});
	}

	private async request<T = void>(request: CatalogRequest, callbacks?: CatalogListCallbacks): Promise<T> {
		await this.start();
		const child = this.child;
		if (!child?.connected) {
			throw new Error("Daemon catalog is not connected");
		}
		return new Promise<T>((resolveRequest, rejectRequest) => {
			const timeout = setTimeout(
				() => {
					if (!this.pending.delete(request.id)) {
						return;
					}
					child.kill("SIGKILL");
					rejectRequest(new Error(`Timed out waiting for daemon catalog ${request.command}`));
				},
				5 * 60 * 1000,
			);
			this.pending.set(request.id, {
				resolve: (data) => resolveRequest(data as T),
				reject: rejectRequest,
				callbacks,
				timeout,
			});
			child.send(request, (error) => {
				if (!error) {
					return;
				}
				const pending = this.pending.get(request.id);
				if (pending) {
					clearTimeout(pending.timeout);
					this.pending.delete(request.id);
				}
				rejectRequest(error);
			});
		});
	}

	private handleMessage(value: unknown): void {
		if (!isCatalogOutbound(value) || value.type === "ready") {
			return;
		}
		const pending = this.pending.get(value.id);
		if (!pending) {
			return;
		}
		if (value.type === "progress") {
			pending.callbacks?.onProgress?.(value.loaded, value.total);
			return;
		}
		if (value.type === "session") {
			pending.callbacks?.onSession?.(deserializeSessionInfo(value.session));
			return;
		}
		this.pending.delete(value.id);
		clearTimeout(pending.timeout);
		if (value.success) {
			pending.resolve(value.data);
		} else {
			pending.reject(new Error(value.error));
		}
	}

	private handleClose(child: ChildProcess, error: Error): void {
		if (this.child !== child) {
			return;
		}
		this.child = undefined;
		this.onDiagnostic(error.message);
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
	}
}
