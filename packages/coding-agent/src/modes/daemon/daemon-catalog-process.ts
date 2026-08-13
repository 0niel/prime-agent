import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createCliSubprocessEnv, createCliSubprocessLaunchSpec } from "../../cli/subprocess-launch.js";
import { getSessionsDir } from "../../config.js";
import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import { deleteSessionFile } from "../../core/session-file-actions.js";
import {
	readSessionHeaderInfoFromBuffer,
	readSessionInfo,
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

// Registry records carry prompts and spawn code; real profiles reach a few MB.
const MAX_RLM_REGISTRY_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_HEADER_BYTES = 64 * 1024;
const MAX_RLM_REGISTRY_RECORDS = 10_000;
const MAX_RLM_FAMILY_EDGES = 10_000;
const MAX_RLM_FAMILY_NODES = 10_000;
const MAX_RLM_FAMILY_DEPTH = 64;

// A narrow test seam avoids creating ten thousand filesystem entries merely to
// verify that root enumeration fails before opening any candidate descriptor.
let maxRlmFamilyNodesForTest: number | undefined;
/** @internal */
export function setCatalogMaxRlmFamilyNodesForTest(limit: number | undefined): void {
	maxRlmFamilyNodesForTest = limit;
}

function maxRlmFamilyNodes(): number {
	return maxRlmFamilyNodesForTest ?? MAX_RLM_FAMILY_NODES;
}

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
	/** A header exceeded the bounded descriptor read; only untrusted roots may skip it. */
	truncated?: boolean;
}

interface TrustedSessionMetadata {
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
	modifiedMs: number;
	name?: string;
	state?: SessionInfo["state"];
	agentStatus?: SessionInfo["agentStatus"];
}

interface TrustedMetadataFile extends TrustedFile {
	metadata: TrustedSessionMetadata;
}

interface TrustedSession extends SessionInfo {
	/** The header claims are intentionally separate from SessionInfo's legacy fallback. */
	persistedDepth?: number;
	persistedParentPath?: string;
	persistedVersion?: number;
}

/** A family member whose depth has been verified against the walk. */
interface FamilySession extends TrustedSession {
	persistedDepth: number;
}

