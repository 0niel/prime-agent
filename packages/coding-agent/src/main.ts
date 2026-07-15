/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type Api, type ImageContent, type Model, modelsAreEqual } from "@earendil-works/pi-ai";
import { registerBuiltinMcpOAuthProviders } from "@earendil-works/pi-ai/mcp";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.js";
import { handleDaemonCommand, normalizeDaemonStartArgs } from "./cli/daemon-command.js";
import {
	ensureInteractiveDaemonRunning,
	isDaemonSessionSummary,
	listActiveDaemonSessionSummaries,
	probeRunningDaemonSessions,
	StaleDaemonError,
	shutdownDaemonAndWait,
} from "./cli/daemon-launch.js";
import { confirmDaemonSessionLoss, type DaemonSessionLossCopy, pluralizeSessions } from "./cli/daemon-stop-confirm.js";
import { processFileArguments } from "./cli/file-processor.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { listModels } from "./cli/list-models.js";
import { installOwnedSessionRecoveryTracking } from "./cli/owned-session-worker.js";
import { selectSession } from "./cli/session-picker.js";
import { expandTildePath, getAgentDir, getSessionDirEnvOverride, VERSION } from "./config.js";
import {
	type AgentSessionRuntimeConfig,
	mergeAgentSessionRuntimeConfig,
	mergeAutonomousConfig,
} from "./core/agent-session-config.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "./core/agent-session-runtime.js";
import {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.js";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import type { ExtensionFactory } from "./core/extensions/types.js";
import { KeybindingsManager } from "./core/keybindings.js";
import { installFileLogSink, setLogContext } from "./core/logging.js";
import type { ModelRegistry } from "./core/model-registry.js";
import { findInitialModel, resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import type { CreateAgentSessionOptions } from "./core/sdk.js";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.js";
import { SessionAlreadyActiveError } from "./core/session-lease.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, resetTimings, time } from "./core/timings.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { isDaemonCatalogProcess, runDaemonCatalogProcess } from "./modes/daemon/daemon-catalog-process.js";
import { collectDaemonClientEnv } from "./modes/daemon/daemon-protocol.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	isDaemonWorkerProcess,
	requireDaemonWorkerAuthenticationToken,
	waitForDaemonWorkerStartupGate,
} from "./modes/daemon/daemon-worker-protocol.js";
import {
	type AgentConnection,
	createInteractiveModeLocalSessionHost,
	createInteractiveModeUiServicesFromServices,
	DaemonAgentConnection,
	DaemonClient,
	defaultDaemonSocketPath,
	InProcessAgentConnection,
	InteractiveMode,
	resolveAttachModelFallbackMessage,
	runAgentsViewMode,
	runDaemonMode,
	runDaemonSupervisorMode,
	runPrintMode,
	runRpcMode,
	type SessionSummary,
} from "./modes/index.js";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.js";
import { shouldRunOnboarding } from "./modes/interactive/onboarding.js";
import { initTheme, preloadCodeHighlighter, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
import { handleConfigCommand, handlePackageCommand } from "./package-manager-cli.js";
import { isLocalPath } from "./utils/paths.js";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export type AppMode = "interactive" | "print" | "json" | "rpc" | "daemon";

function resolveAppMode(parsed: Args, stdinIsTTY: boolean): AppMode {
	if (parsed.mode === "daemon") {
		return "daemon";
	}
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY) {
		return "print";
	}
	return "interactive";
}

function toPrintOutputMode(appMode: AppMode): Exclude<Mode, "rpc" | "daemon"> {
	return appMode === "json" ? "json" : "text";
}

// `prime-agent agents` / `prime-agent manage` open the agents view directly; the
// leading verb is stripped so the remaining args parse as usual.
export function parseAgentsViewCommand(args: string[]): { explicitAgentsView: boolean; args: string[] } {
	if (args[0] === "agents" || args[0] === "manage") {
		return { explicitAgentsView: true, args: args.slice(1) };
	}
	return { explicitAgentsView: false, args };
}

export interface InteractiveDaemonStartupDecision {
	appMode: AppMode;
	startupBenchmark: boolean;
	noSession?: boolean;
	help?: boolean;
	listModels?: string | true;
}

export function shouldUseDaemonInteractive(options: InteractiveDaemonStartupDecision): boolean {
	return (
		options.appMode === "interactive" &&
		!options.startupBenchmark &&
		!options.noSession &&
		!options.help &&
		options.listModels === undefined
	);
}

export interface AgentsViewStartupDecision {
	useDaemonInteractive: boolean;
	needsOnboarding: boolean;
	explicitAgentsView?: boolean;
	resume?: true | string;
	continue?: boolean;
	fork?: string;
}

export function shouldOpenAgentsViewForDaemonInteractive(options: AgentsViewStartupDecision): boolean {
	return (
		options.useDaemonInteractive &&
		// `prime-agent` opens a new chat by default; the agents view is reached via
		// left-arrow from a session or requested explicitly (`agents`/`manage`).
		!!options.explicitAgentsView &&
		// Onboarding lives in InteractiveMode, so a first run must take the
		// direct session path; the agents view would otherwise require creating
		// an agent before the onboarding splash ever renders.
		!options.needsOnboarding &&
		!options.resume &&
		!options.continue &&
		!options.fork
	);
}

export interface DaemonInteractiveSessionManagerDecision {
	resume?: true | string;
	continue?: boolean;
	fork?: string;
	hasActiveDaemonSession?: boolean;
}

export function shouldUseEphemeralSessionManagerForDaemonInteractive(
	options: DaemonInteractiveSessionManagerDecision,
): boolean {
	return !options.hasActiveDaemonSession && !options.resume && !options.continue && !options.fork;
}

export interface DaemonActiveSessionLookupDecision {
	useDaemonInteractive: boolean;
	resumeSelector?: string;
}

export function shouldEnsureDaemonBeforeActiveSessionLookup(options: DaemonActiveSessionLookupDecision): boolean {
	return (
		options.useDaemonInteractive &&
		options.resumeSelector !== undefined &&
		!looksLikeSessionPath(options.resumeSelector)
	);
}

type ActiveDaemonSessionSummaryLookup = (socketPath: string, selector: string) => Promise<SessionSummary | undefined>;

export async function findActiveDaemonSessionSummaryForInteractiveStartup(
	socketPath: string,
	selector: string,
	lookup: ActiveDaemonSessionSummaryLookup = findActiveDaemonSessionSummary,
): Promise<SessionSummary | undefined> {
	try {
		return await lookup(socketPath, selector);
	} catch {
		return undefined;
	}
}

const DAEMON_RICH_TUI_SHORTCUT_COMMANDS = new Set([
	"help",
	"start",
	"list",
	"create",
	"attach",
	"detach",
	"kill",
	"rename",
	"prompt",
	"steer",
	"follow-up",
	"state",
	"messages",
	"stats",
	"commands",
	"shutdown",
]);

export interface DaemonRichTuiAttachShortcut {
	socketPath: string;
	selector: string;
}

export function parseDaemonRichTuiAttachShortcut(args: string[]): DaemonRichTuiAttachShortcut | undefined {
	if (args[0] !== "daemon") {
		return undefined;
	}

	let socketPath = defaultDaemonSocketPath();
	let selector: string | undefined;
	for (let index = 1; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--socket" || arg === "--daemon-socket") {
			const value = args[index + 1];
			if (!value) {
				return undefined;
			}
			socketPath = value;
			index++;
			continue;
		}
		if (arg === "--json" || arg.startsWith("-") || DAEMON_RICH_TUI_SHORTCUT_COMMANDS.has(arg)) {
			return undefined;
		}
		if (selector) {
			return undefined;
		}
		selector = arg;
	}

	return selector ? { socketPath, selector } : undefined;
}

