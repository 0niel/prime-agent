/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { type ImageContent, modelsAreEqual } from "@earendil-works/pi-ai";
import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Args, type Mode, parseArgs, printHelp } from "./cli/args.js";
import { handleDaemonCommand, normalizeDaemonStartArgs } from "./cli/daemon-command.js";
import { processFileArguments } from "./cli/file-processor.js";
import { buildInitialMessage } from "./cli/initial-message.js";
import { listModels } from "./cli/list-models.js";
import { selectSession } from "./cli/session-picker.js";
import { expandTildePath, getAgentDir, getSessionDirEnvOverride, VERSION } from "./config.js";
import { type AgentSessionRuntimeConfig, mergeAgentSessionRuntimeConfig } from "./core/agent-session-config.js";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "./core/agent-session-runtime.js";
import {
	type AgentSessionRuntimeDiagnostic,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./core/agent-session-services.js";
import { formatNoModelsAvailableMessage } from "./core/auth-guidance.js";
import { AuthStorage } from "./core/auth-storage.js";
import { exportFromFile } from "./core/export-html/index.js";
import type { ExtensionFactory } from "./core/extensions/types.js";
import { KeybindingsManager } from "./core/keybindings.js";
import type { ModelRegistry } from "./core/model-registry.js";
import { resolveCliModel, resolveModelScope, type ScopedModel } from "./core/model-resolver.js";
import { restoreStdout, takeOverStdout } from "./core/output-guard.js";
import type { CreateAgentSessionOptions } from "./core/sdk.js";
import {
	formatMissingSessionCwdPrompt,
	getMissingSessionCwdIssue,
	MissingSessionCwdError,
	type SessionCwdIssue,
} from "./core/session-cwd.js";
import { SessionManager } from "./core/session-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { printTimings, resetTimings, time } from "./core/timings.js";
import { runMigrations, showDeprecationWarnings } from "./migrations.js";
import { InteractiveMode, runDaemonMode, runPrintMode, runRpcMode } from "./modes/index.js";
import { ExtensionSelectorComponent } from "./modes/interactive/components/extension-selector.js";
import { initTheme, stopThemeWatcher } from "./modes/interactive/theme/theme.js";
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

type AppMode = "interactive" | "print" | "json" | "rpc" | "daemon";

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
	if (sessionArg.includes("/") || sessionArg.includes("\\") || sessionArg.endsWith(".jsonl")) {
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

function validateForkFlags(parsed: Args): void {
	if (!parsed.fork) return;

	const conflictingFlags = [
		parsed.session ? "--session" : undefined,
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
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.session) {
		const resolved = await resolveSessionPath(parsed.session, cwd, sessionDir);

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
				console.error(chalk.red(`No session found matching '${resolved.arg}'`));
				process.exit(1);
		}
	}

	if (parsed.resume) {
		initTheme(settingsManager.getTheme(), true);
		try {
			const selectedPath = await selectSession(
				(onProgress) => SessionManager.list(cwd, sessionDir, onProgress),
				SessionManager.listAll,
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

	return { options, cliThinkingFromModel, diagnostics };
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolve(cwd, value) : value));
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
		extensionFlagValues: parsed.unknownFlags.size > 0 ? Object.fromEntries(parsed.unknownFlags.entries()) : undefined,
	};
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

export interface MainOptions {
	extensionFactories?: ExtensionFactory[];
}

export async function main(args: string[], options?: MainOptions) {
	resetTimings();
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

	if (await handleDaemonCommand(args)) {
		return;
	}

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

	// Decide the final runtime cwd before creating cwd-bound runtime services.
	// --session and --resume may select a session from another project, so project-local
	// settings, resources, provider registrations, and models must be resolved only after
	// the target session cwd is known. The startup-cwd settings manager is used only for
	// sessionDir lookup during session selection.
	const sessionDir =
		(parsed.sessionDir ? expandTildePath(parsed.sessionDir) : undefined) ??
		getSessionDirEnvOverride() ??
		startupSettingsManager.getSessionDir();
	let sessionManager = await createSessionManager(parsed, cwd, sessionDir, startupSettingsManager);
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
	}) => {
		const config = mergeAgentSessionRuntimeConfig(defaultSessionConfig, sessionConfig);
		const effectiveAgentDir = config.agentDir ?? agentDir;
		const authStorage = AuthStorage.create(join(effectiveAgentDir, "auth.json"), {
			usePrimeCliConfig: effectiveAgentDir === agentDir,
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir: effectiveAgentDir,
			authStorage,
			extensionFlagValues: new Map(Object.entries(config.extensionFlagValues ?? {})),
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
				extensionFactories: options?.extensionFactories,
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

		if (config.apiKey) {
			if (!sessionOptions.model) {
				diagnostics.push({
					type: "error",
					message: "--api-key requires a model to be specified via --model, --provider/--model, or --models",
				});
			} else {
				authStorage.setRuntimeApiKey(sessionOptions.model.provider, config.apiKey);
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent,
			model: sessionOptions.model,
			thinkingLevel: sessionOptions.thinkingLevel,
			scopedModels: sessionOptions.scopedModels,
			tools: sessionOptions.tools,
			noTools: sessionOptions.noTools,
			customTools: sessionOptions.customTools,
		});
		const cliThinkingOverride = config.thinking !== undefined || cliThinkingFromModel;
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
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
		sessionConfig: defaultSessionConfig,
	});
	const { services, session, modelFallbackMessage } = runtime;
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

	const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);
	if (startupBenchmark && appMode !== "interactive") {
		console.error(chalk.red("Error: PI_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}

	if (appMode === "rpc") {
		printTimings();
		await runRpcMode(runtime);
	} else if (appMode === "daemon") {
		printTimings();
		await runDaemonMode(runtime, {
			socketPath: parsed.daemonSocket,
			defaultSessionConfig,
			createRuntime,
		});
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

		const interactiveMode = new InteractiveMode(runtime, {
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