function rlmSubagentRegistryPath(parent: SessionInfo, roots: ManagedRoots): string | undefined {
	// The session writer keeps a session's child registry beside its session
	// dir: <dirname(sessionDir)>/session-artifacts/<header id>. Every such
	// location is inside the profile's top-level artifacts root.
	if (!roots.artifacts) return undefined;
	return join(dirname(dirname(parent.path)), "session-artifacts", parent.id, "rlm-subagents.jsonl");
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

let helperSpawnCountForTest = 0;
/** @internal */
export function getCatalogHelperSpawnCountForTest(): number {
	return helperSpawnCountForTest;
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
SEARCH_MAX=65536
PARSE_MAX=1048576
PREVIEW_MAX=256
MAX_METADATA_RESPONSE_BYTES=256*1024
HEADER_CLASSIFICATION_BYTES=65536
TRUNCATION_MARKER="... [truncated]"
def reject(): raise ValueError("invalid")
def compact_metadata_response(response):
 # Budget the complete protocol envelope, not an assumed metadata shape.
 # ensure_ascii is explicit because the protocol is newline-delimited ASCII.
 def encoded_size(): return len(json.dumps(response,separators=(",",":"),ensure_ascii=True).encode("ascii"))
 if encoded_size()<=MAX_METADATA_RESPONSE_BYTES: return
 data=response.get("data")
 if not isinstance(data,dict): reject()
 targets=[]
 # Only the approved human-facing metadata strings are compactable. Protocol
 # control fields and typed metadata enums remain byte-for-byte unchanged.
 def add_target(container,key):
  if isinstance(container.get(key),str): targets.append((container,key,container[key]))
 add_target(data,"firstMessage"); add_target(data,"allMessagesText"); add_target(data,"name")
 status=data.get("agentStatus")
 if isinstance(status,dict): add_target(status,"summary")
 # Clear every display string before allocating the remaining escaped-byte
 # budget in a stable order. Fields remain present and string typed.
 for container,key,_ in targets: container[key]=""
 if encoded_size()>MAX_METADATA_RESPONSE_BYTES: reject()
 for container,key,original in targets:
  length=len(original)
  def candidate(prefix):
   return original if prefix==length else original[:prefix]+TRUNCATION_MARKER
  # A marker is useful when it fits; otherwise preserve the greatest raw
  # prefix. Either search uses the exact ensure_ascii serialized byte count.
  use_marker=encoded_size()+len(json.dumps(TRUNCATION_MARKER,ensure_ascii=True))<=MAX_METADATA_RESPONSE_BYTES
  def fits(prefix):
   container[key]=candidate(prefix) if use_marker else original[:prefix]
   return encoded_size()<=MAX_METADATA_RESPONSE_BYTES
  low=0; high=length
  while low<high:
   middle=(low+high+1)//2
   if fits(middle): low=middle
   else: high=middle-1
  container[key]=candidate(low) if use_marker else original[:low]
 if encoded_size()>MAX_METADATA_RESPONSE_BYTES: reject()
def flags(directory=False):
 value=os.O_RDONLY|os.O_NOFOLLOW
 if directory: value|=os.O_DIRECTORY
 return value
def message_text(message):
 content=message.get("content") if isinstance(message,dict) else None
 if isinstance(content,str): return content
 if isinstance(content,list): return " ".join(block.get("text","") for block in content if isinstance(block,dict) and block.get("type")=="text" and isinstance(block.get("text"),str))
 return ""
def append_search(current,text):
 if not text or len(current)>=SEARCH_MAX: return current
 next_text=(current+" " if current else "")+text
 return current+next_text[len(current):len(current)+(SEARCH_MAX-len(current))]
def parse_time(value):
 if not isinstance(value,str): return None
 try:
  text=value.replace("Z","+00:00")
  return __import__("datetime").datetime.fromisoformat(text).timestamp()*1000
 except Exception: return None
def string_prefix(text,key,limit,start=0):
 index=text.find('"'+key+'"',start)
 if index<0: return None
 index+=len(key)+2
 while index<len(text) and text[index].isspace(): index+=1
 if index>=len(text) or text[index] != ":": return None
 index+=1
 while index<len(text) and text[index].isspace(): index+=1
 if index>=len(text) or text[index] != '"': return None
 index+=1; result=[]; escaped=False
 while index<len(text) and len(result)<limit:
  char=text[index]
  if escaped: result.append(char); escaped=False
  elif char=="\\": escaped=True
  elif char=='"': break
  else: result.append(char)
  index+=1
 return "".join(result)
def scan_metadata(fd,mtime_ms):
 os.lseek(fd,0,os.SEEK_SET)
 stream=os.fdopen(os.dup(fd),"rb")
 try:
  header=None; count=0; first=""; search=""; name=None; state=None; agent_status=None; activity=None
  while True:
   # readline's limit prevents one hostile JSONL record from being materialized
   # in the helper. Parse normal records; for oversize records inspect only their
   # bounded prefix, then drain their remaining chunks before the next record.
   raw=stream.readline(PARSE_MAX+1)
   if not raw: break
   oversized=len(raw)>PARSE_MAX and not raw.endswith(b"\n")
   line=raw.decode("utf-8","replace").rstrip("\n")
   if oversized:
    if '"type":"message"' in line or '"type": "message"' in line:
     count+=1
     timestamp=parse_time(string_prefix(line,"timestamp",64) or "")
     message_index=line.find('"message"')
     role=string_prefix(line,"role",64,message_index if message_index>=0 else 0)
     preview=string_prefix(line,"content",PREVIEW_MAX,message_index) if message_index>=0 else None
     if preview is None and message_index>=0: preview=string_prefix(line,"text",PREVIEW_MAX,message_index)
     if timestamp is not None and role in ("user","assistant"): activity=max(activity or 0,timestamp)
     if role=="user" and not first: first=preview or "(large message)"
    while raw and not raw.endswith(b"\n"):
     raw=stream.readline(65536)
    continue
   if not line.strip(): continue
   try: entry=json.loads(line)
   except Exception: continue
   if not isinstance(entry,dict): continue
   kind=entry.get("type")
   if kind=="session_info":
    value=entry.get("name"); name=value.strip() if isinstance(value,str) and value.strip() else None
   elif kind=="session_state":
    value=entry.get("state"); status=value.get("status") if isinstance(value,dict) else None
    if status in ("active","archived","crash"): state={"status":status}
    elif status in ("hidden","sleep"): state={"status":"archived"}
   elif kind=="agent_status":
    # Keep the recap schema typed before it crosses the bounded wire. An
    # arbitrary taskState string is neither an AgentTaskState nor compactable.
    value=entry.get("status")
    summary=value.get("summary") if isinstance(value,dict) else None
    based=value.get("basedOnMessageCount") if isinstance(value,dict) else None
    if isinstance(summary,str) and isinstance(based,int) and not isinstance(based,bool) and based>=0:
     agent_status={"summary":summary,"basedOnMessageCount":based}
     task_state=value.get("taskState")
     if task_state in ("needs_input","completed"): agent_status["taskState"]=task_state
   if header is None:
    if kind!="session": return {"valid":False}
    header=entry
   if kind!="message": continue
   count+=1
   message=entry.get("message")
   if not isinstance(message,dict) or not isinstance(message.get("role"),str) or "content" not in message: continue
   role=message["role"]
   if role not in ("user","assistant"): continue
   timestamp=message.get("timestamp") if isinstance(message.get("timestamp"), (int,float)) and not isinstance(message.get("timestamp"),bool) else parse_time(entry.get("timestamp"))
   if timestamp is not None: activity=max(activity or 0,timestamp)
   text=message_text(message)
   if not text: continue
   search=append_search(search,text)
   if role=="user" and not first: first=text
  if header is None: return {"valid":False}
  header_time=parse_time(header.get("timestamp"))
  modified=activity if activity is not None and activity>0 else (header_time if header_time is not None else mtime_ms)
  data={"valid":True,"messageCount":count,"firstMessage":first or "(no messages)","allMessagesText":search,"modifiedMs":modified}
  if name is not None: data["name"]=name
  if state is not None: data["state"]=state
  if agent_status is not None: data["agentStatus"]=agent_status
  return data
 finally: stream.close()
def serve(req):
 request_id=req.get("id"); parts=req.get("parts"); limit=req.get("limit"); mode=req.get("mode"); root=req.get("root")
 if not isinstance(request_id,str) or not request_id or len(request_id)>128: reject()
 if mode not in ("read","header","classify","stat","metadata") or root not in (3,4): reject()
 if not isinstance(parts,list) or not parts or not isinstance(limit,int) or limit<0 or limit>MAX: reject()
 if any(not isinstance(p,str) or not p or p in (".","..") or "/" in p or "\\" in p for p in parts): reject()
 current=os.dup(root)
 try:
  for part in parts[:-1]:
   nxt=os.open(part,flags(True),dir_fd=current); os.close(current); current=nxt
  fd=os.open(parts[-1],flags(False),dir_fd=current)
  try:
   before=os.fstat(fd)
   if not stat.S_ISREG(before.st_mode): reject()
   if mode=="read" and before.st_size>limit: reject()
   payload={}
   if mode in ("read","header","classify"):
    chunks=[]; total=0; done=False
    while not done:
     chunk=os.read(fd,min(65536,limit+1-total))
     if not chunk: break
     if mode in ("header","classify"):
      cut=chunk.find(b"\n")
      if cut>=0: chunk=chunk[:cut+1]; done=True
     chunks.append(chunk); total+=len(chunk)
     if total>limit:
      # Only root classification may receive an incomplete first record. Its
      # raw prefix is independently bounded so base64 plus the full envelope
      # remains below the protocol cap. Strict registry/session reads reject.
      if mode=="classify":
       payload["truncated"]=True; chunks=[b"".join(chunks)[:HEADER_CLASSIFICATION_BYTES]]; break
      reject()
    payload["data"]=base64.b64encode(b"".join(chunks)).decode("ascii")
   elif mode=="metadata": payload["data"]=scan_metadata(fd,before.st_mtime_ns/1000000)
   after=os.fstat(fd)
   if (before.st_dev,before.st_ino,before.st_mode)!=(after.st_dev,after.st_ino,after.st_mode): reject()
   payload.update({"mtimeMs":after.st_mtime_ns/1000000,"dev":str(after.st_dev),"ino":str(after.st_ino)})
   return payload
  finally: os.close(fd)
 finally: os.close(current)
while True:
 line=sys.stdin.buffer.readline(131073)
 if not line: break
 if len(line)>131072 or not line.endswith(b"\n"): sys.exit(1)
 request=None
 try:
  request=json.loads(line); response=serve(request)
 except FileNotFoundError: response={"error":"absent"}
 except Exception: response={"error":"failed"}
 response["id"]=request.get("id") if isinstance(request,dict) else None
 if isinstance(request,dict) and request.get("mode")=="metadata" and "data" in response:
  try: compact_metadata_response(response)
  except Exception: response={"error":"failed","id":response.get("id")}
 # Metadata is the only compacted response. Its exact full envelope, including
 # the request id and every escaped control/display field, is bounded here.
 # Registry records deliberately retain their larger strict read budget.
 serialized=json.dumps(response,separators=(",",":"),ensure_ascii=True)
 if isinstance(request,dict) and request.get("mode")=="metadata" and len(serialized.encode("ascii"))>MAX_METADATA_RESPONSE_BYTES: sys.exit(1)
 sys.stdout.write(serialized+"\n"); sys.stdout.flush()
`;

/** Test-only seam runs after authority selection but before descriptor-relative traversal. */
let beforeTrustedOpenForTest: ((path: string) => void) | undefined;
/** @internal */
export function setCatalogBeforeTrustedOpenForTest(hook: ((path: string) => void) | undefined): void {
	beforeTrustedOpenForTest = hook;
}

/** Test-only seam runs after a descriptor-bound header read, before metadata. */
let afterTrustedHeaderForTest: ((path: string) => void) | undefined;
/** @internal */
export function setCatalogAfterTrustedHeaderForTest(hook: ((path: string) => void) | undefined): void {
	afterTrustedHeaderForTest = hook;
}

/** Test-only helper launch override for terminal-path protocol tests. */
let catalogHelperLaunchForTest: { command: string; args: string[] } | undefined;
/** @internal */
export function setCatalogHelperLaunchForTest(launch: { command: string; args: string[] } | undefined): void {
	catalogHelperLaunchForTest = launch;
}

type TrustedReadMode = "read" | "header" | "classify" | "stat" | "metadata";

const TRUSTED_READ_TIMEOUT_MS = 5_000;
const MAX_METADATA_RESPONSE_BYTES = 256 * 1024;

/** Test-only seam observes the exact helper response before protocol validation. */
let afterCatalogHelperResponseForTest:
	| ((mode: TrustedReadMode, requestId: string, responseLine: string) => void)
	| undefined;
/** @internal */
export function setCatalogAfterHelperResponseForTest(
	hook: ((mode: TrustedReadMode, requestId: string, responseLine: string) => void) | undefined,
): void {
	afterCatalogHelperResponseForTest = hook;
}

function isTrustedSessionMetadata(value: unknown): value is TrustedSessionMetadata {
	if (!value || typeof value !== "object") return false;
	const metadata = value as Record<string, unknown>;
	if (
		metadata.valid !== true ||
		typeof metadata.messageCount !== "number" ||
		!Number.isSafeInteger(metadata.messageCount) ||
		metadata.messageCount < 0 ||
		typeof metadata.firstMessage !== "string" ||
		typeof metadata.allMessagesText !== "string" ||
		typeof metadata.modifiedMs !== "number" ||
		!Number.isFinite(metadata.modifiedMs) ||
		(metadata.name !== undefined && typeof metadata.name !== "string") ||
		(metadata.state !== undefined &&
			(!metadata.state ||
				typeof metadata.state !== "object" ||
				((metadata.state as { status?: unknown }).status !== "active" &&
					(metadata.state as { status?: unknown }).status !== "archived" &&
					(metadata.state as { status?: unknown }).status !== "crash"))) ||
		(metadata.agentStatus !== undefined &&
			(!metadata.agentStatus ||
				typeof metadata.agentStatus !== "object" ||
				typeof (metadata.agentStatus as { summary?: unknown }).summary !== "string" ||
				!Number.isSafeInteger((metadata.agentStatus as { basedOnMessageCount?: unknown }).basedOnMessageCount) ||
				(metadata.agentStatus as { basedOnMessageCount: number }).basedOnMessageCount < 0 ||
				((metadata.agentStatus as { taskState?: unknown }).taskState !== undefined &&
					(metadata.agentStatus as { taskState?: unknown }).taskState !== "needs_input" &&
					(metadata.agentStatus as { taskState?: unknown }).taskState !== "completed")))
	) {
		return false;
	}
	return true;
}

/**
 * One helper process serves every descriptor-relative read of a family walk.
 * Both authority roots are passed at spawn (session on fd 3, artifacts on
 * fd 4 when present) and selected per request; requests are newline-delimited
 * JSON on stdin with one JSON response line each. Any protocol violation
 * kills the helper and fails the walk closed.
 */
class TrustedReadSession {
	private readonly child: ChildProcess;
	private stdoutBuffer = "";
	private failure: Error | undefined;
	private pending:
		| { resolve: (line: string) => void; reject: (error: Error) => void; timeout: NodeJS.Timeout; cap: number }
		| undefined;
	private queue: Promise<unknown> = Promise.resolve();
	private stdinEnded = false;
	private exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private readonly stdoutFinished: Promise<void>;
	private resolveStdoutFinished!: () => void;
	/** Resolves for every terminal child-process path, including failed spawn. */
	private readonly terminated: Promise<void>;
	private resolveTerminated!: () => void;
	private terminationSettled = false;

	constructor(private readonly roots: ManagedRoots) {
		const stdio: Array<"pipe" | "ignore" | number> = ["pipe", "pipe", "ignore", roots.session.fd];
		if (roots.artifacts) stdio.push(roots.artifacts.fd);
		this.stdoutFinished = new Promise((resolveFinished) => {
			this.resolveStdoutFinished = resolveFinished;
		});
		this.terminated = new Promise((resolveTerminated) => {
			this.resolveTerminated = resolveTerminated;
		});
		const launch = catalogHelperLaunchForTest ?? {
			command:
				process.execPath === process.env.PRIME_AGENT_KERNEL_PYTHON
					? process.execPath
					: (process.env.PRIME_AGENT_KERNEL_PYTHON ?? "python3"),
			args: ["-I", "-c", OPENAT_READ_HELPER],
		};
		this.child = spawn(launch.command, launch.args, { stdio, shell: false });
		helperSpawnCountForTest++;
		this.child.stdin?.on("error", (error) =>
			this.fail(new Error(`catalog openat helper write failed: ${String(error)}`)),
		);
		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));
		this.child.stdout?.on("end", () => {
			this.resolveStdoutFinished();
			if (this.stdoutBuffer !== "") this.fail(new Error("catalog openat helper left residual output"));
		});
		this.child.on("error", (error) => {
			// spawn() reports an invalid executable with error and close, but no exit.
			// Settle cleanup here so failed spawn cannot strand authority FDs.
			this.resolveStdoutFinished();
			this.settleTermination();
			this.fail(new Error(`catalog openat helper failed: ${String(error)}`));
		});
		this.child.on("exit", (code, signal) => {
			this.exit = { code, signal };
			this.settleTermination();
			if (!this.stdinEnded || code !== 0 || signal !== null) {
				this.fail(new Error(`catalog openat helper exited (${signal ?? code ?? "unknown"})`));
			}
		});
		this.child.on("close", (code, signal) => {
			this.exit ??= { code, signal };
			// close is terminal for failed spawn and confirms stdio is complete.
			this.resolveStdoutFinished();
			this.settleTermination();
		});
	}

	async read(rawPath: string, maxBytes: number, mode: Exclude<TrustedReadMode, "metadata">): Promise<TrustedFile> {
		const run = this.queue.then(() => this.readSerialized(rawPath, maxBytes, mode));
		this.queue = run.catch(() => undefined);
		return run;
	}

	async metadata(rawPath: string): Promise<TrustedMetadataFile> {
		const run = this.queue.then(() => this.readMetadataSerialized(rawPath));
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** End input and require the helper to finish silently and successfully. */
	async close(): Promise<void> {
		await this.queue;
		if (this.failure) {
			await this.awaitCleanup();
			throw this.closeError(this.failure);
		}
		if (this.pending || this.stdoutBuffer !== "") {
			this.fail(new Error("catalog openat helper has residual output"));
			await this.awaitCleanup();
			throw this.closeError(this.failure!);
		}
		this.stdinEnded = true;
		this.child.stdin?.end();
		await this.awaitCleanup();
		if (this.failure || this.exit?.code !== 0 || this.exit?.signal !== null || this.stdoutBuffer !== "") {
			const failure = this.failure ?? new Error("catalog openat helper did not exit cleanly");
			if (!this.failure) this.fail(failure);
			throw this.closeError(failure);
		}
	}

	private settleTermination(): void {
		if (this.terminationSettled) return;
		this.terminationSettled = true;
		this.resolveTerminated();
	}

	private async awaitCleanup(): Promise<void> {
		await Promise.all([this.terminated, this.stdoutFinished]);
	}

	private closeError(failure: Error): Error {
		return invalidFamilyTopology(`descriptor-relative artifact read failed: ${failure.message}`);
	}

	private async readMetadataSerialized(rawPath: string): Promise<TrustedMetadataFile> {
		const file = await this.readSerialized(rawPath, 0, "metadata");
		if (!file.metadata) throw invalidFamilyTopology("descriptor-relative artifact metadata is invalid");
		return { ...file, metadata: file.metadata };
	}

	private async readSerialized(
		rawPath: string,
		maxBytes: number,
		mode: TrustedReadMode,
	): Promise<TrustedFile & { metadata?: TrustedSessionMetadata }> {
		if (!isAbsolute(rawPath) || rawPath !== resolve(rawPath))
			throw invalidFamilyTopology("session path is not canonical");
		const root = [this.roots.session, this.roots.artifacts].find(
			(candidate) => candidate && isWithin(candidate.lexical, rawPath),
		);
		if (!root) throw invalidFamilyTopology("session path escapes managed roots");
		const suffix = relative(root.lexical, rawPath);
		const parts = suffix.split(sep);
		if (!suffix || parts.some((part) => !part || part === "." || part === "..")) {
			throw invalidFamilyTopology("session path lacks a trusted file component");
		}
		beforeTrustedOpenForTest?.(rawPath);
		const rootFd = root === this.roots.session ? 3 : 4;
		const requestId = randomUUID();
		const line = await this.exchange(
			JSON.stringify({ id: requestId, parts, limit: maxBytes, mode, root: rootFd }),
			mode === "read" ? maxBytes * 2 + 64 * 1024 : MAX_METADATA_RESPONSE_BYTES,
		);
		let wire: {
			id?: unknown;
			error?: unknown;
			data?: unknown;
			truncated?: unknown;
			mtimeMs?: unknown;
			dev?: unknown;
			ino?: unknown;
		};
		try {
			wire = JSON.parse(line) as typeof wire;
			afterCatalogHelperResponseForTest?.(mode, requestId, line);
		} catch {
			this.fail(new Error("catalog openat helper response is invalid"));
			throw invalidFamilyTopology("descriptor-relative artifact response is invalid");
		}
		if (wire.id !== requestId) {
			this.fail(new Error("catalog openat helper response id is shifted"));
			throw invalidFamilyTopology("descriptor-relative artifact response is invalid");
		}
		if (wire.error === "absent") throw invalidFamilyTopology("descriptor-relative artifact is absent");
		const truncatedHeader = mode === "classify" && wire.truncated === true;
		if (
			wire.error !== undefined ||
			(wire.truncated !== undefined && !truncatedHeader) ||
			(mode === "stat"
				? wire.data !== undefined
				: mode === "metadata"
					? !isTrustedSessionMetadata(wire.data)
					: typeof wire.data !== "string") ||
			typeof wire.mtimeMs !== "number" ||
			typeof wire.dev !== "string" ||
			typeof wire.ino !== "string"
		) {
			throw invalidFamilyTopology("descriptor-relative artifact read failed");
		}
		return {
			path: rawPath,
			contents: typeof wire.data === "string" ? Buffer.from(wire.data, "base64") : Buffer.alloc(0),
			mtimeMs: wire.mtimeMs,
			dev: wire.dev,
			ino: wire.ino,
			...(truncatedHeader ? { truncated: true } : {}),
			...(mode === "metadata" ? { metadata: wire.data as TrustedSessionMetadata } : {}),
		};
	}

	private exchange(request: string, responseCap: number): Promise<string> {
		if (this.failure || this.stdinEnded)
			return Promise.reject(
				invalidFamilyTopology(
					`descriptor-relative artifact read failed: ${this.failure?.message ?? "helper closed"}`,
				),
			);
		return new Promise<string>((resolvePending, rejectPending) => {
			const timeout = setTimeout(
				() => this.fail(new Error("catalog openat helper timed out")),
				TRUSTED_READ_TIMEOUT_MS,
			);
			this.pending = { resolve: resolvePending, reject: rejectPending, timeout, cap: responseCap };
			this.child.stdin?.write(`${request}\n`, (error) => {
				if (error) this.fail(new Error(`catalog openat helper write failed: ${String(error)}`));
			});
			this.drainStdout();
		});
	}

	private handleStdout(chunk: string): void {
		this.stdoutBuffer += chunk;
		this.drainStdout();
	}

	private drainStdout(): void {
		const pending = this.pending;
		if (!pending) {
			if (this.stdoutBuffer !== "") this.fail(new Error("catalog openat helper sent an unsolicited response"));
			return;
		}
		const end = this.stdoutBuffer.indexOf("\n");
		if (end === -1) {
			if (this.stdoutBuffer.length > pending.cap) this.fail(new Error("catalog openat helper response overflow"));
			return;
		}
		const line = this.stdoutBuffer.slice(0, end);
		const suffix = this.stdoutBuffer.slice(end + 1);
		this.stdoutBuffer = "";
		this.pending = undefined;
		clearTimeout(pending.timeout);
		if (line.length > pending.cap || suffix !== "") {
			this.fail(
				new Error(
					line.length > pending.cap
						? "catalog openat helper response overflow"
						: "catalog openat helper sent a shifted response",
				),
			);
			pending.reject(invalidFamilyTopology("descriptor-relative artifact response is invalid"));
			return;
		}
		pending.resolve(line);
	}

	private fail(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		// Failure is deliberately terminal. Clean shutdown is handled only by close().
		this.child.kill("SIGKILL");
		const pending = this.pending;
		this.pending = undefined;
		if (pending) {
			clearTimeout(pending.timeout);
			pending.reject(invalidFamilyTopology(`descriptor-relative artifact read failed: ${error.message}`));
		}
	}
}

/**
 * Topology claims (id, parent, depth) come from descriptor-bound header bytes.
 * Display metadata (name, timestamps, previews) is not part of the trust
 * decision. It is scanned inside the descriptor-bound helper and is bound to
 * the trusted header by the identity check below.
 */
async function readTrustedSession(path: string, reader: TrustedReadSession): Promise<TrustedSession> {
	const trusted = await reader.read(path, MAX_SESSION_HEADER_BYTES, "header");
	if (trusted.truncated) throw invalidFamilyTopology("session header exceeds the trusted read limit");
	const headerLine = trusted.contents.toString("utf8").split(/\r?\n/, 1)[0];
	let header: {
		type?: unknown;
		id?: unknown;
		parentSession?: unknown;
		rlmDepth?: unknown;
		version?: unknown;
		cwd?: unknown;
		timestamp?: unknown;
	};
	try {
		header = JSON.parse(headerLine ?? "") as typeof header;
	} catch {
		throw invalidFamilyTopology("session header is malformed");
	}
	const hasParent = header.parentSession !== undefined;
	const hasDepth = Number.isSafeInteger(header.rlmDepth) && (header.rlmDepth as number) >= 0;
	const hasVersion = Number.isSafeInteger(header.version) && (header.version as number) >= 1;
	if (
		header.type !== "session" ||
		typeof header.id !== "string" ||
		header.id === "" ||
		(hasParent && typeof header.parentSession !== "string") ||
		(hasParent && header.parentSession === "") ||
		(header.rlmDepth !== undefined && !hasDepth) ||
		(header.version !== undefined && !hasVersion)
	)
		throw invalidFamilyTopology("session header lacks trustworthy topology claims");
	const persistedDepth = hasDepth ? (header.rlmDepth as number) : undefined;
	afterTrustedHeaderForTest?.(path);
	// The metadata scan is bound to one descriptor, so it can skip giant entries
	// without transferring a session body or reopening the pathname in Node.
	const bound = await reader.metadata(path);
	if (bound.dev !== trusted.dev || bound.ino !== trusted.ino)
		throw invalidFamilyTopology("session changed after its trusted header read");
	const headerInfo = readSessionHeaderInfoFromBuffer(path, trusted.contents, { mtimeMs: trusted.mtimeMs });
	if (!headerInfo || headerInfo.id !== header.id)
		throw invalidFamilyTopology("session metadata does not match its header");
	const { metadata } = bound;
	const info: SessionInfo = {
		...headerInfo,
		modified: new Date(metadata.modifiedMs),
		messageCount: metadata.messageCount,
		firstMessage: metadata.firstMessage,
		allMessagesText: metadata.allMessagesText,
		...(metadata.name !== undefined ? { name: metadata.name } : {}),
		...(metadata.state !== undefined ? { state: metadata.state } : {}),
		...(metadata.agentStatus !== undefined ? { agentStatus: metadata.agentStatus } : {}),
	};
	return {
		...info,
		path,
		rlmDepth: persistedDepth ?? 0,
		parentSessionPath: hasParent ? (header.parentSession as string) : undefined,
		...(persistedDepth !== undefined ? { persistedDepth } : {}),
		...(hasParent ? { persistedParentPath: header.parentSession as string } : {}),
		...(hasVersion ? { persistedVersion: header.version as number } : {}),
	};
}

/**
 * A sessions directory can contain interrupted writes and unrelated jsonl files.
 * Classification is deliberately narrow: only a bounded, blank/truncated,
 * non-JSON, non-session, or identifier-less first record is ignored. Once a
 * record purports to be an identified session, the strict descriptor-bound
 * reader owns every topology and protocol failure.
 */
interface JsonStringPrefix {
	value: string;
	end: number;
	terminated: boolean;
	partialEscape: boolean;
	invalidEscape: boolean;
}

/**
 * Read a JSON string without treating malformed input as executable JSON.
 *
 * Even after an invalid escape, retain string framing: a malformed unrelated
 * value must not hide subsequent outer-object claims behind its closing quote.
 */
function readJsonStringPrefix(text: string, start: number): JsonStringPrefix | undefined {
	if (text[start] !== '"') return undefined;
	let value = "";
	let index = start + 1;
	let invalidEscape = false;
	while (index < text.length) {
		const char = text[index++];
		if (char === '"') return { value, end: index, terminated: true, partialEscape: false, invalidEscape };
		if (char !== "\\") {
			value += char;
			continue;
		}
		if (index === text.length) return { value, end: index, terminated: false, partialEscape: true, invalidEscape };
		const escapedChar = text[index++];
		const simpleEscape =
			escapedChar === '"'
				? '"'
				: escapedChar === "\\"
					? "\\"
					: escapedChar === "/"
						? "/"
						: escapedChar === "b"
							? "\b"
							: escapedChar === "f"
								? "\f"
								: escapedChar === "n"
									? "\n"
									: escapedChar === "r"
										? "\r"
										: escapedChar === "t"
											? "\t"
											: undefined;
		if (simpleEscape !== undefined) {
			value += simpleEscape;
			continue;
		}
		if (escapedChar !== "u") {
			invalidEscape = true;
			continue;
		}
		const unicodeStart = index;
		let hex = "";
		while (hex.length < 4 && index < text.length && /[0-9a-f]/iu.test(text[index] ?? "")) {
			hex += text[index++];
		}
		if (hex.length === 4) {
			value += String.fromCharCode(Number.parseInt(hex, 16));
			continue;
		}
		invalidEscape = true;
		// A truncated sequence is ambiguous. Otherwise leave the first invalid
		// byte for normal framing, notably a terminating quote.
		if (index === text.length) return { value, end: index, terminated: false, partialEscape: true, invalidEscape };
		index = unicodeStart + hex.length;
	}
	return { value, end: index, terminated: false, partialEscape: false, invalidEscape };
}

function skipJsonValuePrefix(text: string, start: number): number {
	let index = start;
	while (/\s/u.test(text[index] ?? "")) index++;
	const opening = text[index];
	if (opening === '"') return readJsonStringPrefix(text, index)?.end ?? text.length;
	if (opening !== "{" && opening !== "[") {
		while (index < text.length && !/[\s,}\]]/u.test(text[index] ?? "")) index++;
		return index;
	}
	const closings = [opening === "{" ? "}" : "]"];
	index++;
	while (index < text.length && closings.length > 0) {
		const char = text[index];
		if (char === '"') {
			const string = readJsonStringPrefix(text, index);
			if (!string) return text.length;
			index = string.end;
			if (!string.terminated) return index;
			continue;
		}
		if (char === "{") closings.push("}");
		else if (char === "[") closings.push("]");
		else if (char === closings.at(-1)) closings.pop();
		index++;
	}
	return index;
}

/**
 * Recognize only outer-object topology claims in an incomplete JSON prefix.
 * JSON string escapes are decoded only while scanning their bounded syntax, so
 * escaped keys cannot hide claims and strings in unrelated values cannot create
 * one. A cut through a key escape is ambiguous and therefore fails closed.
 */
function hasApparentSessionTopologyClaimPrefix(text: string): boolean {
	let index = 0;
	while (/\s/u.test(text[index] ?? "")) index++;
	if (text[index++] !== "{") return false;
	while (index < text.length) {
		while (/\s/u.test(text[index] ?? "")) index++;
		if (text[index] === "}") return false;
		const key = readJsonStringPrefix(text, index);
		if (!key) return false;
		// A malformed or partial outer key could itself be a topology key.
		if (!key.terminated || key.invalidEscape) return true;
		// A decoded id is topology-relevant before its delimiter or value can
		// arrive. In particular, a 64 KiB cut immediately after `"id"` must
		// not turn an identified root into harmless junk.
		if (key.value === "id") return true;
		index = key.end;
		while (/\s/u.test(text[index] ?? "")) index++;
		// Likewise a decoded outer type cannot safely be downgraded while its
		// colon/value is absent or only whitespace has reached the prefix end.
		if (text[index] !== ":") return key.value === "type";
		index++;
		while (/\s/u.test(text[index] ?? "")) index++;
		if (key.value === "type" && index === text.length) return true;
		if (key.value === "type" && text[index] === '"') {
			const value = readJsonStringPrefix(text, index)!;
			// Type's string value is itself a session claim surface; do not
			// downgrade malformed or partial values to unrelated junk.
			if (!value.terminated || value.invalidEscape) return true;
			if (value.value === "session") return true;
		}
		const valueStart = index;
		index = skipJsonValuePrefix(text, index);
		if (key.value === "type" && text[valueStart] !== '"') {
			// A non-string type is harmless only after its complete JSON value is
			// demonstrable. A cut through `nul`, `{`, or any nested value remains
			// ambiguous rather than becoming a skip at the read boundary.
			try {
				JSON.parse(text.slice(valueStart, index).trim());
			} catch {
				return true;
			}
		}
		while (/\s/u.test(text[index] ?? "")) index++;
		if (text[index] !== ",") return false;
		index++;
	}
	return false;
}

async function readTrustedRootCandidate(
	path: string,
	listed: { dev: string; ino: string },
	reader: TrustedReadSession,
): Promise<TrustedSession | undefined> {
	const header = await reader.read(path, MAX_SESSION_HEADER_BYTES, "classify");
	// A candidate changing after enumeration cannot safely be reclassified as
	// junk: it may have replaced an identified root before descriptor open.
	if (header.dev !== listed.dev || header.ino !== listed.ino)
		throw invalidFamilyTopology("root candidate changed after directory enumeration");
	const line = header.contents.toString("utf8").split(/\r?\n/, 1)[0] ?? "";
	if (!line.trim()) return undefined;
	let candidate: { type?: unknown; id?: unknown } | undefined;
	try {
		candidate = JSON.parse(line) as { type?: unknown; id?: unknown };
	} catch {
		// A bounded prefix may end in a concurrent partial write. Only a prefix
		// carrying a safely decoded topology claim is part of the topology;
		// unrelated incomplete junk remains skippable.
		if (hasApparentSessionTopologyClaimPrefix(line))
			throw invalidFamilyTopology("session header exceeds the trusted read limit");
		return undefined;
	}
	if (!candidate || typeof candidate !== "object") return undefined;
	// A complete prefix carrying either claim is fatal when truncated. A
	// registry-reached child never calls this root-only classifier and remains
	// strict unconditionally in readTrustedSession.
	if (header.truncated && (candidate.type === "session" || candidate.id !== undefined))
		throw invalidFamilyTopology("session header exceeds the trusted read limit");
	if (header.truncated) return undefined;
	if (candidate.type !== "session") return undefined;
	// Once a complete root record purports to be a session, strict parsing owns
	// it. A missing/blank id is corruption, not unrelated no-id junk.
	return readTrustedSession(path, reader);
}

/**
 * /fork and lineage-carrying /new save sessions directly into the sessions dir
 * with a parentSession claim naming their source. That claim is fork ancestry,
 * not rlm topology: the session is a family root and the claim is ignored.
 * Parent claims that leave the sessions dir still fail closed.
 */
function asTrustedFamilyRoot(trusted: TrustedSession, roots: ManagedRoots): FamilySession {
	if (trusted.persistedParentPath !== undefined) {
		const claimedParent = resolve(dirname(trusted.path), trusted.persistedParentPath);
		if (dirname(trusted.path) !== roots.session.lexical || !isWithin(roots.session.lexical, claimedParent)) {
			throw invalidFamilyTopology("managed session seed claims a parent");
		}
		const { persistedParentPath: _forkSource, parentSessionPath: _forkLineage, ...root } = trusted;
		return { ...root, rlmDepth: 0, persistedDepth: 0 };
	}
	if (trusted.persistedDepth !== undefined && trusted.persistedDepth !== 0) {
		throw invalidFamilyTopology("managed session seed claims a nonzero depth");
	}
	return { ...trusted, rlmDepth: 0, persistedDepth: 0 };
}

async function readLatestRegistry(
	path: string,
	reader: TrustedReadSession,
): Promise<SavedRlmSubagentRegistryEntry[] | undefined> {
	let contents: string;
	try {
		contents = (await reader.read(path, MAX_RLM_REGISTRY_BYTES, "read")).contents.toString("utf8");
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
			!/^sub-[0-9a-f]{8}$/.test(entry.childId) ||
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

function listSessionCandidates(sessionDir: string): Array<{ path: string; dev: string; ino: string }> {
	try {
		const candidates: Array<{ path: string; dev: string; ino: string }> = [];
		const limit = maxRlmFamilyNodes();
		for (const entry of readdirSync(sessionDir)) {
			if (!entry.endsWith(".jsonl")) continue;
			const path = join(resolve(sessionDir), entry);
			try {
				const stat = lstatSync(path);
				// Count every stable root candidate, including junk and duplicate ids,
				// before opening a descriptor or scanning metadata. Removed entries
				// retain their historical behavior and never become candidates.
				candidates.push({ path, dev: String(stat.dev), ino: String(stat.ino) });
				if (candidates.length > limit) throw invalidFamilyTopology("family node limit exhausted");
			} catch (error) {
				if ((error as Error).message.includes("family node limit exhausted")) throw error;
				// Removed during enumeration: it was never a stable root candidate.
			}
		}
		return candidates;
	} catch (error) {
		if ((error as Error).message.includes("family node limit exhausted")) throw error;
		return [];
	}
}

export async function listCatalogFamilySessions(sessionDir?: string): Promise<SessionInfo[]> {
	const effectiveSessionDir = sessionDir ?? getSessionsDir();
	const roots = listSessionCandidates(effectiveSessionDir);
	const authority = managedRoots(effectiveSessionDir);
	const reader = new TrustedReadSession(authority);
	let result: SessionInfo[] | undefined;
	let traversalFailure: unknown;
	try {
		const sessions = new Map<string, FamilySession>();
		const ids = new Map<string, string>();
		for (const root of roots) {
			const candidate = await readTrustedRootCandidate(root.path, root, reader);
			if (!candidate) continue;
			const trusted = asTrustedFamilyRoot(candidate, authority);
			const existingPath = ids.get(trusted.id);
			if (existingPath && existingPath !== trusted.path)
				throw invalidFamilyTopology("family contains a duplicate session id");
			ids.set(trusted.id, trusted.path);
			sessions.set(trusted.path, trusted);
		}
		let edges = 0;
		const visited = new Set<string>();
		const visit = async (parent: FamilySession, depth: number, ancestors: ReadonlySet<string>): Promise<void> => {
			if (depth > MAX_RLM_FAMILY_DEPTH) throw invalidFamilyTopology("family depth limit exhausted");
			const parentPath = parent.path;
			if (ancestors.has(parentPath)) throw invalidFamilyTopology("family contains a cycle");
			if (visited.has(parentPath)) return;
			visited.add(parentPath);
			const registryPath = rlmSubagentRegistryPath(parent, authority);
			if (!registryPath) return;
			const entries = await readLatestRegistry(registryPath, reader);
			if (!entries) return;
			const childAncestors = new Set(ancestors);
			childAncestors.add(parentPath);
			for (const entry of entries) {
				if (entry.status === "deleted") continue;
				if (++edges > MAX_RLM_FAMILY_EDGES) throw invalidFamilyTopology("family edge limit exhausted");
				const childPath = entry.sessionFile as string;
				if (childAncestors.has(childPath)) throw invalidFamilyTopology("family contains a cycle");
				const trustedChild = await readTrustedSession(childPath, reader);
				if (basename(childPath, ".jsonl") !== trustedChild.id)
					throw invalidFamilyTopology("registry child session file does not match its header id");
				// Registry reachability is not enough: bind the registry key to the
				// directory the writer allocates directly below this parent's managed
				// artifact root. This rejects arbitrary sessions-root descendants and
				// prevents rekeying a real child under another sub-* id.
				const childId = entry.childId as string;
				const childSessionDir = dirname(childPath);
				const parentSessionDir = dirname(parent.path);
				const writerChildrenRoot =
					parentSessionDir === authority.session.lexical
						? join(authority.artifacts?.lexical ?? "", parent.id)
						: parentSessionDir;
				// The actual writer uses <parent artifact dir>/sub-*/<session-id>.jsonl.
				// Registry keys name that immediate child directory, so neither a
				// nested sessions root nor a re-keyed sibling is reachable.
				const modernWriterPath =
					/^sub-[0-9a-f]{8}$/.test(childId) &&
					childId === basename(childSessionDir) &&
					childSessionDir === join(writerChildrenRoot, childId);
				if (!modernWriterPath) {
					throw invalidFamilyTopology("registry child is outside the parent writer artifact layout");
				}
				if (trustedChild.persistedParentPath === undefined)
					throw invalidFamilyTopology("child lacks a persisted parent path");
				// Old writers persisted no rlmDepth on children: an absent claim is
				// derived from the traversed edge, but a contradicting claim is corrupt.
				if (trustedChild.persistedDepth !== undefined && trustedChild.persistedDepth !== parent.persistedDepth + 1)
					throw invalidFamilyTopology("child depth does not equal parent depth plus one");
				const child: FamilySession = {
					...trustedChild,
					persistedDepth: parent.persistedDepth + 1,
					rlmDepth: parent.persistedDepth + 1,
				};
				const claimedParentPath = resolve(dirname(child.path), trustedChild.persistedParentPath);
				await reader.read(claimedParentPath, 0, "stat");
				if (claimedParentPath !== parentPath)
					throw invalidFamilyTopology("child parent path does not match traversed parent");
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
				if (!existing && sessions.size >= maxRlmFamilyNodes())
					throw invalidFamilyTopology("family node limit exhausted");
				ids.set(child.id, child.path);
				sessions.set(child.path, child);
				await visit(child, depth + 1, childAncestors);
			}
		};
		for (const root of [...sessions.values()]) await visit(root, 0, new Set());
		result = [...sessions.values()];
	} catch (error) {
		traversalFailure = error;
	}
	let cleanupFailure: unknown;
	try {
		await reader.close();
	} catch (error) {
		cleanupFailure = error;
	}
	try {
		closeManagedRoots(authority);
	} catch (error) {
		cleanupFailure ??= error;
	}
	// The traversal failure is authoritative; cleanup must not replace it.
	if (traversalFailure !== undefined) throw traversalFailure;
	if (cleanupFailure !== undefined) throw cleanupFailure;
	return result!;
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