function looksLikeSessionPath(sessionArg: string): boolean {
	return sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl");
}

async function prepareInitialMessage(
	parsed: Args,
	autoResizeImages: boolean,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

/** Result from resolving a session argument */
type ResolvedSession =
	| { type: "path"; path: string } // Direct file path
	| { type: "local"; path: string } // Found in current project
	| { type: "global"; path: string; cwd: string } // Found in different project
	| { type: "not_found"; arg: string }; // Not found anywhere

/**
 * Resolve a session argument to a file path.
 * If it looks like a path, use as-is. Otherwise try to match as session ID prefix.
 */
async function resolveSessionPath(sessionArg: string, cwd: string, sessionDir?: string): Promise<ResolvedSession> {
	// If it looks like a file path, use as-is
	if (looksLikeSessionPath(sessionArg)) {
		return { type: "path", path: sessionArg };
	}

	// Try to match as session ID in current project first
	const localSessions = await SessionManager.list(cwd, sessionDir);
	const localMatches = localSessions.filter((s) => s.id.startsWith(sessionArg));

	if (localMatches.length >= 1) {
		return { type: "local", path: localMatches[0].path };
	}

	// Try global search across all projects
	const allSessions = await SessionManager.listAll();
	const globalMatches = allSessions.filter((s) => s.id.startsWith(sessionArg));

	if (globalMatches.length >= 1) {
		const match = globalMatches[0];
		return { type: "global", path: match.path, cwd: match.cwd };
	}

	// Not found anywhere
	return { type: "not_found", arg: sessionArg };
}

/** Prompt user for yes/no confirmation */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

// Only busy sessions (streaming, compacting, or pending messages) lose work;
// idle loaded sessions reload from disk on the fresh daemon.
const STARTUP_SESSION_LOSS_COPY: DaemonSessionLossCopy = {
	busyDetail(count) {
		const { noun, pronoun } = pluralizeSessions(count);
		return `A background daemon from a different prime-agent version is running with ${count} busy ${noun}. Stopping it will terminate ${pronoun}.`;
	},
	unlistableDetail:
		"A background daemon from a different prime-agent version is running and its sessions could not be listed. Stopping it may terminate active sessions.",
	question: "Stop it and continue?",
	nonTtyHint: 'Run "prime-agent daemon shutdown" to stop it, then retry.',
};

// The promise to keep after awaiting readiness. Wrapped in an object so it
// survives `await` (which would otherwise flatten a returned Promise to void).
type DaemonReadyResult = { ready: Promise<void> | undefined };

// A stale-version daemon couldn't be taken over automatically (busy or stuck).
// Offer to stop it (default No) and start a fresh daemon, or exit. Returns the
// fresh ready promise so callers stop re-handling the original rejection.
async function takeOverStaleDaemonOrExit(socketPath: string): Promise<DaemonReadyResult> {
	const probe = await probeRunningDaemonSessions(socketPath);
	const confirmed = await confirmDaemonSessionLoss(probe, { force: false, copy: STARTUP_SESSION_LOSS_COPY });
	if (!confirmed) {
		// Non-TTY already printed the reason; at a TTY the user declined.
		if (process.stdin.isTTY) {
			console.error(chalk.dim("Cancelled."));
		}
		process.exit(1);
	}
	if (!(await shutdownDaemonAndWait(socketPath))) {
		console.error(
			chalk.red(`Could not stop the daemon on ${socketPath}. Run "prime-agent daemon shutdown" and retry.`),
		);
		process.exit(1);
	}
	const ready = ensureInteractiveDaemonRunning(socketPath);
	try {
		await ready;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Could not start the daemon: ${message}`));
		process.exit(1);
	}
	return { ready };
}

// Resolves the daemon-ready promise, returning the promise to keep (the same
// one on success, or the fresh one from a stale-daemon takeover) so repeat
// calls don't re-handle the original rejection.
async function awaitDaemonReady(daemonReady: Promise<void> | undefined): Promise<DaemonReadyResult> {
	if (!daemonReady) {
		return { ready: daemonReady };
	}
	try {
		await daemonReady;
		return { ready: daemonReady };
	} catch (error) {
		if (error instanceof StaleDaemonError) {
			return takeOverStaleDaemonOrExit(error.socketPath);
		}
		throw error;
	}
}

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.continue ? "--continue" : undefined,
		parsed.resume ? "--resume" : undefined,
		parsed.noSession ? "--no-session" : undefined,
	].filter((flag): flag is string => flag !== undefined);

	if (conflictingFlags.length > 0) {
		console.error(chalk.red(`Error: --fork cannot be combined with ${conflictingFlags.join(", ")}`));
		process.exit(1);
	}
}

function forkSessionOrExit(sourcePath: string, cwd: string, sessionDir?: string): SessionManager {
	try {
		return SessionManager.forkFrom(sourcePath, cwd, sessionDir);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}
}

function getResumeSelector(parsed: Pick<Args, "resume">): string | undefined {
	return typeof parsed.resume === "string" ? parsed.resume : undefined;
}

export function restoreResumeSelectorFallback(parsed: Args, selector: string): boolean {
	if (parsed.resumeSelectorFallback !== selector) return false;
	delete parsed.resume;
	delete parsed.resumeSelectorFallback;
	parsed.messages.unshift(selector);
	return true;
}

export async function createSessionManager(
	parsed: Args,
	cwd: string,
	sessionDir: string | undefined,
	settingsManager: SettingsManager,
): Promise<SessionManager> {
	const explicitCwdOverride = parsed.cwd ? cwd : undefined;

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}

	if (parsed.fork) {
		const resolved = await resolveSessionPath(parsed.fork, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
			case "global":
				return forkSessionOrExit(resolved.path, cwd, sessionDir);

			case "not_found":
				if (restoreResumeSelectorFallback(parsed, resolved.arg)) break;
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	const resumeSelector = getResumeSelector(parsed);
	if (resumeSelector) {
		const resolved = await resolveSessionPath(resumeSelector, cwd, sessionDir);

		switch (resolved.type) {
			case "path":
			case "local":
				return SessionManager.open(resolved.path, sessionDir, explicitCwdOverride);

			case "global": {
				console.log(chalk.yellow(`Session found in different project: ${resolved.cwd}`));
				const shouldFork = await promptConfirm("Fork this session into current directory?");
				if (!shouldFork) {
					console.log(chalk.dim("Aborted."));
					process.exit(0);
				}
				return forkSessionOrExit(resolved.path, cwd, sessionDir);
			}

			case "not_found":
				if (restoreResumeSelectorFallback(parsed, resolved.arg)) break;
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(callbacks) => SessionManager.list(cwd, sessionDir, callbacks),
				SessionManager.listAll,
				{ cwd, sessionDir },
			);
			if (!selectedPath) {
				console.log(chalk.dim("No session selected"));
				process.exit(0);
			}
			return SessionManager.open(selectedPath, sessionDir, explicitCwdOverride);
		} finally {
			stopThemeWatcher();
		}
	}

	if (parsed.continue) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}

	return SessionManager.create(cwd, sessionDir);
}

function buildSessionOptions(
	config: AgentSessionRuntimeConfig,
	scopedModels: ScopedModel[],
	hasExistingSession: boolean,
	modelRegistry: ModelRegistry,
	settingsManager: SettingsManager,
): {
	options: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
} {
	const options: CreateAgentSessionOptions = {};
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	let cliThinkingFromModel = false;

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	if (config.model) {
		const resolved = resolveCliModel({
			cliProvider: config.provider,
			cliModel: config.model,
			modelRegistry,
		});
		if (resolved.warning) {
			diagnostics.push({ type: "warning", message: resolved.warning });
		}
		if (resolved.error) {
			diagnostics.push({ type: "error", message: resolved.error });
		}
		if (resolved.model) {
			options.model = resolved.model;
			// Allow "--model <pattern>:<thinking>" as a shorthand.
			// Explicit --thinking still takes precedence (applied later).
			if (!config.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				cliThinkingFromModel = true;
			}
		}
	}

	if (!options.model && scopedModels.length > 0 && !hasExistingSession) {
		// Check if saved default is in scoped models - use it if so, otherwise first scoped model
		const savedProvider = settingsManager.getDefaultProvider();
		const savedModelId = settingsManager.getDefaultModel();
		const savedModel = savedProvider && savedModelId ? modelRegistry.find(savedProvider, savedModelId) : undefined;
		const savedInScope = savedModel ? scopedModels.find((sm) => modelsAreEqual(sm.model, savedModel)) : undefined;

		if (savedInScope) {
			options.model = savedInScope.model;
			// Use thinking level from scoped model config if explicitly set
			if (!config.thinking && savedInScope.thinkingLevel) {
				options.thinkingLevel = savedInScope.thinkingLevel;
			}
		} else {
			options.model = scopedModels[0].model;
			// Use thinking level from first scoped model if explicitly set
			if (!config.thinking && scopedModels[0].thinkingLevel) {
				options.thinkingLevel = scopedModels[0].thinkingLevel;
			}
		}
	}

	// Thinking level from CLI (takes precedence over scoped model thinking levels set above)
	if (config.thinking) {
		options.thinkingLevel = config.thinking;
	}

	// Scoped models for Ctrl+P cycling
	// Keep thinking level undefined when not explicitly set in the model pattern.
	// Undefined means "inherit current session thinking level" during cycling.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map((sm) => ({
			model: sm.model,
			thinkingLevel: sm.thinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// Tools
	if (config.noTools) {
		options.noTools = "all";
	} else if (config.noBuiltinTools) {
		options.noTools = "builtin";
	}
	if (config.tools) {
		options.tools = [...config.tools];
	}
	if (config.autonomous) {
		options.autonomous = mergeAutonomousConfig(undefined, config.autonomous);
	}

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
}

function runtimeAutonomousConfigFromArgs(parsed: Args): AgentSessionRuntimeConfig["autonomous"] {
	const hasAutonomousOptions =
		parsed.autonomous === true ||
		parsed.autonomousGates !== undefined ||
		parsed.autonomousGateRetries !== undefined ||
		parsed.autonomousGateTimeoutMs !== undefined ||
		parsed.autonomousMaxContinuations !== undefined ||
		parsed.autonomousMaxTurns !== undefined ||
		parsed.autonomousMaxTokens !== undefined ||
		parsed.autonomousTimeoutMs !== undefined;
	if (!hasAutonomousOptions) {
		return undefined;
	}
	const hasGateOptions =
		parsed.autonomousGates !== undefined ||
		parsed.autonomousGateRetries !== undefined ||
		parsed.autonomousGateTimeoutMs !== undefined;
	return {
		enabled: true,
		maxContinuations: parsed.autonomousMaxContinuations,
		maxTurns: parsed.autonomousMaxTurns,
		maxTokens: parsed.autonomousMaxTokens,
		timeoutMs: parsed.autonomousTimeoutMs,
		gates: hasGateOptions
			? {
					commands: parsed.autonomousGates,
					maxRetries: parsed.autonomousGateRetries,
					timeoutMs: parsed.autonomousGateTimeoutMs,
				}
			: undefined,
	};
}

function runtimeConfigFromArgs(
	parsed: Args,
	cwd: string,
	agentDir: string,
	sessionDir: string | undefined,
): AgentSessionRuntimeConfig {
	return {
		cwd,
		agentDir,
		sessionDir,
		provider: parsed.provider,
		model: parsed.model,
		apiKey: parsed.apiKey,
		systemPrompt: parsed.systemPrompt,
		appendSystemPrompt: parsed.appendSystemPrompt,
		thinking: parsed.thinking,
		models: parsed.models,
		tools: parsed.tools,
		noTools: parsed.noTools,
		noBuiltinTools: parsed.noBuiltinTools,
		extensions: resolveCliPaths(cwd, parsed.extensions),
		noExtensions: parsed.noExtensions,
		skills: resolveCliPaths(cwd, parsed.skills),
		noSkills: parsed.noSkills,
		promptTemplates: resolveCliPaths(cwd, parsed.promptTemplates),
		noPromptTemplates: parsed.noPromptTemplates,
		themes: resolveCliPaths(cwd, parsed.themes),
		noThemes: parsed.noThemes,
		noContextFiles: parsed.noContextFiles,
		autonomous: runtimeAutonomousConfigFromArgs(parsed),
		extensionFlagValues: parsed.unknownFlags.size > 0 ? Object.fromEntries(parsed.unknownFlags.entries()) : undefined,
	};
}

interface PreparedRuntimeServices {
	services: AgentSessionServices;
	scopedModels: ScopedModel[];
	sessionOptions: CreateAgentSessionOptions;
	cliThinkingFromModel: boolean;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

export function resolveRuntimeSessionOptions(
	sessionOptions: CreateAgentSessionOptions,
	runtimeSessionOptions?: CreateAgentSessionOptions,
): CreateAgentSessionOptions {
	return {
		model: runtimeSessionOptions?.model ?? sessionOptions.model,
		thinkingLevel: runtimeSessionOptions?.thinkingLevel ?? sessionOptions.thinkingLevel,
		serviceTier: runtimeSessionOptions?.serviceTier ?? sessionOptions.serviceTier,
		scopedModels: runtimeSessionOptions?.scopedModels ?? sessionOptions.scopedModels,
		tools: runtimeSessionOptions?.tools ?? sessionOptions.tools,
		noTools: runtimeSessionOptions?.noTools ?? sessionOptions.noTools,
		customTools: runtimeSessionOptions?.customTools ?? sessionOptions.customTools,
		initialActiveToolNames: runtimeSessionOptions?.initialActiveToolNames,
		allowedToolNames: runtimeSessionOptions?.allowedToolNames,
		includeGoals: runtimeSessionOptions?.includeGoals,
		includeCompactSkill: runtimeSessionOptions?.includeCompactSkill,
		rlmHeartbeatController: runtimeSessionOptions?.rlmHeartbeatController,
		agentMessageController: runtimeSessionOptions?.agentMessageController,
		agentObserveController: runtimeSessionOptions?.agentObserveController,
		autonomous:
			(runtimeSessionOptions?.rlmDepth ?? 0) > 0
				? mergeAutonomousConfig(sessionOptions.autonomous, { ...runtimeSessionOptions?.autonomous, enabled: false })
				: mergeAutonomousConfig(sessionOptions.autonomous, runtimeSessionOptions?.autonomous),
		rlmDepth: runtimeSessionOptions?.rlmDepth,
		rlmMaxDepth: runtimeSessionOptions?.rlmMaxDepth,
		rlmSessionDir: runtimeSessionOptions?.rlmSessionDir,
		rlmParentNodeId: runtimeSessionOptions?.rlmParentNodeId,
		subagentRuntimeHost: runtimeSessionOptions?.subagentRuntimeHost,
	};
}

async function prepareRuntimeServices(options: {
	config: AgentSessionRuntimeConfig;
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	extensionFactories?: ExtensionFactory[];
	sessionOptionsOverride?: CreateAgentSessionOptions;
}): Promise<PreparedRuntimeServices> {
	const { config, sessionManager } = options;
	const effectiveAgentDir = config.agentDir ?? options.agentDir;
	const authStorage = AuthStorage.create(join(effectiveAgentDir, "auth.json"), {
		usePrimeCliConfig: effectiveAgentDir === options.agentDir,
	});
	const services = await createAgentSessionServices({
		cwd: options.cwd,
		agentDir: effectiveAgentDir,
		authStorage,
		extensionFlagValues: new Map(Object.entries(config.extensionFlagValues ?? {})),
		// Subagents share the parent's Herdr pane; their own reporter would race
		// the parent's and a subagent quit would release the still-active pane.
		noBuiltinHerdrReporter: (options.sessionOptionsOverride?.rlmDepth ?? 0) > 0,
		resourceLoaderOptions: {
			additionalExtensionPaths: config.extensions,
			additionalSkillPaths: config.skills,
			additionalPromptTemplatePaths: config.promptTemplates,
			additionalThemePaths: config.themes,
			noExtensions: config.noExtensions,
			noSkills: config.noSkills,
			noPromptTemplates: config.noPromptTemplates,
			noThemes: config.noThemes,
			noContextFiles: config.noContextFiles,
			systemPrompt: config.systemPrompt,
			appendSystemPrompt: config.appendSystemPrompt,
			extensionFactories: options.extensionFactories,
		},
	});
	const { settingsManager, modelRegistry, resourceLoader } = services;
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [
		...services.diagnostics,
		...collectSettingsDiagnostics(settingsManager, "runtime creation"),
		...resourceLoader.getExtensions().errors.map(({ path, error }) => ({
			type: "error" as const,
			message: `Failed to load extension "${path}": ${error}`,
		})),
	];

	const modelPatterns = config.models ?? settingsManager.getEnabledModels();
	const scopedModels =
		modelPatterns && modelPatterns.length > 0 ? await resolveModelScope(modelPatterns, modelRegistry) : [];
	const {
		options: sessionOptions,
		cliThinkingFromModel,
		diagnostics: sessionOptionDiagnostics,
	} = buildSessionOptions(
		config,
		scopedModels,
		sessionManager.buildSessionContext().messages.length > 0,
		modelRegistry,
		settingsManager,
	);
	diagnostics.push(...sessionOptionDiagnostics);

	const effectiveSessionModel = options.sessionOptionsOverride?.model ?? sessionOptions.model;
	if (config.apiKey) {
		if (!effectiveSessionModel) {
			diagnostics.push({
				type: "error",
				message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
			});
		} else {
			authStorage.setRuntimeApiKey(effectiveSessionModel.provider, config.apiKey);
		}
	}

	return {
		services,
		scopedModels,
		sessionOptions,
		cliThinkingFromModel,
		diagnostics,
	};
}

async function resolvePreparedStartupModel(options: {
	prepared: PreparedRuntimeServices;
	sessionManager: SessionManager;
}): Promise<{ model: Model<Api> | undefined; modelFallbackMessage: string | undefined }> {
	const { prepared, sessionManager } = options;
	const { modelRegistry, settingsManager } = prepared.services;
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;

	let model = prepared.sessionOptions.model;
	let modelFallbackMessage: string | undefined;

	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRegistry.hasConfiguredAuth(restoredModel)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	if (!model) {
		const result = await findInitialModel({
			scopedModels: prepared.scopedModels,
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRegistry,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	return { model, modelFallbackMessage };
}

async function promptForMissingSessionCwd(
	issue: SessionCwdIssue,
	settingsManager: SettingsManager,
): Promise<string | undefined> {
	initTheme(settingsManager.getTheme());
	setKeybindings(KeybindingsManager.create());

	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal(), settingsManager.getShowHardwareCursor());
		ui.setClearOnShrink(settingsManager.getClearOnShrink());

		let settled = false;
		const finish = (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			ui.stop();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			formatMissingSessionCwdPrompt(issue),
			["Continue", "Cancel"],
			(option) => finish(option === "Continue" ? issue.fallbackCwd : undefined),
			() => finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		ui.start();
	});
}

function getDaemonSummaryActiveSessionId(summary: SessionSummary): string {
	return summary.activeSessionId ?? summary.id;
}

function isUnknownActiveSessionError(message: string): boolean {
	return message.startsWith("Unknown active session:");
}

async function findActiveDaemonSessionSummary(
	socketPath: string,
	selector: string,
): Promise<SessionSummary | undefined> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect(250);
	} catch {
		return undefined;
	}

	try {
		const response = await client.request({ type: "get_state", activeSessionId: selector }, 3000);
		if (!response.success) {
			if (isUnknownActiveSessionError(response.error)) {
				return undefined;
			}
			throw new Error(response.error);
		}
		if (!isDaemonSessionSummary(response.data)) {
			throw new Error("Daemon returned an invalid active session summary");
		}
		return response.data;
	} finally {
		client.close();
	}
}

async function normalizeDaemonRichTuiAttachArgs(args: string[]): Promise<string[] | undefined> {
	const shortcut = parseDaemonRichTuiAttachShortcut(args);
	if (!shortcut) {
		return undefined;
	}

	const summary = await findActiveDaemonSessionSummary(shortcut.socketPath, shortcut.selector);
	if (!summary) {
		return undefined;
	}

	return ["--daemon-socket", shortcut.socketPath, "--resume", getDaemonSummaryActiveSessionId(summary)];
}

function createSessionManagerForActiveDaemonSummary(summary: SessionSummary, fallbackCwd: string): SessionManager {
	const cwd = summary.cwd || fallbackCwd;
	if (summary.sessionFile) {
		try {
			return SessionManager.open(summary.sessionFile, undefined, cwd);
		} catch {
			return SessionManager.inMemory(cwd);
		}
	}
	return SessionManager.inMemory(cwd);
}

function getInteractiveDaemonSessionPath(parsed: Args, sessionManager: SessionManager): string | undefined {
	if (!parsed.resume && !parsed.continue && !parsed.fork) {
		return undefined;
	}
	return sessionManager.getSessionFile();
}

export function findActiveDaemonSessionSummaryForSessionFile(
	summaries: readonly SessionSummary[],
	sessionPath: string,
): SessionSummary | undefined {
	const resolvedSessionPath = resolve(sessionPath);
	return summaries.find(
		(summary) =>
			summary.activeSessionId !== undefined &&
			summary.sessionFile !== undefined &&
			resolve(summary.sessionFile) === resolvedSessionPath,
	);
}

async function createDaemonInteractiveConnection(options: {
	socketPath: string;
	config: AgentSessionRuntimeConfig;
	sessionPath?: string;
	continueRecent?: boolean;
	activeSessionId?: string;
}): Promise<{ connection: DaemonAgentConnection; summary: SessionSummary }> {
	// Caller must have awaited ensureInteractiveDaemonRunning for this socket.
	const client = new DaemonClient(options.socketPath);
	await client.connect();

	try {
		const attach = async (summary: SessionSummary) => {
			const connection = await DaemonAgentConnection.attach(client, getDaemonSummaryActiveSessionId(summary), {
				closeClientOnDispose: true,
				sendClientEnv: true,
				recoverDaemon: () => ensureInteractiveDaemonRunning(options.socketPath),
			});
			return { connection, summary };
		};

		if (options.activeSessionId) {
			const summary = await findAttachedDaemonSessionSummary(client, options.activeSessionId);
			return await attach(summary);
		}

		if (options.sessionPath) {
			const activeSummary = findActiveDaemonSessionSummaryForSessionFile(
				await listActiveDaemonSessionSummaries(client),
				options.sessionPath,
			);
			if (activeSummary) {
				return await attach(activeSummary);
			}
		}

		const response = await client.request({
			type: "create",
			config: options.config,
			sessionPath: options.sessionPath,
			continueRecent: options.continueRecent,
			env: collectDaemonClientEnv(),
		});
		if (!response.success) {
			throw new Error(response.error);
		}
		if (!isDaemonSessionSummary(response.data)) {
			throw new Error("Daemon returned an invalid create response");
		}
		const summary = response.data;
		return await attach(summary);
	} catch (error) {
		client.close();
		throw error;
	}
}

async function findAttachedDaemonSessionSummary(
	client: DaemonClient,
	activeSessionId: string,
): Promise<SessionSummary> {
	const response = await client.request({ type: "get_state", activeSessionId });
	if (!response.success) {
		throw new Error(response.error);
	}
	if (!isDaemonSessionSummary(response.data)) {
		throw new Error("Daemon returned an invalid active session summary");
	}
	return response.data;
}

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
	if (isDaemonWorkerProcess()) {
		waitForDaemonWorkerStartupGate();
	}
	installFileLogSink();
	if (isDaemonCatalogProcess()) {
		await runDaemonCatalogProcess();
		return;
	}
	// Client and daemon are separate processes; both need these in their registry.
	registerBuiltinMcpOAuthProviders();
	args = normalizeDaemonStartArgs(args) ?? args;
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.PI_OFFLINE);
	if (offlineMode) {
		process.env.PI_OFFLINE = "1";
		process.env.PI_SKIP_VERSION_CHECK = "1";
	}

	if (await handlePackageCommand(args)) {
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}

	try {
		args = (await normalizeDaemonRichTuiAttachArgs(args)) ?? args;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(chalk.red(`Error: ${message}`));
		process.exit(1);
	}

	if (await handleDaemonCommand(args)) {
		return;
	}

	// `prime-agent agents` / `prime-agent manage` open the agents view directly.
	const agentsViewCommand = parseAgentsViewCommand(args);
	const explicitAgentsView = agentsViewCommand.explicitAgentsView;
	args = agentsViewCommand.args;

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");
	let appMode = resolveAppMode(parsed, process.stdin.isTTY);
	setLogContext({ mode: appMode });
	const shouldTakeOverStdout = appMode !== "interactive";
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	if ((parsed.mode === "rpc" || parsed.mode === "daemon") && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC or daemon mode"));
		process.exit(1);
	}

	validateForkFlags(parsed);

	const cwd = parsed.cwd ? resolve(expandTildePath(parsed.cwd)) : process.cwd();
	if (parsed.cwd) {
		try {
			process.chdir(cwd);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(chalk.red(`Error: Cannot use cwd ${cwd}: ${message}`));
			process.exit(1);
		}
	}

	// Run migrations (pass cwd for project-local migrations)
	const { migratedAuthProviders: migratedProviders, deprecationWarnings } = runMigrations(cwd);
	time("runMigrations");

	const agentDir = getAgentDir();
	const startupSettingsManager = SettingsManager.create(cwd, agentDir);
	reportDiagnostics(collectSettingsDiagnostics(startupSettingsManager, "startup session lookup"));
	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}
	const useDaemonInteractive = shouldUseDaemonInteractive({
		appMode,
		startupBenchmark,
		noSession: parsed.noSession,
		help: parsed.help,
		listModels: parsed.listModels,
	});

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const sessionDir =
		(parsed.sessionDir ? expandTildePath(parsed.sessionDir) : undefined) ??
		getSessionDirEnvOverride() ??
		startupSettingsManager.getSessionDir();
	const daemonSocketPath = parsed.daemonSocket ?? defaultDaemonSocketPath();
	// Kick off daemon spawn/readiness immediately so it overlaps session-manager
	// and runtime-services preparation; awaited wherever the daemon is first used.
	let daemonReady = useDaemonInteractive ? ensureInteractiveDaemonRunning(daemonSocketPath) : undefined;
	// Errors are rethrown at the await sites below; this only avoids an unhandled
	// rejection if startup exits before reaching them.
	daemonReady?.catch(() => {});
	const resumeSelector = getResumeSelector(parsed);
	const shouldLookupDaemonActiveSession = shouldEnsureDaemonBeforeActiveSessionLookup({
		useDaemonInteractive,
		resumeSelector,
	});
	if (shouldLookupDaemonActiveSession && daemonReady) {
		daemonReady = (await awaitDaemonReady(daemonReady)).ready;
	}
	const activeDaemonSessionSummary =
		shouldLookupDaemonActiveSession && resumeSelector
			? await findActiveDaemonSessionSummaryForInteractiveStartup(daemonSocketPath, resumeSelector)
			: undefined;
	let sessionManager: SessionManager;
	if (activeDaemonSessionSummary) {
		sessionManager = createSessionManagerForActiveDaemonSummary(activeDaemonSessionSummary, cwd);
	} else if (
		useDaemonInteractive &&
		shouldUseEphemeralSessionManagerForDaemonInteractive({
			resume: parsed.resume,
			continue: parsed.continue,
			fork: parsed.fork,
		})
	) {
		sessionManager = SessionManager.inMemory(cwd);
	} else {
		sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
	}
	const missingSessionCwdIssue = getMissingSessionCwdIssue(sessionManager, cwd);
	if (missingSessionCwdIssue) {
		if (appMode === "interactive") {
			const selectedCwd = await promptForMissingSessionCwd(missingSessionCwdIssue, startupSettingsManager);
			if (!selectedCwd) {
				process.exit(0);
			}
			sessionManager = SessionManager.open(missingSessionCwdIssue.sessionFile!, sessionDir, selectedCwd);
		} else {
			console.error(chalk.red(new MissingSessionCwdError(missingSessionCwdIssue).message));
			process.exit(1);
		}
	}
	time("createSessionManager");

	const defaultSessionConfig = runtimeConfigFromArgs(parsed, sessionManager.getCwd(), agentDir, sessionDir);
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
		sessionConfig,
		sessionOptions: runtimeSessionOptions,
	}) => {
		const config = mergeAgentSessionRuntimeConfig(defaultSessionConfig, sessionConfig);
		const prepared = await prepareRuntimeServices({
			config,
			cwd,
			agentDir,
			sessionManager,
			extensionFactories: options?.extensionFactories,
			sessionOptionsOverride: runtimeSessionOptions,
		});
		const { services, sessionOptions, diagnostics } = prepared;
		const resolvedSessionOptions = resolveRuntimeSessionOptions(sessionOptions, runtimeSessionOptions);

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			...resolvedSessionOptions,
			// Main agents boot their kernel in the background at session creation;
			// subagent sessions (rlmDepth > 0) keep the lazy first-call start.
			prewarmIpythonKernel: true,
		});
		const cliThinkingOverride = config.thinking !== undefined || prepared.cliThinkingFromModel;
		if (created.session.model && cliThinkingOverride) {
			created.session.setThinkingLevel(created.session.thinkingLevel);
		}

		return {
			...created,
			services,
			diagnostics,
		};
	};
	time("createRuntime");
	// Daemon mode never uses the bootstrap runtime, so skip the heavy
	// createAgentSessionRuntime below and start listening immediately; sessions
	// are created on demand through the daemon protocol via createRuntime.
	// --help/--list-models still take the full path to print and exit.
	if (appMode === "daemon" && !parsed.help && parsed.listModels === undefined) {
		printTimings();
		if (isDaemonWorkerProcess()) {
			await runDaemonMode({
				socketPath: parsed.daemonSocket,
				defaultSessionConfig,
				createRuntime,
				worker: {
					authenticationToken: requireDaemonWorkerAuthenticationToken(),
					restoreActiveSessionId: process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV],
				},
			});
		} else {
			await runDaemonSupervisorMode({
				socketPath: parsed.daemonSocket,
				defaultSessionConfig,
			});
		}
		return;
	}
	if (useDaemonInteractive) {
		const prepared = await prepareRuntimeServices({
			config: defaultSessionConfig,
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
			extensionFactories: options?.extensionFactories,
		});
		const { services, scopedModels } = prepared;
		const { settingsManager } = services;

		const startupModel = await resolvePreparedStartupModel({ prepared, sessionManager });

		let stdinContent: string | undefined;
		stdinContent = await readPipedStdin();
		time("readPipedStdin");

		const { initialMessage, initialImages } = await prepareInitialMessage(
			parsed,
			settingsManager.getImageAutoResize(),
			stdinContent,
		);
		time("prepareInitialMessage");
		initTheme(settingsManager.getTheme(), true);
		time("initTheme");

		if (deprecationWarnings.length > 0) {
			await showDeprecationWarnings(deprecationWarnings);
		}

		reportDiagnostics(prepared.diagnostics);
		if (prepared.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			process.exit(1);
		}
		time("prepareInteractiveServices");

		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		const daemonUiServices = createInteractiveModeUiServicesFromServices({
			services,
			sessionManager,
		});
		const launchAgentsView = async (includeInitialPrompts: boolean) => {
			await runAgentsViewMode({
				socketPath: daemonSocketPath,
				config: defaultSessionConfig,
				uiServices: daemonUiServices,
				recoverDaemon: () => ensureInteractiveDaemonRunning(daemonSocketPath),
				createUiServicesForSession: async (summary) => {
					const attachedSessionManager = createSessionManagerForActiveDaemonSummary(
						summary,
						sessionManager.getCwd(),
					);
					const attachedPrepared = await prepareRuntimeServices({
						config: mergeAgentSessionRuntimeConfig(defaultSessionConfig, {
							cwd: attachedSessionManager.getCwd(),
						}),
						cwd: attachedSessionManager.getCwd(),
						agentDir,
						sessionManager: attachedSessionManager,
						extensionFactories: options?.extensionFactories,
					});
					return createInteractiveModeUiServicesFromServices({
						services: attachedPrepared.services,
						sessionManager: attachedSessionManager,
					});
				},
				migratedProviders,
				modelFallbackMessage: startupModel.modelFallbackMessage,
				startupModelId: startupModel.model?.id,
				...(includeInitialPrompts ? { initialMessage, initialImages, initialMessages: parsed.messages } : {}),
				verbose: parsed.verbose,
			});
		};
		if (
			shouldOpenAgentsViewForDaemonInteractive({
				useDaemonInteractive,
				explicitAgentsView,
				needsOnboarding: shouldRunOnboarding({
					settingsManager,
					modelRegistry: services.modelRegistry,
					model: startupModel.model,
				}),
				resume: parsed.resume,
				continue: parsed.continue,
				fork: parsed.fork,
			})
		) {
			daemonReady = (await awaitDaemonReady(daemonReady)).ready;
			await preloadCodeHighlighter();
			printTimings();
			await launchAgentsView(true);
			return;
		}

		daemonReady = (await awaitDaemonReady(daemonReady)).ready;
		// A fresh default chat opens a real but message-less session; the lifecycle
		// axis treats it as a draft (hidden, discarded on detach if never used), so
		// no DeferredAgentConnection is needed to avoid creating it up front.
		const isFreshDefaultSession =
			!activeDaemonSessionSummary && !getInteractiveDaemonSessionPath(parsed, sessionManager);
		const { connection, summary } = await createDaemonInteractiveConnection({
			socketPath: daemonSocketPath,
			config: defaultSessionConfig,
			activeSessionId: activeDaemonSessionSummary
				? getDaemonSummaryActiveSessionId(activeDaemonSessionSummary)
				: undefined,
			sessionPath: getInteractiveDaemonSessionPath(parsed, sessionManager),
		});
		const agentConnection: AgentConnection = connection;
		const attachModelFallbackMessage = isFreshDefaultSession
			? startupModel.modelFallbackMessage
			: resolveAttachModelFallbackMessage(summary, startupModel.modelFallbackMessage);

		const interactiveMode = new InteractiveMode({
			agentConnection,
			uiServices: daemonUiServices,
			bindLocalSessionExtensions: false,
			migratedProviders,
			modelFallbackMessage: attachModelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
			// Resumed/attached daemon sessions are part of the same fleet; left
			// arrow takes them to the agents view like any other session. The agents
			// view was not rendered here, so we intentionally leave
			// agentsViewOwnsStartupNotices unset and let the in-session fallback run.
			returnToAgentsView: true,
		});

		await preloadCodeHighlighter();
		printTimings();
		await interactiveMode.run();
		await launchAgentsView(false);
		return;
	}

	let runtime: AgentSessionRuntime;
	try {
		runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionManager.getCwd(),
			agentDir,
			sessionManager,
			sessionConfig: defaultSessionConfig,
		});
	} catch (error) {
		if (error instanceof SessionAlreadyActiveError) {
			console.error(chalk.red(`Error: ${error.message}`));
			process.exit(1);
		}
		throw error;
	}
	const { services, session, modelFallbackMessage } = runtime;
	installOwnedSessionRecoveryTracking(runtime);
	const { settingsManager, modelRegistry, resourceLoader } = services;

	if (parsed.help) {
		const extensionFlags = resourceLoader
			.getExtensions()
			.extensions.flatMap((extension) => Array.from(extension.flags.values()));
		printHelp(extensionFlags);
		process.exit(0);
	}

	if (parsed.listModels !== undefined) {
		const searchPattern = typeof parsed.listModels === "string" ? parsed.listModels : undefined;
		await listModels(modelRegistry, searchPattern);
		process.exit(0);
	}

	// Read piped stdin content (if any) - skip for RPC/daemon modes which use other transports
	let stdinContent: string | undefined;
	if (appMode !== "rpc" && appMode !== "daemon") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
	}
	time("readPipedStdin");

	const { initialMessage, initialImages } = await prepareInitialMessage(
		parsed,
		settingsManager.getImageAutoResize(),
		stdinContent,
	);
	time("prepareInitialMessage");
	initTheme(settingsManager.getTheme(), appMode === "interactive");
	time("initTheme");

	// Show deprecation warnings in interactive mode
	if (appMode === "interactive" && deprecationWarnings.length > 0) {
		await showDeprecationWarnings(deprecationWarnings);
	}

	const scopedModels = [...session.scopedModels];
	time("resolveModelScope");
	reportDiagnostics(runtime.diagnostics);
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		process.exit(1);
	}
	time("createAgentSession");

	if (appMode !== "interactive" && appMode !== "daemon" && !session.model) {
		console.error(chalk.red(formatNoModelsAvailableMessage()));
		process.exit(1);
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "interactive") {
		if (scopedModels.length > 0 && (parsed.verbose || !settingsManager.getQuietStartup())) {
			const modelList = scopedModels
				.map((sm) => {
					const thinkingStr = sm.thinkingLevel ? `:${sm.thinkingLevel}` : "";
					return `${sm.model.id}${thinkingStr}`;
				})
				.join(", ");
			console.log(chalk.dim(`Model scope: ${modelList} ${chalk.gray("(Ctrl+P to cycle)")}`));
		}

		const interactiveMode = new InteractiveMode({
			agentConnection: new InProcessAgentConnection(runtime),
			localSessionHost: createInteractiveModeLocalSessionHost(runtime),
			bindLocalSessionExtensions: true,
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages: parsed.messages,
			verbose: parsed.verbose,
		});
		if (startupBenchmark) {
			await interactiveMode.init();
			time("interactiveMode.init");
			printTimings();
			interactiveMode.stop();
			stopThemeWatcher();
			if (process.stdout.writableLength > 0) {
				await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
			}
			if (process.stderr.writableLength > 0) {
				await new Promise<void>((resolve) => process.stderr.once("drain", resolve));
			}
			return;
		}

		await preloadCodeHighlighter();
		printTimings();
		await interactiveMode.run();
	} else {
		printTimings();
		const exitCode = await runPrintMode(runtime, {
			mode: toPrintOutputMode(appMode),
			messages: parsed.messages,
			initialMessage,
			initialImages,
		});
		stopThemeWatcher();
		restoreStdout();
		if (exitCode !== 0) {
			process.exitCode = exitCode;
		}
		return;
	}
}
