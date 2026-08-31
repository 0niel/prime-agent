/**
 * AISuite bridge for Prime Agent.
 *
 * Loads generated AISuite rules and skills, executes generated lifecycle hooks,
 * enables the built-in shell/editor tools, and enforces an external-system
 * read-only mode when the user asks not to mutate tickets or reviews.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";

const MANIFEST_PATHS = [
	".codeassistant/aisuite_generated_artifacts.json",
	".claude/aisuite_generated_artifacts.json",
	".codex/aisuite_generated_artifacts.json",
] as const;
const DEFAULT_HOOKS_PATH = ".codex/hooks.json";
const DEFAULT_MAX_PROMPT_BYTES = 256 * 1024;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;
const MAX_HOOK_CONTEXT_BYTES = 64 * 1024;
const AISUITE_STATE_ENTRY = "aisuite-state";
const DEFAULT_TOOLS = ["ipython", "bash", "edit"];
const DEFAULT_DUTY_BUNDLE = [
	"tracker",
	"community-intrasearch",
	"wiki",
	"monium",
	"yql-tutor-pro",
	"yql",
	"nonfatal-yql",
	"nonfatal-fix",
	"exp-client",
	"tanker",
	"arc",
	"arcanum",
	"fix-ci",
	"sandbox",
	"abc",
];
const DEFAULT_PERF_BUNDLE = [
	"device-drive",
	"perfetto-comparator",
	"yxpro-perfetto-trace",
	"prime-ast-index",
	"arcadia-code-graph",
];

interface ArtifactEntry {
	name: string;
	path: string;
	source?: string;
	broken?: boolean;
}

interface ArtifactManifest {
	rules?: ArtifactEntry[];
	skills?: ArtifactEntry[];
}

export interface HookCommand {
	type: "command";
	command: string;
	timeout?: number;
}

interface HookGroup {
	matcher?: string;
	hooks?: HookCommand[];
}

interface AisuiteConfig {
	enabledTools?: string[];
	eagerRules?: boolean;
	hooksFile?: string;
	maxPromptBytes?: number;
	skillBundles?: Record<string, string[]>;
}

export interface AisuiteProject {
	root: string;
	rules: ArtifactEntry[];
	skills: ArtifactEntry[];
	hooksPath?: string;
	config: Required<Omit<AisuiteConfig, "hooksFile">> & { hooksFile: string };
}

export interface HookPayload {
	session_id: string;
	cwd: string;
	hook_event_name: string;
	transcript_path?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
	source?: string;
	error?: string;
}

export interface HookDecision {
	block?: boolean;
	reason?: string;
	updatedInput?: Record<string, unknown>;
	additionalContext?: string;
	env?: Record<string, string>;
}

export interface HookRunResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	blockedReason?: string;
}

export interface AisuiteSessionState {
	readOnlyExternal: boolean;
	selectedSkills: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function parseArtifactEntries(value: unknown): ArtifactEntry[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		if (!isRecord(entry) || typeof entry.name !== "string" || typeof entry.path !== "string") return [];
		return [
			{
				name: entry.name,
				path: entry.path,
				source: typeof entry.source === "string" ? entry.source : undefined,
				broken: entry.broken === true,
			},
		];
	});
}

function parseManifest(path: string): ArtifactManifest {
	const raw = readJson(path);
	if (!isRecord(raw)) return {};
	return {
		rules: parseArtifactEntries(raw.rules),
		skills: parseArtifactEntries(raw.skills),
	};
}

function parseStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
	return value;
}

function parseConfig(path: string): AisuiteConfig {
	const raw = readJson(path);
	if (!isRecord(raw)) return {};
	const skillBundles = isRecord(raw.skillBundles)
		? Object.fromEntries(
				Object.entries(raw.skillBundles).flatMap(([name, value]) => {
					const items = parseStringArray(value);
					return items ? [[name, items]] : [];
				}),
			)
		: undefined;
	return {
		enabledTools: parseStringArray(raw.enabledTools),
		eagerRules: typeof raw.eagerRules === "boolean" ? raw.eagerRules : undefined,
		hooksFile: typeof raw.hooksFile === "string" ? raw.hooksFile : undefined,
		maxPromptBytes:
			typeof raw.maxPromptBytes === "number" && Number.isFinite(raw.maxPromptBytes) && raw.maxPromptBytes > 0
				? Math.min(Math.floor(raw.maxPromptBytes), MAX_PROMPT_BYTES)
				: undefined,
		skillBundles,
	};
}

function mergeConfig(globalConfig: AisuiteConfig, projectConfig: AisuiteConfig): AisuiteProject["config"] {
	return {
		enabledTools: projectConfig.enabledTools ?? globalConfig.enabledTools ?? DEFAULT_TOOLS,
		eagerRules: projectConfig.eagerRules ?? globalConfig.eagerRules ?? true,
		hooksFile: projectConfig.hooksFile ?? globalConfig.hooksFile ?? DEFAULT_HOOKS_PATH,
		maxPromptBytes: projectConfig.maxPromptBytes ?? globalConfig.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES,
		skillBundles: {
			"duty-cracker": DEFAULT_DUTY_BUNDLE,
			"eats-perf-profiler": DEFAULT_PERF_BUNDLE,
			...(globalConfig.skillBundles ?? {}),
			...(projectConfig.skillBundles ?? {}),
		},
	};
}

function findProjectRoot(cwd: string): string | undefined {
	let current = resolve(cwd);
	for (;;) {
		if (MANIFEST_PATHS.some((path) => existsSync(join(current, path)))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function resolveArtifactPath(root: string, entry: ArtifactEntry): string | undefined {
	const candidates = [entry.path, entry.source].flatMap((path) => {
		if (!path) return [];
		return [isAbsolute(path) ? path : join(root, path)];
	});
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function dedupeEntries(root: string, entries: ArtifactEntry[]): ArtifactEntry[] {
	const seenPaths = new Set<string>();
	const seenSources = new Set<string>();
	return entries.filter((entry) => {
		if (entry.broken) return false;
		const path = resolveArtifactPath(root, entry);
		if (!path) return false;
		if (seenPaths.has(path) || (entry.source !== undefined && seenSources.has(entry.source))) return false;
		seenPaths.add(path);
		if (entry.source !== undefined) seenSources.add(entry.source);
		return true;
	});
}

function defaultAgentDir(): string {
	return process.env.PRIME_AGENT_CODING_AGENT_DIR ?? join(homedir(), ".prime", "agent");
}

export function loadAisuiteProject(cwd: string, agentDir = defaultAgentDir()): AisuiteProject | undefined {
	const root = findProjectRoot(cwd);
	if (!root) return undefined;

	const manifests = MANIFEST_PATHS.filter((path) => existsSync(join(root, path))).map((path) =>
		parseManifest(join(root, path)),
	);
	const globalConfig = parseConfig(join(agentDir, "extensions", "aisuite.json"));
	const projectConfig = parseConfig(join(root, ".prime", "agent", "aisuite.json"));
	const config = mergeConfig(globalConfig, projectConfig);
	const hooksPath = isAbsolute(config.hooksFile) ? config.hooksFile : join(root, config.hooksFile);

	return {
		root,
		rules: dedupeEntries(
			root,
			manifests.flatMap((manifest) => manifest.rules ?? []),
		),
		skills: dedupeEntries(
			root,
			[...manifests].reverse().flatMap((manifest) => manifest.skills ?? []),
		),
		hooksPath: existsSync(hooksPath) ? hooksPath : undefined,
		config,
	};
}

export function extractRequestedSkills(text: string, availableSkills: Iterable<string>): string[] {
	const lower = text.toLowerCase();
	return [...availableSkills].filter((name) => {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(
			`(?:<skill[^>]*name=["']${escaped}["']|/skill:${escaped}\\b|\\$${escaped}\\b|\\b${escaped}\\b)`,
			"i",
		).test(lower);
	});
}

export function requestsExternalReadOnly(text: string): boolean {
	return [
		/\bread[- ]?only\b/i,
		/\bdo not (?:comment|update|modify|transition|publish|reply)\b/i,
		/\bno (?:comment|update|mutation|write)s?\b/i,
		/(?:не|ничего не)\s+(?:отвечай|пиши|комментируй|изменяй|обновляй|переводи)[^\n]{0,80}(?:тикет|tracker|pr|ревью)/iu,
		/(?:тикет|tracker|pr|ревью)[^\n]{0,80}(?:не\s+(?:трогай|меняй|комментируй|обновляй)|только\s+read)/iu,
		/результат\s+только\s+(?:сюда|в\s+чат)/iu,
	].some((pattern) => pattern.test(text));
}

function shellText(event: ToolCallEvent): string | undefined {
	if (event.toolName === "bash" && typeof event.input.command === "string") return event.input.command;
	if (event.toolName === "ipython" && typeof event.input.code === "string") return event.input.code;
	return undefined;
}

export function blockedCommandReason(command: string, readOnlyExternal: boolean): string | undefined {
	if (/(?:^|[;&|]\s*)find\s+\/(?:\s|$)/m.test(command)) {
		return "Full-filesystem search is blocked. Search inside the AISuite project root instead.";
	}
	if (!readOnlyExternal) return undefined;

	const trackerMutation =
		/\btracker-cli\.sh\s+(?:status|create|update|comment(?:-update|-delete)?|link|remotelink-(?:add|remove)|attachment-upload|clone-meta|project-(?:create|update|comment)|portfolio-description-update)\b/i;
	const trackerHttpTarget = /(?:st\.yandex-team\.ru|api\.tracker\.yandex\.net)/i;
	const curlMutation =
		/\bcurl\b/i.test(command) &&
		trackerHttpTarget.test(command) &&
		(/(?:-X|--request)\s*(?:POST|PUT|PATCH|DELETE)\b/i.test(command) ||
			/(?:^|\s)(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form|-T|--upload-file)(?:\s|=)/im.test(command));
	const pythonHttpMutation =
		trackerHttpTarget.test(command) &&
		(/\b(?:requests|httpx)\.(?:post|put|patch|delete)\s*\(/i.test(command) ||
			/\bRequest\s*\([^)]*\bmethod\s*=\s*["'](?:POST|PUT|PATCH|DELETE)["']/is.test(command));
	const normalized = command.replace(/[_./:-]+/g, " ");
	const genericMcpMutation =
		/\b(?:call tool|mcp)\b/i.test(normalized) &&
		/\b(?:tracker|startrek|arcanum|wiki|experiments?|tariff|forms?)\b/i.test(normalized) &&
		/\b(?:add|create|update|edit|delete|remove|transition|comment|reply|publish|merge|approve|resolve|close|reopen|move|link|attach|upload)\w*\b/i.test(
			normalized,
		);
	const publishing =
		/\barc\s+pr\s+(?:publish|merge|close|update|create|edit)\b|\bgh\s+(?:pr|issue)\s+(?:comment|merge|review|close|reopen|edit|create|delete)\b|\bgh\s+api\b[^\n]*(?:-X|--method)\s*(?:POST|PUT|PATCH|DELETE)\b/i;
	if (
		trackerMutation.test(command) ||
		curlMutation ||
		pythonHttpMutation ||
		genericMcpMutation ||
		publishing.test(command)
	) {
		return "External read-only mode is active: Tracker/review mutation was blocked.";
	}
	return undefined;
}

export function blockedToolReason(
	toolName: string,
	input: Record<string, unknown>,
	readOnlyExternal: boolean,
): string | undefined {
	if (!readOnlyExternal) return undefined;
	const selectors = [
		toolName,
		...(["server", "serverName", "name", "tool", "toolName", "tool_name", "action", "method"] as const).flatMap(
			(key) => (typeof input[key] === "string" ? [input[key]] : []),
		),
	]
		.join(" ")
		.replace(/[_./:-]+/g, " ");
	if (
		/\b(?:tracker|startrek|arcanum|wiki|experiments?|tariff|forms?)\b/i.test(selectors) &&
		/\b(?:add|create|update|edit|delete|remove|transition|comment|reply|publish|merge|approve|resolve|close|reopen|move|link|attach|upload)\w*\b/i.test(
			selectors,
		)
	) {
		return "External read-only mode is active: external-system mutation was blocked.";
	}
	return undefined;
}

function parseHookGroups(path: string | undefined, eventName: string): HookGroup[] {
	if (!path) return [];
	const raw = readJson(path);
	if (!isRecord(raw) || !isRecord(raw.hooks)) return [];
	const groups = raw.hooks[eventName];
	if (!Array.isArray(groups)) return [];
	return groups.flatMap((group) => {
		if (!isRecord(group)) return [];
		const hooks = Array.isArray(group.hooks)
			? group.hooks.flatMap((hook) => {
					if (!isRecord(hook) || hook.type !== "command" || typeof hook.command !== "string") return [];
					return [
						{
							type: "command" as const,
							command: hook.command,
							timeout: typeof hook.timeout === "number" ? hook.timeout : undefined,
						},
					];
				})
			: [];
		return [{ matcher: typeof group.matcher === "string" ? group.matcher : undefined, hooks }];
	});
}

function matcherMatches(matcher: string | undefined, value: string): boolean {
	if (!matcher) return true;
	try {
		return new RegExp(`^(?:${matcher})$`, "i").test(value);
	} catch {
		return matcher.toLowerCase() === value.toLowerCase();
	}
}

export function runHookCommand(hook: HookCommand, payload: HookPayload, cwd: string): Promise<HookRunResult> {
	return new Promise((resolveRun) => {
		const detached = process.platform !== "win32";
		const child = spawn("/bin/sh", ["-lc", hook.command], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			detached,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolveRun({ stdout, stderr, exitCode });
		};
		const killProcessTree = () => {
			if (detached && child.pid) {
				try {
					process.kill(-child.pid, "SIGKILL");
					return;
				} catch {
					// Fall back to killing the shell when the process group is already gone.
				}
			}
			child.kill("SIGKILL");
		};
		const timer = setTimeout(
			() => {
				killProcessTree();
				finish(null);
			},
			Math.max(1, hook.timeout ?? 3) * 1000,
		);
		const appendOutput = (target: "stdout" | "stderr", chunk: Buffer) => {
			const used = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
			const remaining = Math.max(0, MAX_HOOK_OUTPUT_BYTES - used);
			const selected = chunk.subarray(0, remaining).toString();
			if (target === "stdout") stdout += selected;
			else stderr += selected;
			if (chunk.byteLength > remaining) {
				stderr += "\nAISuite hook output exceeded 1 MiB and was terminated.";
				killProcessTree();
				finish(null);
			}
		};
		child.stdout.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
		child.stderr.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
		child.on("error", (error) => {
			stderr += error.message;
			finish(null);
		});
		child.on("close", finish);
		child.stdin.end(JSON.stringify(payload));
	});
}

export function restoreAisuiteState(entries: readonly unknown[]): AisuiteSessionState {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== AISUITE_STATE_ENTRY) continue;
		if (!isRecord(entry.data)) break;
		return {
			readOnlyExternal: entry.data.readOnlyExternal === true,
			selectedSkills: Array.isArray(entry.data.selectedSkills)
				? [...new Set(entry.data.selectedSkills.filter((value): value is string => typeof value === "string"))]
				: [],
		};
	}
	return { readOnlyExternal: false, selectedSkills: [] };
}

export function parseHookDecision(stdout: string): HookDecision {
	const trimmed = stdout.trim();
	const candidates = [
		trimmed,
		...trimmed
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.reverse(),
	];
	for (const line of candidates) {
		let raw: unknown;
		try {
			raw = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(raw)) continue;
		const specific = isRecord(raw.hookSpecificOutput) ? raw.hookSpecificOutput : raw;
		const decision = specific.permissionDecision ?? raw.decision;
		const env = isRecord(specific.env ?? raw.env)
			? Object.fromEntries(
					Object.entries((specific.env ?? raw.env) as Record<string, unknown>).flatMap(([key, value]) =>
						typeof value === "string" ? [[key, value]] : [],
					),
				)
			: undefined;
		return {
			block: decision === "deny" || decision === "block",
			reason:
				typeof specific.permissionDecisionReason === "string"
					? specific.permissionDecisionReason
					: typeof raw.reason === "string"
						? raw.reason
						: undefined,
			updatedInput: isRecord(specific.updatedInput) ? specific.updatedInput : undefined,
			additionalContext:
				typeof specific.additionalContext === "string"
					? specific.additionalContext
					: typeof raw.additional_context === "string"
						? raw.additional_context
						: undefined,
			env,
		};
	}
	return {};
}

function readPromptResources(project: AisuiteProject, selectedSkills: Set<string>): string {
	let bytesLeft = project.config.maxPromptBytes;
	const sections: string[] = [];
	const appendFile = (title: string, path: string) => {
		if (bytesLeft <= 0) return;
		const file = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(bytesLeft);
		let bytesRead = 0;
		try {
			while (bytesRead < buffer.byteLength) {
				const count = readSync(file, buffer, bytesRead, buffer.byteLength - bytesRead, null);
				if (count === 0) break;
				bytesRead += count;
			}
		} finally {
			closeSync(file);
		}
		const selected = buffer.subarray(0, bytesRead).toString("utf8");
		sections.push(`## ${title}\n\n${selected}`);
		bytesLeft -= bytesRead;
	};

	if (project.config.eagerRules) {
		for (const rule of project.rules) {
			const path = resolveArtifactPath(project.root, rule);
			if (path) appendFile(`AISuite rule: ${rule.name}`, path);
		}
	}

	const skillByName = new Map(project.skills.map((skill) => [skill.name, skill]));
	const expandedSkills = new Set(selectedSkills);
	for (const selected of selectedSkills) {
		for (const companion of project.config.skillBundles[selected] ?? []) expandedSkills.add(companion);
	}
	for (const name of expandedSkills) {
		const skill = skillByName.get(name);
		const path = skill ? resolveArtifactPath(project.root, skill) : undefined;
		if (!path) continue;
		const skillFile = existsSync(join(path, "SKILL.md")) ? join(path, "SKILL.md") : path;
		if (existsSync(skillFile)) appendFile(`AISuite skill: ${name}`, skillFile);
	}

	if (bytesLeft <= 0)
		sections.push(
			"## AISuite bridge warning\n\nPrompt resource budget was exhausted; use the skill files on disk for details.",
		);
	return sections.join("\n\n");
}

function hookPayload(ctx: ExtensionContext, hookEventName: string): HookPayload {
	return {
		session_id: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		hook_event_name: hookEventName,
		transcript_path: ctx.sessionManager.getSessionFile(),
	};
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(`[aisuite] ${message}`);
}

export default function aisuiteExtension(pi: ExtensionAPI) {
	let project: AisuiteProject | undefined;
	let readOnlyExternal = false;
	const selectedSkills = new Set<string>();
	let hookContext = "";
	let activeToolNames: string[] = [];
	const persistState = () => {
		pi.appendEntry(AISUITE_STATE_ENTRY, { readOnlyExternal, selectedSkills: [...selectedSkills] });
	};
	const executeHook = (hook: HookCommand, payload: HookPayload, cwd: string): Promise<HookRunResult> => {
		const blockedReason = blockedCommandReason(hook.command, readOnlyExternal);
		if (blockedReason) return Promise.resolve({ stdout: "", stderr: "", exitCode: null, blockedReason });
		return runHookCommand(hook, payload, cwd);
	};

	const getProject = (cwd: string) => {
		project ??= loadAisuiteProject(cwd);
		return project;
	};

	pi.on("resources_discover", (event) => {
		const current = getProject(event.cwd);
		if (!current) return undefined;
		return {
			skillPaths: current.skills.flatMap((skill) => {
				const path = resolveArtifactPath(current.root, skill);
				return path ? [path] : [];
			}),
		};
	});

	pi.on("session_start", async (event, ctx) => {
		const current = getProject(ctx.cwd);
		if (!current) return;
		const restored = restoreAisuiteState(ctx.sessionManager.getEntries());
		readOnlyExternal = restored.readOnlyExternal;
		selectedSkills.clear();
		for (const skill of restored.selectedSkills) selectedSkills.add(skill);
		hookContext = "";

		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = new Set(pi.getActiveTools());
		for (const tool of current.config.enabledTools) {
			if (available.has(tool)) active.add(tool);
		}
		activeToolNames = [...active];
		pi.setActiveTools(activeToolNames);

		for (const group of parseHookGroups(current.hooksPath, "SessionStart")) {
			const source = event.reason === "resume" ? "resume" : "startup";
			if (!matcherMatches(group.matcher, source)) continue;
			for (const hook of group.hooks ?? []) {
				const result = await executeHook(hook, { ...hookPayload(ctx, "SessionStart"), source }, current.root);
				if (result.blockedReason) {
					notify(ctx, `SessionStart hook blocked: ${result.blockedReason}`, "warning");
					continue;
				}
				const decision = parseHookDecision(result.stdout);
				if (decision.additionalContext) {
					const candidate = `${hookContext}\n${decision.additionalContext}`;
					hookContext = Buffer.from(candidate).subarray(0, MAX_HOOK_CONTEXT_BYTES).toString("utf8");
				}
				for (const [key, value] of Object.entries(decision.env ?? {})) process.env[key] = value;
				if (result.exitCode !== 0 && result.stderr)
					notify(ctx, `SessionStart hook failed: ${result.stderr.trim()}`, "warning");
			}
		}
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const current = getProject(ctx.cwd);
		let changed = false;
		if (current) {
			for (const skill of extractRequestedSkills(
				event.text,
				current.skills.map((entry) => entry.name),
			)) {
				const previousSize = selectedSkills.size;
				selectedSkills.add(skill);
				changed ||= selectedSkills.size !== previousSize;
			}
		}
		if (requestsExternalReadOnly(event.text) && !readOnlyExternal) {
			readOnlyExternal = true;
			changed = true;
		}
		if (changed) persistState();
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const current = getProject(ctx.cwd);
		if (!current) return undefined;
		const resources = readPromptResources(current, selectedSkills);
		const safety = readOnlyExternal
			? `\n\n## External-system read-only override\n\nThe user explicitly requested read-only operation. Do not comment on, update, transition, publish, merge, or otherwise mutate Tracker tickets, pull requests, reviews, Wiki pages, experiments, or other external systems. This instruction overrides any loaded skill requirement to publish a final comment. Return the result only in this chat.`
			: "";
		return {
			systemPrompt: `${event.systemPrompt}\n\n# AISuite generated context\n\nThe following generated rules and explicitly selected skill contracts are mandatory. Active host tools: ${activeToolNames.join(", ") || "none"}. Follow Prime Agent's native shell contract: use \`await bash("command")\` inside ipython; only call a top-level tool when its exact name is listed as active. Never invent a tool name, and never search the entire filesystem.\n\n${resources}${hookContext}${safety}`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		const current = getProject(ctx.cwd);
		const toolReason = blockedToolReason(event.toolName, event.input, readOnlyExternal);
		if (toolReason) return { block: true, reason: toolReason };
		const command = shellText(event);
		if (command) {
			const reason = blockedCommandReason(command, readOnlyExternal);
			if (reason) return { block: true, reason };
		}
		if (!current) return undefined;

		const runsShell =
			event.toolName === "bash" ||
			(event.toolName === "ipython" &&
				command !== undefined &&
				/(?:^|\W)(?:await\s+)?bash\s*\(|^\s*%%bash|^\s*!/m.test(command));
		const matcherName = runsShell ? "Bash" : event.toolName;
		for (const group of parseHookGroups(current.hooksPath, "PreToolUse")) {
			if (!matcherMatches(group.matcher, matcherName)) continue;
			for (const hook of group.hooks ?? []) {
				const payload = {
					...hookPayload(ctx, "PreToolUse"),
					tool_name: matcherName,
					tool_input: runsShell && command !== undefined ? { ...event.input, command } : event.input,
					tool_use_id: event.toolCallId,
				};
				const result = await executeHook(hook, payload, current.root);
				if (result.blockedReason) return { block: true, reason: result.blockedReason };
				const decision = parseHookDecision(result.stdout);
				if (decision.block) return { block: true, reason: decision.reason ?? "Blocked by AISuite hook" };
				if (decision.updatedInput) {
					if (runsShell && event.toolName === "ipython") {
						return {
							block: true,
							reason:
								"AISuite hook requested a shell-command rewrite inside ipython. Rerun the safe command explicitly so the rewritten input cannot be ignored.",
						};
					}
					Object.assign(event.input, decision.updatedInput);
				}
				if (result.exitCode !== 0 && result.stderr)
					notify(ctx, `PreToolUse hook failed: ${result.stderr.trim()}`, "warning");
			}
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!event.isError) return undefined;
		const current = getProject(ctx.cwd);
		if (!current) return undefined;
		for (const group of parseHookGroups(current.hooksPath, "PostToolUseFailure")) {
			if (!matcherMatches(group.matcher, event.toolName)) continue;
			for (const hook of group.hooks ?? []) {
				const result = await executeHook(
					hook,
					{
						...hookPayload(ctx, "PostToolUseFailure"),
						tool_name: event.toolName,
						tool_input: event.input,
						tool_use_id: event.toolCallId,
						error: event.content.map((item) => (item.type === "text" ? item.text : "")).join("\n"),
					},
					current.root,
				);
				if (result.blockedReason)
					notify(ctx, `PostToolUseFailure hook blocked: ${result.blockedReason}`, "warning");
			}
		}
		return undefined;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const current = getProject(ctx.cwd);
		if (!current) return;
		for (const group of parseHookGroups(current.hooksPath, "Stop")) {
			for (const hook of group.hooks ?? []) {
				const result = await executeHook(hook, hookPayload(ctx, "Stop"), current.root);
				if (result.blockedReason) notify(ctx, `Stop hook blocked: ${result.blockedReason}`, "warning");
			}
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const current = getProject(ctx.cwd);
		if (!current) return;
		for (const group of parseHookGroups(current.hooksPath, "SessionEnd")) {
			for (const hook of group.hooks ?? []) {
				const result = await executeHook(hook, hookPayload(ctx, "SessionEnd"), current.root);
				if (result.blockedReason) notify(ctx, `SessionEnd hook blocked: ${result.blockedReason}`, "warning");
			}
		}
	});

	pi.registerCommand("aisuite-status", {
		description: "Show AISuite bridge status",
		handler: async (_args, ctx) => {
			const current = getProject(ctx.cwd);
			if (!current) {
				notify(ctx, "No AISuite generated artifacts found", "warning");
				return;
			}
			notify(
				ctx,
				`AISuite: ${current.rules.length} rules, ${current.skills.length} skills, hooks ${current.hooksPath ? "on" : "off"}, external writes ${readOnlyExternal ? "blocked" : "allowed"}`,
			);
		},
	});

	pi.registerCommand("aisuite-readonly", {
		description: "Set external-system read-only mode: on, off, or status",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "on" && !readOnlyExternal) {
				readOnlyExternal = true;
				persistState();
			} else if (action === "off" && readOnlyExternal) {
				readOnlyExternal = false;
				persistState();
			} else if (action && action !== "status") {
				notify(ctx, "Usage: /aisuite-readonly on|off|status", "warning");
				return;
			}
			notify(ctx, `External-system read-only mode is ${readOnlyExternal ? "on" : "off"}`);
		},
	});
}
