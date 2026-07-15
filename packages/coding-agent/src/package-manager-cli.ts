import chalk from "chalk";
import { spawn } from "child_process";
import { readFileSync, rmSync, statSync } from "fs";
import { selectConfig } from "./cli/config-selector.js";
import {
	ensureInteractiveDaemonRunning,
	isDaemonSessionSummary,
	isSessionBusy,
	probeRunningDaemonSessions,
	type RunningDaemonProbe,
	shutdownDaemonAndWait,
} from "./cli/daemon-launch.js";
import { confirmDaemonSessionLoss, type DaemonSessionLossCopy, pluralizeSessions } from "./cli/daemon-stop-confirm.js";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	getAgentDir,
	getDaemonUpdateRestartManifestPath,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	type SelfUpdateCommand,
	VERSION,
} from "./config.js";
import { parseAgentSessionMessagePromptId } from "./core/agent-messages.js";
import type { AgentSessionRuntimeMetadata } from "./core/agent-session-runtime.js";
import type { CustomMessage } from "./core/messages.js";
import { DefaultPackageManager } from "./core/package-manager.js";
import { SettingsManager } from "./core/settings-manager.js";
import { DaemonClient } from "./modes/daemon/daemon-client.js";
import {
	DAEMON_PROTOCOL_VERSION,
	type DaemonUpdateRestartManifest,
	type DaemonUpdateRestartQueuedMessage,
	type DaemonUpdateRestartSession,
	isUnknownDaemonCommandError,
} from "./modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "./modes/daemon/daemon-socket.js";
import { shouldUseWindowsShell } from "./utils/child-process.js";
import { getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.js";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string };

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	local: boolean;
	force: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(chalk.yellow(`Warning (${context}, ${scope} settings): ${error.message}`));
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l]`;
		case "update":
			return `${APP_NAME} update [source|self|${APP_NAME}] [--self] [--extensions] [--extension <source>] [--force]`;
		case "list":
			return `${APP_NAME} list`;
	}
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("install")}

Install a package and add it to settings.

Options:
  -l, --local    Install project-locally (${CONFIG_DIR_NAME}/settings.json)

Examples:
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("remove")}

Remove a package and its source from settings.
Alias: ${APP_NAME} uninstall <source> [-l]

Options:
  -l, --local    Remove from project settings (${CONFIG_DIR_NAME}/settings.json)

Examples:
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("update")}

Update ${APP_NAME} and installed packages.

Options:
  --self                  Update ${APP_NAME} only
  --extensions            Update installed packages only
  --extension <source>    Update one package only
  --force                 Reinstall ${APP_NAME} even if the current version is latest

Short forms:
  ${APP_NAME} update                Update ${APP_NAME} and all extensions
  ${APP_NAME} update <source>       Update one package
  ${APP_NAME} update ${APP_NAME}             Update ${APP_NAME} only (self works as an alias)
`);
			return;

		case "list":
			console.log(`${chalk.bold("Usage:")}
  ${getPackageCommandUsage("list")}

List installed packages from user and project settings.
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	if (command === "update") {
		if (extensionFlagSource) {
			if (selfFlag || extensionsFlag) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with --self or --extensions";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			const sourceIsSelf = source === "self" || source === "pi" || source === APP_NAME;
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag) {
					conflictingOptions =
						conflictingOptions ?? "positional update targets cannot be combined with --self or --extensions";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (selfFlag && extensionsFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "all" };
		}
	}

	return {
		command,
		source,
		updateTarget,
		local,
		force,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

function printSelfUpdateUnavailable(
	npmCommand?: string[],
	updateSpec = PACKAGE_NAME,
	updatePackageName = updateSpec,
): void {
	console.error(`error: ${APP_NAME} cannot self-update this installation.`);
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updateSpec, updatePackageName));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(`Location of pi executable: ${entrypoint}`);
	}
}

function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(`If this keeps failing, run this command yourself: ${command.display}`));
}

interface SelfUpdatePlan {
	installSpec: string;
	packageName: string;
	shouldRun: boolean;
}

function setSelfUpdateNoChangeExitCode(): void {
	process.exitCode =
		process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] === "1" ? SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE : undefined;
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	try {
		const latestRelease = await getLatestPiRelease(VERSION);
		const packageName = latestRelease?.packageName ?? PACKAGE_NAME;
		const installSpec = latestRelease?.installSpec ?? packageName;
		const packageRenameRequiresUpdate = !latestRelease?.installSpec && packageName !== PACKAGE_NAME;
		if (
			force ||
			!latestRelease ||
			packageRenameRequiresUpdate ||
			isNewerPackageVersion(latestRelease.version, VERSION)
		) {
			return { installSpec, packageName, shouldRun: true };
		}
	} catch {
		return { installSpec: PACKAGE_NAME, packageName: PACKAGE_NAME, shouldRun: true };
	}

	console.log(chalk.green(`${APP_NAME} is already up to date (v${VERSION})`));
	return { installSpec: PACKAGE_NAME, packageName: PACKAGE_NAME, shouldRun: false };
}

async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(chalk.dim(`Updating ${APP_NAME} with ${command.display}...`));
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			// Windows package managers are commonly .cmd shims. Use the shell so Node can execute them.
			const child = spawn(step.command, step.args, {
				stdio: "inherit",
				shell: shouldUseWindowsShell(step.command),
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

const UPDATE_RESTART_CONTINUATION_PROMPT =
	"Prime Agent restarted after an update. Continue the interrupted task from the saved transcript and restored tool/kernel state. Inspect current state before retrying commands when needed.";

const UPDATE_SESSION_LOSS_COPY: DaemonSessionLossCopy = {
	busyDetail(count) {
		const { noun, pronoun } = pluralizeSessions(count);
		return `The running daemon has ${count} busy ${noun}. After the update installs, Prime Agent will stop ${pronoun}, restart the daemon, and resume interrupted work.`;
	},
	unlistableDetail:
		"A running daemon's sessions could not be listed. After the update installs, Prime Agent will stop resident sessions, restart the daemon, and resume interrupted work where possible.",
	question: "Continue?",
	nonTtyHint: "Re-run with --force to proceed.",
};

// Returns false when the update should be aborted to avoid terminating live sessions.
function confirmDaemonSessionLossBeforeUpdate(probe: RunningDaemonProbe, force: boolean): Promise<boolean> {
	return confirmDaemonSessionLoss(probe, { force, copy: UPDATE_SESSION_LOSS_COPY });
}

function daemonProbeMayHaveBusySessions(probe: RunningDaemonProbe): boolean {
	return probe.reachable && (probe.activeSessions === undefined || probe.activeSessions.some(isSessionBusy));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readOptionalString(value: unknown, fieldName: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readBoolean(value: unknown, fieldName: string): boolean {
	if (typeof value !== "boolean") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readNumber(value: unknown, fieldName: string): number {
	if (typeof value !== "number") {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readOptionalStringRecord(value: unknown, fieldName: string): Record<string, string> | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value) || !Object.values(value).every((entry): entry is string => typeof entry === "string")) {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value as Record<string, string>;
}

function readOptionalImages(value: unknown, fieldName: string): DaemonUpdateRestartQueuedMessage["images"] {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every(isImageContent)) {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function readOptionalMessageContent(value: unknown, fieldName: string): DaemonUpdateRestartQueuedMessage["content"] {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || !value.every(isCustomMessageContentBlock)) {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function isImageContent(value: unknown): value is NonNullable<DaemonUpdateRestartQueuedMessage["images"]>[number] {
	return (
		isRecord(value) && value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string"
	);
}

function isCustomMessageContentBlock(
	value: unknown,
): value is NonNullable<DaemonUpdateRestartQueuedMessage["content"]>[number] {
	return (isRecord(value) && value.type === "text" && typeof value.text === "string") || isImageContent(value);
}

function isCustomMessage(value: unknown): value is CustomMessage {
	return (
		isRecord(value) &&
		value.role === "custom" &&
		typeof value.customType === "string" &&
		(typeof value.content === "string" ||
			(Array.isArray(value.content) && value.content.every(isCustomMessageContentBlock))) &&
		typeof value.display === "boolean" &&
		typeof value.timestamp === "number"
	);
}

function readCustomMessages(value: unknown, fieldName: string): CustomMessage[] {
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value) || !value.every(isCustomMessage)) {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value;
}

function parseDaemonUpdateRestartQueuedMessage(value: unknown): DaemonUpdateRestartQueuedMessage {
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response contains an invalid queued message");
	}
	const message = readString(value.message, "queue.message");
	const content = readOptionalMessageContent(value.content, "queue.content");
	const images = readOptionalImages(value.images, "queue.images");
	const queueKey = readOptionalString(value.queueKey, "queue.queueKey");
	const prefixMessages = readCustomMessages(value.prefixMessages, "queue.prefixMessages");
	const customMessage =
		value.customMessage === undefined
			? undefined
			: isCustomMessage(value.customMessage)
				? value.customMessage
				: undefined;
	if (value.customMessage !== undefined && !customMessage) {
		throw new Error("Daemon update restart response contains an invalid custom queued message");
	}
	const agentMessageId =
		readOptionalString(value.agentMessageId, "queue.agentMessageId") ?? parseAgentSessionMessagePromptId(message);
	return {
		message,
		...(content ? { content } : {}),
		...(images ? { images } : {}),
		...(queueKey ? { queueKey } : {}),
		...(agentMessageId ? { agentMessageId } : {}),
		...(customMessage ? { customMessage } : {}),
		...(prefixMessages.length > 0 ? { prefixMessages } : {}),
	};
}

function parseDaemonUpdateRestartAcceptedPrompt(
	value: unknown,
): NonNullable<DaemonUpdateRestartSession["queue"]["acceptedPrompt"]> {
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response contains an invalid accepted prompt");
	}
	return {
		...parseDaemonUpdateRestartQueuedMessage(value),
		nextTurn: readCustomMessages(value.nextTurn, "queue.acceptedPrompt.nextTurn"),
	};
}

function readOptionalAcceptedPrompt(value: unknown): DaemonUpdateRestartSession["queue"]["acceptedPrompt"] | undefined {
	if (value === undefined) {
		return undefined;
	}
	return parseDaemonUpdateRestartAcceptedPrompt(value);
}

function readQueuedMessages(value: unknown, fieldName: string): DaemonUpdateRestartQueuedMessage[] {
	if (!Array.isArray(value)) {
		throw new Error(`Daemon update restart response is missing ${fieldName}`);
	}
	return value.map(parseDaemonUpdateRestartQueuedMessage);
}

function parseDaemonUpdateRestartRuntimeMetadata(value: unknown): AgentSessionRuntimeMetadata | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response contains invalid runtime metadata");
	}
	const kind = readString(value.kind, "runtimeMetadata.kind");
	if (kind !== "top-level" && kind !== "subagent") {
		throw new Error("Daemon update restart response contains invalid runtime metadata kind");
	}
	const parentActiveSessionId = readOptionalString(
		value.parentActiveSessionId,
		"runtimeMetadata.parentActiveSessionId",
	);
	const parentSessionId = readOptionalString(value.parentSessionId, "runtimeMetadata.parentSessionId");
	const parentSessionFile = readOptionalString(value.parentSessionFile, "runtimeMetadata.parentSessionFile");
	const rlmChildId = readOptionalString(value.rlmChildId, "runtimeMetadata.rlmChildId");
	const rlmParentNodeId = readOptionalString(value.rlmParentNodeId, "runtimeMetadata.rlmParentNodeId");
	const prompt = readOptionalString(value.prompt, "runtimeMetadata.prompt");
	const spawnCode = readOptionalString(value.spawnCode, "runtimeMetadata.spawnCode");
	const sessionDir = readOptionalString(value.sessionDir, "runtimeMetadata.sessionDir");
	return {
		kind,
		createdAt: readNumber(value.createdAt, "runtimeMetadata.createdAt"),
		...(parentActiveSessionId ? { parentActiveSessionId } : {}),
		...(parentSessionId ? { parentSessionId } : {}),
		...(parentSessionFile ? { parentSessionFile } : {}),
		...(rlmChildId ? { rlmChildId } : {}),
		...(rlmParentNodeId ? { rlmParentNodeId } : {}),
		...(prompt ? { prompt } : {}),
		...(spawnCode ? { spawnCode } : {}),
		...(sessionDir ? { sessionDir } : {}),
	};
}

function wasFollowUpQueued(response: { success: true; data?: unknown }): boolean {
	return !isRecord(response.data) || response.data.queued !== false;
}

function parseDaemonUpdateRestartSession(value: unknown): DaemonUpdateRestartSession {
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response contains an invalid session");
	}
	const queue = value.queue;
	if (!isRecord(queue)) {
		throw new Error("Daemon update restart response contains an invalid queue");
	}
	const config = value.config;
	if (!isRecord(config)) {
		throw new Error("Daemon update restart response contains an invalid session config");
	}
	const clientEnv = readOptionalStringRecord(value.clientEnv, "clientEnv");
	const runtimeMetadata = parseDaemonUpdateRestartRuntimeMetadata(value.runtimeMetadata);
	return {
		activeSessionId: readString(value.activeSessionId, "activeSessionId"),
		sessionId: readString(value.sessionId, "sessionId"),
		sessionFile: readString(value.sessionFile, "sessionFile"),
		cwd: readString(value.cwd, "cwd"),
		config: config as DaemonUpdateRestartSession["config"],
		...(runtimeMetadata ? { runtimeMetadata } : {}),
		...(clientEnv ? { clientEnv } : {}),
		queue: {
			steering: readQueuedMessages(queue.steering, "queue.steering"),
			followUp: readQueuedMessages(queue.followUp, "queue.followUp"),
			nextTurn: readCustomMessages(queue.nextTurn, "queue.nextTurn"),
			...(queue.acceptedPrompt !== undefined
				? { acceptedPrompt: readOptionalAcceptedPrompt(queue.acceptedPrompt) }
				: {}),
		},
		shouldResume: readBoolean(value.shouldResume, "shouldResume"),
		wasStreaming: readBoolean(value.wasStreaming, "wasStreaming"),
		wasCompacting: readBoolean(value.wasCompacting, "wasCompacting"),
		wasBashRunning: readBoolean(value.wasBashRunning, "wasBashRunning"),
		hadRunningRlmChildren: readBoolean(value.hadRunningRlmChildren, "hadRunningRlmChildren"),
		wasRetrying: readBoolean(value.wasRetrying, "wasRetrying"),
		hadAcceptedPromptInFlight: readBoolean(value.hadAcceptedPromptInFlight, "hadAcceptedPromptInFlight"),
	};
}

function parseDaemonUpdateRestartManifest(value: unknown): DaemonUpdateRestartManifest {
	if (!isRecord(value)) {
		throw new Error("Daemon update restart response is invalid");
	}
	const sessions = value.sessions;
	if (!Array.isArray(sessions)) {
		throw new Error("Daemon update restart response is missing sessions");
	}
	return {
		createdAt: readString(value.createdAt, "createdAt"),
		sessions: sessions.map(parseDaemonUpdateRestartSession),
	};
}

function clearPreparedDaemonUpdateRestartManifest(agentDir: string): void {
	try {
		rmSync(getDaemonUpdateRestartManifestPath(agentDir), { force: true });
	} catch {
		// Best effort only; the mtime guard below prevents stale fallback use.
	}
}

function readPreparedDaemonUpdateRestartManifest(
	agentDir: string,
	notBeforeMs?: number,
): DaemonUpdateRestartManifest | undefined {
	const manifestPath = getDaemonUpdateRestartManifestPath(agentDir);
	let modifiedAt: number;
	try {
		modifiedAt = statSync(manifestPath).mtimeMs;
	} catch {
		return undefined;
	}
	if (notBeforeMs !== undefined && modifiedAt < notBeforeMs - 1000) {
		return undefined;
	}
	const parsed = JSON.parse(readFileSync(manifestPath, "utf-8")) as unknown;
	return parseDaemonUpdateRestartManifest(parsed);
}

function tryReadPreparedDaemonUpdateRestartManifest(agentDir: string): DaemonUpdateRestartManifest | undefined {
	try {
		return readPreparedDaemonUpdateRestartManifest(agentDir);
	} catch {
		return undefined;
	}
}

function hasRestorableDaemonUpdateRestart(manifest: DaemonUpdateRestartManifest | undefined): boolean {
	return manifest !== undefined && manifest.sessions.length > 0;
}

function responseHasActiveDaemonSessions(data: unknown): boolean {
	if (!isRecord(data) || !Array.isArray(data.sessions)) {
		return true;
	}
	return data.sessions.length > 0;
}

export async function prepareDaemonUpdateRestart(
	socketPath: string,
	agentDir: string,
): Promise<DaemonUpdateRestartManifest> {
	const pendingManifest = tryReadPreparedDaemonUpdateRestartManifest(agentDir);
	const client = new DaemonClient(socketPath);
	let connected = false;
	let startedAt: number | undefined;
	try {
		await client.connect(1000);
		connected = true;
		const hello = await client.waitForHello(2000).catch(() => undefined);
		const useLegacyProtocol = hello !== undefined && hello.protocol.version < DAEMON_PROTOCOL_VERSION;
		if (pendingManifest && pendingManifest.sessions.length > 0) {
			const listResponse = useLegacyProtocol
				? await client.requestLegacy({ type: "list" }, 30000)
				: await client.request({ type: "list" }, 30000);
			if (listResponse.success && !responseHasActiveDaemonSessions(listResponse.data)) {
				return pendingManifest;
			}
		}
		clearPreparedDaemonUpdateRestartManifest(agentDir);
		startedAt = Date.now();
		const response = useLegacyProtocol
			? await client.requestLegacy({ type: "prepare_update_restart" }, 120000)
			: await client.request({ type: "prepare_update_restart" }, 120000);
		if (!response.success) {
			throw new Error(response.error);
		}
		return parseDaemonUpdateRestartManifest(response.data);
	} catch (error) {
		if (startedAt !== undefined) {
			const fallback = readPreparedDaemonUpdateRestartManifest(agentDir, startedAt);
			if (fallback) {
				return fallback;
			}
		}
		if (!connected && pendingManifest && pendingManifest.sessions.length > 0) {
			return pendingManifest;
		}
		throw error;
	} finally {
		client.close();
	}
}

function readCreatedActiveSessionId(value: unknown): string {
	if (!isDaemonSessionSummary(value) || typeof value.activeSessionId !== "string") {
		throw new Error("Daemon returned an invalid session create response");
	}
	return value.activeSessionId;
}

async function restoreNextTurnMessages(
	client: DaemonClient,
	activeSessionId: string,
	sessionFile: string,
	messages: readonly CustomMessage[],
): Promise<boolean> {
	if (messages.length === 0) {
		return true;
	}
	const response = await client.request(
		{ type: "restore_next_turn", activeSessionId, messages: [...messages] },
		30000,
	);
	if (!response.success) {
		console.error(chalk.yellow(`Warning: could not restore pending context for ${sessionFile}: ${response.error}`));
		return false;
	}
	return true;
}

interface RestoreDaemonUpdateRestartSessionResult {
	restored: boolean;
	resumed: boolean;
}

function remapDaemonUpdateRestartRuntimeMetadata(
	session: DaemonUpdateRestartSession,
	restoredActiveSessionIds: ReadonlyMap<string, string>,
): AgentSessionRuntimeMetadata | undefined {
	const metadata = session.runtimeMetadata;
	if (!metadata) {
		return undefined;
	}
	if (metadata.kind !== "subagent") {
		return metadata;
	}
	const { parentActiveSessionId: oldParentActiveSessionId, ...runtimeMetadata } = metadata;
	const parentActiveSessionId = oldParentActiveSessionId
		? restoredActiveSessionIds.get(oldParentActiveSessionId)
		: undefined;
	return {
		...runtimeMetadata,
		...(parentActiveSessionId ? { parentActiveSessionId } : {}),
	};
}

async function restoreDaemonUpdateRestartSession(
	client: DaemonClient,
	session: DaemonUpdateRestartSession,
	restoredActiveSessionIds: Map<string, string>,
): Promise<RestoreDaemonUpdateRestartSessionResult> {
	const runtimeMetadata = remapDaemonUpdateRestartRuntimeMetadata(session, restoredActiveSessionIds);
	const createResponse = await client.request(
		{
			type: "create",
			sessionPath: session.sessionFile,
			config: session.config,
			...(runtimeMetadata ? { runtimeMetadata } : {}),
			...(session.clientEnv ? { env: session.clientEnv } : {}),
		},
		120000,
	);
	if (!createResponse.success) {
		console.error(chalk.yellow(`Warning: could not restore ${session.sessionFile}: ${createResponse.error}`));
		return { restored: false, resumed: false };
	}
	const activeSessionId = readCreatedActiveSessionId(createResponse.data);
	restoredActiveSessionIds.set(session.activeSessionId, activeSessionId);
	const acceptedPrompt = session.queue.acceptedPrompt;
	if (!session.shouldResume) {
		await restoreNextTurnMessages(client, activeSessionId, session.sessionFile, session.queue.nextTurn);
		return { restored: true, resumed: false };
	}
	const needsContinuationPrompt =
		session.wasStreaming ||
		session.wasCompacting ||
		session.wasBashRunning ||
		session.hadRunningRlmChildren ||
		session.wasRetrying ||
		session.hadAcceptedPromptInFlight;
	const steeringQueue = [...session.queue.steering];
	const followUpQueue = [...session.queue.followUp];
	let resumedSession = false;
	let restoredQueuedWork = false;
	if (acceptedPrompt) {
		await restoreNextTurnMessages(client, activeSessionId, session.sessionFile, acceptedPrompt.nextTurn);
	} else {
		await restoreNextTurnMessages(client, activeSessionId, session.sessionFile, session.queue.nextTurn);
	}
	for (const queued of steeringQueue) {
		const response = await client.request(
			{
				type: "steer",
				activeSessionId,
				message: queued.message,
				content: queued.content,
				images: queued.images,
				expandPromptTemplates: false,
				agentMessageId: queued.agentMessageId,
				customMessage: queued.customMessage,
				prefixMessages: queued.prefixMessages,
			},
			30000,
		);
		if (response.success) {
			restoredQueuedWork = true;
		} else {
			console.error(
				chalk.yellow(
					`Warning: could not restore queued steering message for ${session.sessionFile}: ${response.error}`,
				),
			);
		}
	}
	for (const queued of followUpQueue) {
		const response = await client.request(
			{
				type: "follow_up",
				activeSessionId,
				message: queued.message,
				content: queued.content,
				images: queued.images,
				queueKey: queued.queueKey,
				expandPromptTemplates: false,
				agentMessageId: queued.agentMessageId,
				customMessage: queued.customMessage,
				prefixMessages: queued.prefixMessages,
			},
			30000,
		);
		if (response.success && wasFollowUpQueued(response)) {
			restoredQueuedWork = true;
		} else if (!response.success) {
			console.error(
				chalk.yellow(
					`Warning: could not restore queued follow-up message for ${session.sessionFile}: ${response.error}`,
				),
			);
		}
	}
	if (acceptedPrompt) {
		const promptResponse = await client.request(
			{
				type: "prompt",
				activeSessionId,
				message: acceptedPrompt.message,
				content: acceptedPrompt.content,
				images: acceptedPrompt.images,
				expandPromptTemplates: false,
				agentMessageId: acceptedPrompt.agentMessageId,
				customMessage: acceptedPrompt.customMessage,
			},
			120000,
		);
		if (!promptResponse.success) {
			console.error(chalk.yellow(`Warning: could not resume ${session.sessionFile}: ${promptResponse.error}`));
		} else {
			resumedSession = true;
		}
		await restoreNextTurnMessages(client, activeSessionId, session.sessionFile, session.queue.nextTurn);
	} else if (needsContinuationPrompt) {
		const promptResponse = await client.request(
			{
				type: "prompt",
				activeSessionId,
				message: UPDATE_RESTART_CONTINUATION_PROMPT,
				expandPromptTemplates: false,
			},
			120000,
		);
		if (!promptResponse.success) {
			console.error(chalk.yellow(`Warning: could not resume ${session.sessionFile}: ${promptResponse.error}`));
		} else {
			resumedSession = true;
		}
	}
	if (!resumedSession && restoredQueuedWork && !acceptedPrompt) {
		const response = await client.request({ type: "resume_queue", activeSessionId }, 30000);
		if (response.success) {
			resumedSession = true;
		} else {
			console.error(
				chalk.yellow(`Warning: could not resume queued work for ${session.sessionFile}: ${response.error}`),
			);
		}
	}
	return { restored: true, resumed: resumedSession };
}

async function restoreDaemonUpdateRestart(socketPath: string, manifest: DaemonUpdateRestartManifest): Promise<void> {
	if (manifest.sessions.length === 0) {
		return;
	}
	const client = new DaemonClient(socketPath);
	let restored = 0;
	let resumed = 0;
	const restoredActiveSessionIds = new Map<string, string>();
	try {
		await client.connect(10000);
		for (const session of manifest.sessions) {
			try {
				const result = await restoreDaemonUpdateRestartSession(client, session, restoredActiveSessionIds);
				if (result.restored) {
					restored++;
				}
				if (result.resumed) {
					resumed++;
				}
			} catch (error: unknown) {
				console.error(
					chalk.yellow(`Warning: could not restore ${session.sessionFile}: ${formatUnknownError(error)}`),
				);
			}
		}
	} finally {
		client.close();
	}
	console.log(chalk.green(`Restored ${restored} daemon session${restored === 1 ? "" : "s"}`));
	if (resumed > 0) {
		console.log(chalk.green(`Resumed ${resumed} interrupted session${resumed === 1 ? "" : "s"}`));
	}
}

function formatUnknownError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function tryRestoreDaemonUpdateRestart(
	socketPath: string,
	agentDir: string,
	manifest: DaemonUpdateRestartManifest | undefined,
	failureContext: string,
): Promise<boolean> {
	if (!manifest) {
		return false;
	}
	try {
		await restoreDaemonUpdateRestart(socketPath, manifest);
		clearPreparedDaemonUpdateRestartManifest(agentDir);
		return true;
	} catch (error: unknown) {
		console.error(
			chalk.yellow(`Warning: could not restore daemon sessions ${failureContext}: ${formatUnknownError(error)}`),
		);
		return false;
	}
}

async function restartDaemonAfterSelfUpdate(socketPath: string, agentDir: string): Promise<void> {
	const daemonProbe = await probeRunningDaemonSessions(socketPath);
	let manifest: DaemonUpdateRestartManifest | undefined;
	let oldDaemonAlreadyStopped = false;
	if (daemonProbe.reachable) {
		try {
			manifest = await prepareDaemonUpdateRestart(socketPath, agentDir);
		} catch (error: unknown) {
			const message = formatUnknownError(error);
			const daemonLacksPrepareCommand = isUnknownDaemonCommandError(error, "prepare_update_restart");
			if (daemonProbeMayHaveBusySessions(daemonProbe) || !daemonLacksPrepareCommand) {
				console.error(
					chalk.yellow(
						`Warning: updated, but could not prepare daemon sessions for automatic resume (${message}); leaving the running daemon on the previous version.`,
					),
				);
				return;
			}
			console.error(
				chalk.yellow(
					`Warning: the old daemon cannot prepare idle sessions for automatic resume (${message}); restarting the daemon without restored sessions.`,
				),
			);
		}
	} else {
		manifest = tryReadPreparedDaemonUpdateRestartManifest(agentDir);
		oldDaemonAlreadyStopped = hasRestorableDaemonUpdateRestart(manifest);
	}
	if (!daemonProbe.reachable && !hasRestorableDaemonUpdateRestart(manifest)) {
		return;
	}
	const stopped = oldDaemonAlreadyStopped || (await shutdownDaemonAndWait(socketPath));
	if (!stopped) {
		console.error(
			chalk.yellow(`Warning: could not stop the old daemon on ${socketPath}; it will be replaced on next launch.`),
		);
		await tryRestoreDaemonUpdateRestart(socketPath, agentDir, manifest, "after daemon stop failed");
		return;
	}
	try {
		await ensureInteractiveDaemonRunning(socketPath);
	} catch (error: unknown) {
		const message = formatUnknownError(error);
		console.error(
			chalk.yellow(
				`Warning: updated, but could not relaunch the daemon (${message}); it will start on next launch.`,
			),
		);
		await tryRestoreDaemonUpdateRestart(socketPath, agentDir, manifest, "after relaunch failed");
		return;
	}
	if (manifest) {
		await tryRestoreDaemonUpdateRestart(socketPath, agentDir, manifest, "after relaunch");
	}
}

export async function handleConfigCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "config") {
		return false;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "config command");
	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
	const resolvedPaths = await packageManager.resolve();

	await selectConfig({
		resolvedPaths,
		settingsManager,
		cwd,
		agentDir,
	});

	process.exit(0);
}

export async function handlePackageCommand(args: string[]): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(chalk.red(`Unknown option ${options.invalidOption} for "${options.command}".`));
		console.error(chalk.dim(`Use "${APP_NAME} --help" or "${getPackageCommandUsage(options.command)}".`));
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(chalk.red(`Missing value for ${options.missingOptionValue}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(chalk.red(`Unexpected argument ${options.invalidArgument}.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(`Missing ${options.command} source.`));
		console.error(chalk.dim(`Usage: ${getPackageCommandUsage(options.command)}`));
		process.exitCode = 1;
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	reportSettingsErrors(settingsManager, "package command");
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(`Installed ${source}`));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(`No matching package found for ${source}`));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(`Removed ${source}`));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim("No packages installed."));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold("User packages:"));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold("Project packages:"));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "all" };
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(chalk.green(`Updated ${updateSource}`));
					} else {
						console.log(chalk.green("Updated packages"));
					}
				}
				if (updateTargetIncludesSelf(target)) {
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						setSelfUpdateNoChangeExitCode();
						return true;
					}
					const selfUpdateCommand = getSelfUpdateCommand(
						PACKAGE_NAME,
						selfUpdateNpmCommand,
						selfUpdatePlan.installSpec,
						selfUpdatePlan.packageName,
					);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(
							selfUpdateNpmCommand,
							selfUpdatePlan.installSpec,
							selfUpdatePlan.packageName,
						);
						process.exitCode = 1;
						return true;
					}
					// Confirm before the install, since upgrading the daemon afterward stops and resumes busy work.
					const daemonSocketPath = defaultDaemonSocketPath();
					const daemonProbe = await probeRunningDaemonSessions(daemonSocketPath);
					if (!(await confirmDaemonSessionLossBeforeUpdate(daemonProbe, options.force))) {
						if (process.stdin.isTTY) {
							console.log(chalk.dim("Update cancelled."));
						}
						process.exitCode = 1;
						return true;
					}
					try {
						await runSelfUpdate(selfUpdateCommand);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : "Unknown package command error";
						console.error(chalk.red(`Error: ${message}`));
						printSelfUpdateFallback(selfUpdateCommand);
						process.exitCode = 1;
						return true;
					}
					console.log(chalk.green(`Updated ${APP_NAME}`));
					await restartDaemonAfterSelfUpdate(daemonSocketPath, agentDir);
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
}
