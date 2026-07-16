import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { AutocompleteItem, OverlayHandle, SlashCommand } from "@earendil-works/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	clippedFullscreenDockHeight,
	type Focusable,
	fuzzyFilter,
	ProcessTerminal,
	setKeybindings,
	TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { APP_TITLE, appendRotatingLog, getAgentDir, getClientErrorLogPath, VERSION } from "../../config.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import { findExactModelReferenceMatch } from "../../core/model-resolver.js";
import { resolvePrimeInferencePostLoginModelAction } from "../../core/prime-inference-model-selection.js";
import { SessionManager } from "../../core/session-manager.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { DaemonAgentConnection } from "../agent-connection/daemon-agent-connection.js";
import type { AgentConnectionSavedSessionInfo } from "../agent-connection/types.js";
import { DaemonClient, getDaemonSocketCloseReason } from "../daemon/daemon-client.js";
import {
	type DaemonClosingReason,
	type DaemonCommand,
	type DaemonResponse,
	isUnknownDaemonCommandError,
} from "../daemon/daemon-protocol.js";
import {
	resolveAttachModelFallbackMessage,
	type SessionSummary,
	summaryForInactiveSession,
} from "../daemon/daemon-session-list.js";
import {
	type DaemonSavedSessionCatalogContext,
	deleteDaemonSavedSession,
	listDaemonSavedSessions,
	renameDaemonSavedSession,
} from "../daemon/saved-session-catalog.js";
import {
	type AuthenticationResult,
	getAnthropicSubscriptionAuthWarning,
	ProviderAuthFlows,
} from "../interactive/auth-flows.js";
import { showFullPaneOverlay } from "../interactive/components/centered-overlay.js";
import { ConfigurationMenuComponent, type ConfigurationMenuTab } from "../interactive/components/configuration-menu.js";
import { CustomEditor } from "../interactive/components/custom-editor.js";
import { keyText } from "../interactive/components/keybinding-hints.js";
import type { AuthSelectorProvider } from "../interactive/components/oauth-selector.js";
import { SessionPickerScreen } from "../interactive/components/session-picker-screen.js";
import { type SessionListCallbacks, SessionSelectorComponent } from "../interactive/components/session-selector.js";
import { BrandSplashHeader, InteractiveMode } from "../interactive/interactive-mode.js";
import type { InteractiveModeUiServices } from "../interactive/interactive-mode-services.js";
import { ClientPromptStashStore } from "../interactive/prompt-stash-state.js";
import {
	getEditorTheme,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	theme,
} from "../interactive/theme/theme.js";
import { WORKING_ICON_INTERVAL_MS, workingIconFrame } from "../interactive/theme/working-icon.js";
import {
	formatPackageUpdateNotice,
	formatTmuxWarningNotice,
	formatUpdateAvailableNotice,
	gatherStartupNotices,
	type StartupNotices,
} from "../shared/startup-notices.js";
import {
	AGENTS_VIEW_SLASH_COMMANDS,
	type AgentsViewCommandName,
	classifyAgentsViewCommand,
	type ParsedSlashCommand,
	parseSlashCommand,
	resolveAgentsViewCommand,
} from "./agents-view-commands.js";
import {
	type AgentsViewRow,
	type AgentsViewSection,
	type AgentsViewSelectionKey,
	buildAgentsViewRows,
	getAgentsViewSelectionKey,
	getAgentsViewSummaryIdentity as getSummaryIdentity,
	resolveAgentsViewSelectionIndex,
	sectionTitle,
	shouldShowAgentsViewSession,
} from "./agents-view-state.js";

const POLL_INTERVAL_MS = 1000;
const RECONNECT_TIMEOUT_MS = 120000;
const RECONNECT_RETRY_MS = 1000;
const EXIT_HINT_DURATION_MS = 2000;
const DELETE_CONFIRM_DURATION_MS = 2000;
const STATUS_MESSAGE_DURATION_MS = 4500;
const SESSION_NAME_MAX_LENGTH = 80;
const DEFAULT_PROMPT_PLACEHOLDER = "Describe a task for a new session";
const REPLY_PROMPT_FALLBACK_PLACEHOLDER = "Write a reply to this agent";
const COMPLETED_ROW_ICON = "✓";
const NEEDS_INPUT_ROW_ICON = "●";
const SELECTED_ROW_MARKER = "\0agents-view-selected-row\0";
// Tags a spawn-code line so finalize can wrap the whole row in a panel
// background, visually segmenting the program from the agent rows.
const CODE_ROW_MARKER = "\0agents-view-code-row\0";

export interface AgentsViewModeOptions {
	socketPath: string;
	config: AgentSessionRuntimeConfig;
	uiServices: InteractiveModeUiServices;
	createUiServicesForSession?: (summary: SessionSummary) => Promise<InteractiveModeUiServices>;
	migratedProviders?: string[];
	modelFallbackMessage?: string;
	startupModelId?: string;
	initialMessage?: string;
	initialImages?: ImageContent[];
	initialMessages?: string[];
	verbose?: boolean;
	recoverDaemon?: () => Promise<void>;
	reconnectTimeoutMs?: number;
	promptStashStore?: ClientPromptStashStore;
}

type AgentsViewRunResult =
	| { type: "exit" }
	| {
			type: "open";
			summary: SessionSummary;
			subagent?: SessionSummary;
			// Session ids of every ancestor that must be expanded to reveal the
			// opened subagent, from the root agent down to its immediate parent.
			subagentAncestorSessionIds?: string[];
	  };
type AgentsViewPersistentState = {
	selectedRowIdentity?: string;
	selectedSessionKey?: AgentsViewSelectionKey;
	// Ancestor chain to re-expand on return to a subagent. Kept by sessionId, not
	// row identity, so it survives a parent's active→persisted identity flip.
	pendingExpandedAncestorSessionIds?: string[];
	statusMessage?: string;
	initialPromptsSent?: boolean;
	// Gathered once and reused across agents-view instances so the notices survive
	// re-entry and render the moment they resolve, even if the first view was left early.
	startupNotices?: StartupNotices;
	startupNoticesPromise?: Promise<StartupNotices>;
};

type PromptCommand = Extract<DaemonCommand, { type: "prompt" }>;
type PendingDeleteAgent = {
	identity: string;
	activeSessionId?: string;
	sessionFile?: string;
	summary: SessionSummary;
	stopped: boolean;
};
type PendingKillSubagent = {
	identity: string;
	rootActiveSessionId: string;
	childId: string;
};

export async function resolveAgentsViewSessionUiServices(
	options: Pick<AgentsViewModeOptions, "createUiServicesForSession" | "uiServices">,
	summary: SessionSummary,
): Promise<InteractiveModeUiServices> {
	return options.createUiServicesForSession ? await options.createUiServicesForSession(summary) : options.uiServices;
}

// Stripping cwd opens the session in its own stored directory; overrideCwd is
// sent when that directory no longer exists so the daemon doesn't reject it.
export function createAgentsViewResumeConfig(
	config: AgentSessionRuntimeConfig,
	overrideCwd?: string,
): AgentSessionRuntimeConfig {
	const resumeConfig: AgentSessionRuntimeConfig = { ...config };
	if (overrideCwd) {
		resumeConfig.cwd = overrideCwd;
	} else {
		delete resumeConfig.cwd;
	}
	return resumeConfig;
}

export function createAgentsViewListCommand(): Extract<DaemonCommand, { type: "list" }> {
	// Omitting `all` returns daemon-resident sessions only; on-disk ones come back
	// via /resume.
	return { type: "list" };
}

export function resolveAgentsViewResumeSummary(
	sessionPath: string,
	savedSessions: readonly AgentConnectionSavedSessionInfo[],
	visibleSummaries: readonly SessionSummary[],
): SessionSummary | undefined {
	const activeSummary = resolveAgentsViewActiveSummaryForPath(sessionPath, visibleSummaries);
	if (activeSummary) {
		return activeSummary;
	}
	const selectedPath = resolvePath(sessionPath);
	const savedSession = savedSessions.find((session) => resolvePath(session.path) === selectedPath);
	return savedSession ? summaryForInactiveSession(savedSession) : undefined;
}

export function resolveAgentsViewActiveSummaryForPath(
	sessionPath: string,
	summaries: readonly SessionSummary[],
): SessionSummary | undefined {
	const selectedPath = resolvePath(sessionPath);
	return summaries.find(
		(summary) =>
			summary.activeSessionId !== undefined &&
			summary.sessionFile !== undefined &&
			resolvePath(summary.sessionFile) === selectedPath,
	);
}

// Status messages render in a single-row hint slot below the editor; embedded
// newlines would make that row taller than the layout accounts for and overlap
// the input, so flatten all whitespace runs to single spaces.
export function formatAgentsViewStatusLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export async function getAgentsViewModelArgumentCompletions(
	prefix: string,
	modelRegistry: Pick<ModelRegistry, "refreshAvailableModels">,
): Promise<AutocompleteItem[] | null> {
	const models = await modelRegistry.refreshAvailableModels();
	if (models.length === 0) {
		return null;
	}
	const items = models.map((model) => ({
		id: model.id,
		provider: model.provider,
		label: `${model.provider}/${model.id}`,
	}));
	const filtered = fuzzyFilter(items, prefix, (item) => `${item.id} ${item.provider}`);
	if (filtered.length === 0) {
		return null;
	}
	return filtered.map((item) => ({ value: item.label, label: item.id, description: item.provider }));
}

export function shouldReconnectAgentsViewDaemon(reason: DaemonClosingReason | undefined): boolean {
	return reason !== "shutdown";
}

export function createAgentsViewReplyHeadline(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.find((line) => line.length > 0);
}

interface OpenedAgentsViewSession {
	connection: DaemonAgentConnection;
	summary: SessionSummary;
	cwdFallbackNotice?: string;
}

export function resolveAgentsViewOpenCwd(
	summary: SessionSummary,
	fallbackCwd: string | undefined,
): { overrideCwd?: string; notice?: string } {
	if (!summary.cwd || existsSync(summary.cwd) || !fallbackCwd) {
		return {};
	}
	return {
		overrideCwd: fallbackCwd,
		notice: `Original directory is missing (${summary.cwd}); opened in ${fallbackCwd} instead.`,
	};
}

async function openAgentsViewSession(
	options: AgentsViewModeOptions,
	summary: SessionSummary,
): Promise<OpenedAgentsViewSession> {
	let client = await connectAgentsViewDaemonClient(options.socketPath);
	if (summary.activeSessionId) {
		try {
			const connection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
				closeClientOnDispose: true,
				recoverDaemon: options.recoverDaemon,
				reconnectTimeoutMs: options.reconnectTimeoutMs,
			});
			return { connection, summary };
		} catch (error) {
			client.close();
			if (!summary.sessionFile || !isUnknownActiveSessionError(error)) {
				throw error;
			}
			client = await connectAgentsViewDaemonClient(options.socketPath);
		}
	}

	if (!summary.sessionFile) {
		client.close();
		throw new Error("Cannot open agent without an active runtime or saved session file");
	}

	const { overrideCwd, notice } = resolveAgentsViewOpenCwd(summary, options.config.cwd);
	try {
		const response = await client.request({
			type: "create",
			config: createAgentsViewResumeConfig(options.config, overrideCwd),
			sessionPath: summary.sessionFile,
		});
		const createdSummary = expectSessionSummary(requireDaemonData(response));
		const activeSessionId = getRequiredActiveSessionId(createdSummary);
		const connection = await DaemonAgentConnection.attach(client, activeSessionId, {
			closeClientOnDispose: true,
			recoverDaemon: options.recoverDaemon,
			reconnectTimeoutMs: options.reconnectTimeoutMs,
		});
		return { connection, summary: createdSummary, cwdFallbackNotice: notice };
	} catch (error) {
		client.close();
		throw error;
	}
}

async function connectAgentsViewDaemonClient(socketPath: string): Promise<DaemonClient> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect();
		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}

function getRequiredActiveSessionId(summary: SessionSummary): string {
	if (!summary.activeSessionId) {
		throw new Error("Daemon returned a session without an active session id");
	}
	return summary.activeSessionId;
}

function isUnknownActiveSessionError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Unknown active session:");
}

export async function runAgentsViewMode(options: AgentsViewModeOptions): Promise<void> {
	const persistentState: AgentsViewPersistentState = {};
	const promptStashStore = options.promptStashStore ?? new ClientPromptStashStore();

	while (true) {
		const view = new AgentsViewMode(options, persistentState);
		const result = await view.run();
		if (result.type === "exit") {
			return;
		}
		if (result.subagent) {
			// Returning from a subagent reopens the agents view with every ancestor
			// list expanded and that subagent reselected.
			persistentState.selectedRowIdentity = getSummaryIdentity(result.subagent);
			persistentState.selectedSessionKey = getAgentsViewSelectionKey(result.subagent);
			persistentState.pendingExpandedAncestorSessionIds = result.subagentAncestorSessionIds ?? [];
		} else {
			persistentState.selectedRowIdentity = getSummaryIdentity(result.summary);
			persistentState.selectedSessionKey = getAgentsViewSelectionKey(result.summary);
			persistentState.pendingExpandedAncestorSessionIds = undefined;
		}

		let opened: OpenedAgentsViewSession | undefined;
		try {
			opened = await openAgentsViewSession(options, result.summary);
			if (opened.cwdFallbackNotice) {
				persistentState.statusMessage = opened.cwdFallbackNotice;
			}
			const uiServices = await resolveAgentsViewSessionUiServices(options, opened.summary);
			const interactiveMode = new InteractiveMode({
				agentConnection: opened.connection,
				uiServices,
				promptStashStore,
				promptStashSessionId: opened.summary.sessionId,
				bindLocalSessionExtensions: false,
				migratedProviders: options.migratedProviders,
				modelFallbackMessage: resolveAttachModelFallbackMessage(opened.summary, options.modelFallbackMessage),
				startupNotice: opened.cwdFallbackNotice,
				verbose: options.verbose,
				returnToAgentsView: true,
				forceFullscreen: true,
				// The agents view renders the global notices itself, so suppress them in-session.
				agentsViewOwnsStartupNotices: true,
				// Matches the node id scheme used by snapshot child seeding
				// (rlmChildId, falling back to the child's active session id).
				initialSubagentNodeId: result.subagent
					? (result.subagent.rlmChildId ?? result.subagent.activeSessionId)
					: undefined,
			});
			try {
				await interactiveMode.run();
			} catch (error) {
				// The session opened fine and then threw while running; label it as a
				// runtime crash so it isn't mixed in with true open failures.
				logClientError("Agent session crashed", error);
				persistentState.statusMessage = formatError("Agent session crashed", error);
				// Tear down the session TUI exactly as a normal back-navigation would
				// (drain input, stop renderer + theme watcher) so it doesn't fight the
				// agents-view UI for the terminal, then drop the daemon connection.
				await interactiveMode.teardownSessionUi({ preserveAltScreen: true });
				await opened.connection.dispose().catch(() => undefined);
			}
		} catch (error) {
			await opened?.connection.dispose().catch(() => undefined);
			logClientError("Failed to open agent", error);
			persistentState.statusMessage = formatError("Failed to open agent", error);
		}
	}
}

class AgentsViewMode implements Component, Focusable {
	focused = false;

	private readonly ui: TUI;
	private readonly editor: CustomEditor;
	private readonly splash: BrandSplashHeader;
	private readonly fullscreenDock: Component;
	private readonly keybindings: KeybindingsManager;
	private client: DaemonClient | undefined;
	private unsubscribeClientClose: (() => void) | undefined;
	private reconnectPromise: Promise<void> | undefined;
	private reconnectTimedOut = false;
	private daemonShutdownReceived = false;
	private resolveRun: ((result: AgentsViewRunResult) => void) | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private animationTimer: NodeJS.Timeout | undefined;
	private ctrlCExitHintExpiresAt = 0;
	private ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined;
	private deleteConfirmExpiresAt = 0;
	private deleteConfirmTimer: ReturnType<typeof setTimeout> | undefined;
	private workingIconFrame = 0;
	private rows: AgentsViewRow[] = [];
	private lastListedSummaries: SessionSummary[] = [];
	private lastVisibleSummaries: SessionSummary[] = [];
	private expandedSubagentParents = new Set<string>();
	// Agent row identities whose full spawn program is currently shown.
	// The program key toggles each agent shown ↔ hidden.
	private programShownParents = new Set<string>();
	private selectedIndex = 0;
	private selectedRowIdentity: string | undefined;
	private selectedActiveSessionId: string | undefined;
	private selectedSessionKey: AgentsViewSelectionKey | undefined;
	private replyActiveSessionId: string | undefined;
	private replyLastAssistantText: string | undefined;
	private replyLastAssistantTextLoading = false;
	private replyHeaderTime = "";
	private pendingDeleteAgent: PendingDeleteAgent | undefined;
	private pendingKillSubagent: PendingKillSubagent | undefined;
	private renameTarget: { activeSessionId: string; identity: string } | undefined;
	private readonly inactiveAgentIdentities = new Set<string>();
	private fdPath: string | undefined;
	private statusMessage: string | undefined;
	private statusMessageTone: "muted" | "error" | "warning" = "muted";
	private statusMessageSticky = false;
	private statusMessageTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;
	private anthropicSubscriptionWarningShown = false;

	constructor(
		private readonly options: AgentsViewModeOptions,
		private readonly persistentState: AgentsViewPersistentState = {},
	) {
		this.selectedRowIdentity = persistentState.selectedRowIdentity;
		this.selectedSessionKey = persistentState.selectedSessionKey;
		this.selectedActiveSessionId = persistentState.selectedSessionKey?.activeSessionId;
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		setRegisteredThemes(options.uiServices.getThemes());
		initTheme(options.uiServices.settingsManager.getTheme(), true);

		this.ui = new TUI(new ProcessTerminal(), options.uiServices.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(options.uiServices.settingsManager.getClearOnShrink());
		this.ui.terminal.setTitle(`${APP_TITLE} - Agents`);
		this.editor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: options.uiServices.settingsManager.getEditorPaddingX(),
			autocompleteMaxVisible: options.uiServices.settingsManager.getAutocompleteMaxVisible(),
			placeholder: DEFAULT_PROMPT_PLACEHOLDER,
			placeholderColor: (text) => theme.fg("dim", text),
		});
		this.editor.focused = true;
		this.editor.setAutocompleteProvider(this.createAutocompleteProvider());
		this.editor.getHeaderLine = () => this.renderReplyHeaderLine();
		this.editor.onSubmit = (value) => {
			void this.submit(value);
		};
		this.editor.onCtrlD = () => {
			this.finish({ type: "exit" });
		};
		this.editor.onAgentsBack = () => {
			if (this.editor.getText().trim()) {
				return false;
			}
			if (!this.replyActiveSessionId) {
				return false;
			}
			this.setReplyTarget(undefined);
			return true;
		};
		this.fullscreenDock = {
			render: (width) => this.renderDock(width),
			invalidate: () => {
				this.editor.invalidate();
			},
		};
		this.splash = new BrandSplashHeader(
			VERSION,
			() => this.getSplashModelId(),
			() => this.getSplashCwd(),
			undefined,
			{
				topPadding: true,
				getExtraMetadata: () => [{ label: "agents", value: this.getAgentCountsText() }],
			},
		);
	}

	async run(): Promise<AgentsViewRunResult> {
		this.client = new DaemonClient(this.options.socketPath);
		await this.client.connect();
		this.subscribeToClientClose(this.client);
		this.fdPath = await ensureTool("fd");
		this.editor.setAutocompleteProvider(this.createAutocompleteProvider());

		this.ui.addChild(this);
		this.ui.setFocus(this);
		this.ui.start();
		this.ui.enterFullscreen({
			scroll: [this],
			dock: this.fullscreenDock,
			mouse: false,
			viewportControls: false,
		});
		const startupStatusMessage = this.persistentState.statusMessage;
		this.persistentState.statusMessage = undefined;
		if (startupStatusMessage) {
			this.setStatusMessage(startupStatusMessage, { render: false });
		}
		this.ui.requestRender(true);
		onThemeChange(() => {
			this.ui.invalidate();
			this.ui.requestRender();
		});

		await this.refreshSessions();
		this.loadStartupNotices();
		this.pollTimer = setInterval(() => {
			void this.refreshSessions();
		}, POLL_INTERVAL_MS);
		this.pollTimer.unref?.();
		this.animationTimer = setInterval(() => {
			if (!this.rows.some((row) => row.section === "working")) {
				return;
			}
			this.workingIconFrame += 1;
			this.ui.requestRender();
		}, WORKING_ICON_INTERVAL_MS);
		this.animationTimer.unref?.();

		return new Promise((resolve) => {
			this.resolveRun = resolve;
		});
	}

	handleInput(data: string): void {
		this.clearStickyStatusMessage();
		// While renaming, the editor holds the proposed name: Escape cancels, Enter
		// (via onSubmit) confirms, everything else edits the text.
		if (this.renameTarget) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.editor.handleInput(data);
			return;
		}
		if (this.keybindings.matches(data, "app.clear")) {
			this.handleCtrlC();
			return;
		}
		if (this.keybindings.matches(data, "app.agents.rename") && this.editor.getText().length === 0) {
			this.enterRenameMode();
			return;
		}
		if (this.keybindings.matches(data, "app.agents.delete") && this.editor.getText().length === 0) {
			this.clearCtrlCExitHint({ render: false });
			void this.handleDeleteSelected();
			return;
		}
		this.clearCtrlCExitHint({ render: false });
		this.clearDeleteConfirmation({ render: false });
		if (this.keybindings.matches(data, "app.agents.reply") && this.editor.getText().length === 0) {
			void this.toggleReplyTarget();
			return;
		}
		if (this.keybindings.matches(data, "app.agents.program") && this.editor.getText().length === 0) {
			this.cycleProgramForSelected();
			return;
		}
		// Mirror the confirm shortcut: open the selected agent only when the prompt
		// is empty and we are not composing a reply (empty confirm is a no-op then).
		// Match the confirm path's trim() so a whitespace-only prompt still opens.
		if (
			this.keybindings.matches(data, "app.agents.open") &&
			this.editor.getText().trim().length === 0 &&
			!this.replyActiveSessionId
		) {
			this.openSelected();
			return;
		}
		if (this.editor.getText().length === 0 && this.handleListNavigation(data)) {
			return;
		}
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = this.contentHeight(safeWidth);
		const lines = this.renderContent(safeWidth, height).slice(0, height);
		while (lines.length < height) {
			lines.push("");
		}
		return lines.slice(0, height).map((line) => this.finalizeRenderedLine(line, safeWidth));
	}

	invalidate(): void {
		this.editor.invalidate();
		this.splash.invalidate();
	}

	private renderContent(width: number, height: number): string[] {
		if (height <= 0) {
			return [];
		}
		const lines: string[] = [];
		lines.push(...this.splash.render(width));
		const noticeLines = this.renderStartupNotices(width);
		if (noticeLines.length > 0) {
			lines.push("", ...noticeLines);
		}
		lines.push("");
		const listRows = Math.max(0, height - lines.length);
		lines.push(...this.renderSessionRows(width, listRows));
		return lines;
	}

	private loadStartupNotices(): void {
		// Notices live on persistentState (read directly in renderStartupNotices), so they
		// survive leaving and re-entering the agents view regardless of which instance's
		// gather resolved. Already have them? Nothing to do.
		if (this.persistentState.startupNotices) {
			return;
		}
		// Reuse an in-flight gather from an earlier agents-view instance so re-entry does
		// not re-run the checks or lose a result that resolved meanwhile.
		const promise =
			this.persistentState.startupNoticesPromise ??
			gatherStartupNotices({
				version: VERSION,
				cwd: this.options.uiServices.getInitialCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.options.uiServices.settingsManager,
			});
		this.persistentState.startupNoticesPromise = promise;
		void promise
			.then((notices) => {
				this.persistentState.startupNotices = notices;
				// Best-effort immediate paint; a re-entered instance also picks this up on
				// its next poll tick since render reads persistentState directly.
				this.ui.requestRender();
			})
			.catch(() => {});
	}

	private renderStartupNotices(width: number): string[] {
		const notices = this.persistentState.startupNotices;
		if (!notices) {
			return [];
		}
		const formatted: string[] = [];
		if (notices.newVersion) {
			formatted.push(formatUpdateAvailableNotice(notices.newVersion));
		}
		if (notices.packageUpdates.length > 0) {
			formatted.push(formatPackageUpdateNotice(notices.packageUpdates));
		}
		if (notices.tmuxWarning) {
			formatted.push(formatTmuxWarningNotice(notices.tmuxWarning));
		}
		// Match the splash header's one-column gutter and wrap so long notices
		// (e.g. the tmux fix instructions) stay readable instead of truncating.
		const wrapWidth = Math.max(1, width - 1);
		return formatted.flatMap((line) => wrapTextWithAnsi(line, wrapWidth).map((wrapped) => ` ${wrapped}`));
	}

	private handleListNavigation(data: string): boolean {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-Math.max(1, this.visibleListRows()));
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(Math.max(1, this.visibleListRows()));
			return true;
		}
		return false;
	}

	private handleCtrlC(): void {
		if (this.isCtrlCExitHintVisible()) {
			this.finish({ type: "exit" });
			return;
		}
		this.showCtrlCExitHint();
	}

	private showCtrlCExitHint(): void {
		if (this.ctrlCExitHintTimer) {
			clearTimeout(this.ctrlCExitHintTimer);
		}
		this.ctrlCExitHintExpiresAt = Date.now() + EXIT_HINT_DURATION_MS;
		this.ctrlCExitHintTimer = setTimeout(() => {
			this.ctrlCExitHintTimer = undefined;
			if (!this.isCtrlCExitHintVisible()) {
				this.ctrlCExitHintExpiresAt = 0;
				this.ui.requestRender();
			}
		}, EXIT_HINT_DURATION_MS);
		this.ctrlCExitHintTimer.unref?.();
		this.ui.requestRender();
	}

	private clearCtrlCExitHint(options: { render?: boolean } = {}): void {
		if (!this.ctrlCExitHintTimer && this.ctrlCExitHintExpiresAt === 0) {
			return;
		}
		if (this.ctrlCExitHintTimer) {
			clearTimeout(this.ctrlCExitHintTimer);
			this.ctrlCExitHintTimer = undefined;
		}
		this.ctrlCExitHintExpiresAt = 0;
		if (options.render !== false) {
			this.ui.requestRender();
		}
	}

	private isCtrlCExitHintVisible(): boolean {
		return this.ctrlCExitHintExpiresAt > Date.now();
	}

	private showDeleteConfirmation(): void {
		if (this.deleteConfirmTimer) {
			clearTimeout(this.deleteConfirmTimer);
		}
		this.deleteConfirmExpiresAt = Date.now() + DELETE_CONFIRM_DURATION_MS;
		this.deleteConfirmTimer = setTimeout(() => {
			this.deleteConfirmTimer = undefined;
			if (!this.isDeleteConfirmationVisible()) {
				this.deleteConfirmExpiresAt = 0;
				this.ui.requestRender();
			}
		}, DELETE_CONFIRM_DURATION_MS);
		this.deleteConfirmTimer.unref?.();
		this.ui.requestRender();
	}

	private clearDeleteConfirmation(options: { render?: boolean } = {}): void {
		this.pendingKillSubagent = undefined;
		if (!this.deleteConfirmTimer && this.deleteConfirmExpiresAt === 0) {
			return;
		}
		if (this.deleteConfirmTimer) {
			clearTimeout(this.deleteConfirmTimer);
			this.deleteConfirmTimer = undefined;
		}
		this.deleteConfirmExpiresAt = 0;
		if (options.render !== false) {
			this.ui.requestRender();
		}
	}

	private isDeleteConfirmationVisible(): boolean {
		return this.deleteConfirmExpiresAt > Date.now();
	}

	private setStatusMessage(
		message: string | undefined,
		options: { render?: boolean; tone?: "muted" | "error" | "warning"; sticky?: boolean } = {},
	): void {
		const statusLine = message === undefined ? undefined : formatAgentsViewStatusLine(message);
		if (this.statusMessageTimer) {
			clearTimeout(this.statusMessageTimer);
			this.statusMessageTimer = undefined;
		}
		this.statusMessage = statusLine;
		// Errors come both from explicit tones and from formatError-style messages.
		this.statusMessageTone = options.tone ?? (statusLine?.startsWith("Failed") ? "error" : "muted");
		// Sticky messages stay up until the next keypress instead of a timer.
		this.statusMessageSticky = options.sticky === true && statusLine !== undefined;
		if (statusLine && !this.statusMessageSticky) {
			this.statusMessageTimer = setTimeout(() => {
				this.statusMessageTimer = undefined;
				if (this.statusMessage === statusLine) {
					this.statusMessage = undefined;
					this.ui.requestRender();
				}
			}, STATUS_MESSAGE_DURATION_MS);
			this.statusMessageTimer.unref?.();
		}
		if (options.render !== false) {
			this.ui.requestRender();
		}
	}

	/** Sticky messages (e.g. billing warnings) stay until the user acknowledges them with any keypress. */
	private clearStickyStatusMessage(): void {
		if (!this.statusMessageSticky || this.daemonShutdownReceived || this.reconnectPromise) {
			return;
		}
		this.statusMessageSticky = false;
		this.statusMessage = undefined;
		this.ui.requestRender();
	}

	private moveSelection(delta: number): void {
		const selectableIndexes = this.getSelectableRowIndexes();
		if (selectableIndexes.length === 0) {
			return;
		}
		const currentPosition = selectableIndexes.includes(this.selectedIndex)
			? selectableIndexes.indexOf(this.selectedIndex)
			: 0;
		const nextPosition = Math.max(0, Math.min(selectableIndexes.length - 1, currentPosition + delta));
		this.selectedIndex = selectableIndexes[nextPosition] ?? 0;
		this.collapseSubagentListsOutsideSelection();
		this.syncSelectedRowState();
		this.clearDeleteConfirmation({ render: false });
		// Reply stays armed only while the selection sits on the agent row it
		// targets; nested rows share the parent's session id but are read-only.
		const selectedRow = this.rows[this.selectedIndex];
		if (
			this.replyActiveSessionId &&
			(selectedRow?.kind !== "agent" || this.replyActiveSessionId !== this.selectedActiveSessionId)
		) {
			this.setReplyTarget(undefined);
		}
		this.ui.requestRender();
	}

	// Resolve the persisted sessionId breadcrumb to live row identities once, so
	// the rest of the expansion lifecycle stays uniformly identity-keyed.
	private applyPendingAncestorExpansion(): void {
		const sessionIds = this.persistentState.pendingExpandedAncestorSessionIds;
		if (!sessionIds || sessionIds.length === 0) {
			this.persistentState.pendingExpandedAncestorSessionIds = undefined;
			return;
		}
		this.persistentState.pendingExpandedAncestorSessionIds = undefined;
		const wanted = new Set(sessionIds);
		// A nested ancestor's row only appears once its own parent is expanded, so
		// expand-and-rebuild until a pass reveals nothing new.
		let added = true;
		while (added) {
			added = false;
			for (const row of this.rows) {
				if (wanted.has(row.summary.sessionId) && !this.expandedSubagentParents.has(row.identity)) {
					this.expandedSubagentParents.add(row.identity);
					added = true;
				}
			}
			if (added) {
				this.rebuildRows();
			}
		}
	}

	/** Expanded subagent lists collapse back to their summary row once selection leaves them. */
	private collapseSubagentListsOutsideSelection(): void {
		if (this.expandedSubagentParents.size === 0) {
			return;
		}
		const keep = new Set<string>();
		const selectedRow = this.rows[this.selectedIndex];
		// Selecting the expanded agent itself still counts as inside its list;
		// only moving past the block (above the parent or below the last child)
		// collapses it.
		if (selectedRow && this.expandedSubagentParents.has(selectedRow.identity)) {
			keep.add(selectedRow.identity);
		}
		let parentIdentity = selectedRow?.parentIdentity;
		while (parentIdentity !== undefined && !keep.has(parentIdentity)) {
			keep.add(parentIdentity);
			const target: string = parentIdentity;
			parentIdentity = this.rows.find((row) => row.identity === target)?.parentIdentity;
		}
		const next = new Set([...this.expandedSubagentParents].filter((identity) => keep.has(identity)));
		if (next.size === this.expandedSubagentParents.size) {
			return;
		}
		this.expandedSubagentParents = next;
		// A collapsed agent's revealed program collapses with it, so reopening
		// starts from the hidden state rather than a stale reveal.
		for (const identity of [...this.programShownParents]) {
			if (!next.has(identity)) {
				this.programShownParents.delete(identity);
			}
		}
		this.rebuildRows();
	}

	/** Rebuild rows from the last fetched summaries, keeping selection on the same row. */
	private rebuildRows(): void {
		const selectedIdentity = this.rows[this.selectedIndex]?.identity;
		this.rows = buildAgentsViewRows(
			this.lastVisibleSummaries,
			this.expandedSubagentParents,
			this.programShownParents,
		);
		const index =
			selectedIdentity === undefined ? -1 : this.rows.findIndex((row) => row.identity === selectedIdentity);
		if (index >= 0) {
			this.selectedIndex = index;
		} else {
			this.restoreSelection();
		}
	}

	private async submit(value: string): Promise<void> {
		if (this.renameTarget) {
			await this.confirmRename(value);
			return;
		}
		const text = value.trim();
		if (!text) {
			if (this.replyActiveSessionId) {
				return;
			}
			this.openSelected();
			return;
		}

		// Only built-in interactive commands are intercepted here; unknown "/..."
		// text still reaches the daemon session, which expands prompt templates,
		// skills, and extension commands.
		const command = parseSlashCommand(text);
		if (command) {
			const kind = classifyAgentsViewCommand(command.name);
			if (kind === "agents-view") {
				this.editor.setText("");
				await this.runSlashCommand(resolveAgentsViewCommand(command));
				return;
			}
			if (kind === "session-only") {
				this.editor.setText("");
				const resolvedCommand = resolveAgentsViewCommand(command);
				const commandLabel =
					resolvedCommand.name === command.name
						? `/${command.name}`
						: `/${command.name} maps to /${resolvedCommand.name}, which`;
				this.setStatusMessage(
					`${commandLabel} is only available inside an agent session — press ${keyText("tui.select.confirm")} on an agent to open it`,
				);
				return;
			}
		}

		this.editor.setText("");
		if (this.replyActiveSessionId) {
			await this.sendReply(this.replyActiveSessionId, text);
			return;
		}
		const created = await this.createAgentForPrompt(text);
		if (created) {
			this.finish({ type: "open", summary: created.summary });
		}
	}

	private async runSlashCommand(command: ParsedSlashCommand): Promise<void> {
		switch (command.name as AgentsViewCommandName) {
			case "login":
				await this.showConfigurationMenu("providers");
				return;
			case "logout":
				await this.createAuthFlows().runLogout();
				return;
			case "mcp":
				if (command.args) {
					this.setStatusMessage("MCP subcommands are only available inside an agent session.");
					return;
				}
				await this.showConfigurationMenu("mcp-connections");
				return;
			case "model": {
				const searchTerm = command.args || undefined;
				if (searchTerm) {
					// Mirror the in-session /model behavior: an exact provider/id or
					// unique model id reference applies directly without the picker.
					const match = findExactModelReferenceMatch(
						searchTerm,
						await this.options.uiServices.modelRegistry.refreshAvailableModels(),
					);
					if (match) {
						this.applyDefaultModel(match);
						return;
					}
				}
				await this.showConfigurationMenu("models", searchTerm);
				return;
			}
			case "resume":
				await this.showSessionSelector();
				return;
			case "quit":
				this.finish({ type: "exit" });
				return;
			default: {
				const _exhaustive: never = command.name as never;
				return _exhaustive;
			}
		}
	}

	private createAuthFlows(): ProviderAuthFlows {
		const modelRegistry = this.options.uiServices.modelRegistry;
		return new ProviderAuthFlows({
			ui: this.ui,
			modelRegistry,
			showStatus: (message) => this.setStatusMessage(message),
			showError: (message) => this.setStatusMessage(message, { tone: "error" }),
			getAvailableModels: () => modelRegistry.refreshAvailableModels(),
			onLoginCompleted: () => {
				void this.maybeWarnAboutAnthropicSubscriptionAuth(this.getDefaultModelForNewAgents());
			},
		});
	}

	private async applyPrimeInferenceFallbackAfterLogin(authResult: AuthenticationResult): Promise<void> {
		const currentModel = this.getDefaultModelForNewAgents();
		const action = resolvePrimeInferencePostLoginModelAction(
			authResult,
			currentModel,
			this.options.uiServices.modelRegistry,
		);
		if (!action.openModelPicker) {
			return;
		}

		if (action.fallbackModel) {
			this.applyDefaultModel(action.fallbackModel);
			await this.options.uiServices.settingsManager.flush();
		} else if (!currentModel) {
			this.setStatusMessage("Prime Inference login succeeded, but the default GLM 5.2 model is unavailable.", {
				tone: "error",
			});
		}
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(model: Model<Api> | undefined): Promise<void> {
		if (this.options.uiServices.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		const warning = await getAnthropicSubscriptionAuthWarning(this.options.uiServices.modelRegistry, model);
		if (!warning) {
			return;
		}
		this.anthropicSubscriptionWarningShown = true;
		this.setStatusMessage(warning, { tone: "warning", sticky: true });
	}

	private async showConfigurationMenu(initialTab: ConfigurationMenuTab, initialModelSearch?: string): Promise<void> {
		const modelRegistry = this.options.uiServices.modelRegistry;
		const authFlows = this.createAuthFlows();
		const availableModels = await modelRegistry.refreshAvailableModels();
		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			let settled = false;
			let hidden = false;
			let menu: ConfigurationMenuComponent;
			const hide = () => {
				if (hidden) return;
				hidden = true;
				handle?.hide();
				this.ui.requestRender();
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				hide();
				resolve();
			};
			const restore = () => {
				if (settled) return;
				hidden = false;
				handle?.setHidden(false);
				handle?.focus();
				this.ui.requestRender();
			};
			const authenticate = (provider: AuthSelectorProvider, tab: "providers" | "mcp-connections") => {
				if (settled) return;
				handle?.setHidden(true);
				void authFlows
					.loginProvider(provider)
					.then(async (authResult) => {
						if (settled) return;
						restore();
						menu.refreshAuthentication();
						if (authResult.status !== "success" || tab === "mcp-connections") return;

						await this.applyPrimeInferenceFallbackAfterLogin(authResult);
						menu.updateModels(this.getDefaultModelForNewAgents(), await modelRegistry.refreshAvailableModels());
						menu.setActiveTab("models");
					})
					.catch((error) => {
						restore();
						this.setStatusMessage(error instanceof Error ? error.message : String(error), { tone: "error" });
					});
			};

			menu = new ConfigurationMenuComponent({
				initialTab,
				tui: this.ui,
				authStorage: modelRegistry.authStorage,
				providerOptions: authFlows.getLoginProviderOptions(),
				modelRegistry,
				currentModel: this.getDefaultModelForNewAgents(),
				scopedModels: [],
				availableModels,
				recentModels: this.options.uiServices.settingsManager.getRecentModels(),
				initialModelSearch,
				getRows: () => this.ui.terminal.rows,
				requestRender: () => this.ui.requestRender(),
				onSelectProvider: (provider) => authenticate(provider, "providers"),
				onSelectMcpConnection: (provider) => authenticate(provider, "mcp-connections"),
				onSelectModel: (model) => {
					this.applyDefaultModel(model);
					finish();
				},
				onCancel: finish,
			});
			handle = showFullPaneOverlay(this.ui, menu, 96);
		});
	}

	private showSessionSelector(): Promise<void> {
		return new Promise((done) => {
			let handle: OverlayHandle | undefined;
			let settled = false;
			const savedSessionsByPath = new Map<string, AgentConnectionSavedSessionInfo>();

			const rememberSessions = <T extends AgentConnectionSavedSessionInfo[]>(sessions: T): T => {
				for (const session of sessions) {
					savedSessionsByPath.set(resolvePath(session.path), session);
				}
				return sessions;
			};
			const listSavedSessions = async (
				scope: "current" | "all",
				callbacks?: SessionListCallbacks,
			): Promise<AgentConnectionSavedSessionInfo[]> => {
				const sessions = await listDaemonSavedSessions(
					this.requireClient(),
					this.getSavedSessionCatalogContext(),
					scope,
					{
						onProgress: callbacks?.onProgress,
						onSession: (session) => {
							rememberSessions([session]);
							callbacks?.onSession?.(session);
						},
					},
				);
				return rememberSessions(sessions);
			};

			const close = () => {
				if (settled) {
					return;
				}
				settled = true;
				handle?.hide();
				this.ui.requestRender();
				done();
			};

			const selector = new SessionSelectorComponent(
				(callbacks) => listSavedSessions("current", callbacks),
				(callbacks) => listSavedSessions("all", callbacks),
				(sessionPath) => {
					const summary = resolveAgentsViewResumeSummary(
						sessionPath,
						[...savedSessionsByPath.values()],
						this.lastListedSummaries,
					);
					close();
					if (!summary) {
						this.setStatusMessage("Failed to resume session: selected session was not found");
						return;
					}
					this.finish({ type: "open", summary });
				},
				close,
				() => {
					close();
					this.finish({ type: "exit" });
				},
				() => this.ui.requestRender(),
				{
					renameSession: async (sessionPath, nextName) => {
						const name = (nextName ?? "").trim();
						if (!name) {
							return;
						}
						await this.renameSavedSessionFromSelector(sessionPath, name);
					},
					deleteSession: (sessionPath) => this.deleteSavedSessionFromSelector(sessionPath),
					showRenameHint: true,
					keybindings: this.keybindings,
					frameless: true,
				},
			);
			const splash = new BrandSplashHeader(
				VERSION,
				() => this.getSplashModelId(),
				() => this.getSavedSessionCwd(),
			);
			handle = showFullPaneOverlay(this.ui, new SessionPickerScreen(this.ui, splash, selector), {
				fullWidth: true,
			});
		});
	}

	private getSavedSessionCwd(): string {
		return this.options.config.cwd ?? this.options.uiServices.getInitialCwd();
	}

	private getSavedSessionCatalogContext(): DaemonSavedSessionCatalogContext {
		return { cwd: this.getSavedSessionCwd(), sessionDir: this.options.config.sessionDir };
	}

	private async renameSavedSessionFromSelector(sessionPath: string, name: string): Promise<void> {
		await renameDaemonSavedSession(this.requireClient(), this.getSavedSessionCatalogContext(), sessionPath, name);
		await this.refreshSessions();
	}

	private async deleteSavedSessionFromSelector(sessionPath: string) {
		return deleteDaemonSavedSession(this.requireClient(), this.getSavedSessionCatalogContext(), sessionPath);
	}

	private getDefaultModelForNewAgents(): Model<Api> | undefined {
		const settings = this.options.uiServices.settingsManager;
		const provider = settings.getDefaultProvider();
		const modelId = settings.getDefaultModel();
		return provider && modelId ? this.options.uiServices.modelRegistry.find(provider, modelId) : undefined;
	}

	private applyDefaultModel(model: Model<Api>): void {
		this.options.uiServices.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		// New agents are created from this shared config; pin the model explicitly
		// so the daemon does not fall back to its own settings snapshot.
		this.options.config.provider = model.provider;
		this.options.config.model = model.id;
		this.options.startupModelId = model.id;
		this.setStatusMessage(`Model for new agents: ${model.id}`);
		void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
	}

	private createAutocompleteProvider(): CombinedAutocompleteProvider {
		const cwd = resolveAgentsViewAutocompleteCwd(
			this.options.uiServices.getInitialCwd(),
			this.replyActiveSessionId ? this.findSummaryByActiveSessionId(this.replyActiveSessionId) : undefined,
		);
		return createAgentsViewAutocompleteProvider(cwd, this.fdPath, (prefix) =>
			getAgentsViewModelArgumentCompletions(prefix, this.options.uiServices.modelRegistry),
		);
	}

	private openSelected(): void {
		const row = this.rows[this.selectedIndex];
		if (!row?.selectable || this.isPendingDeleteRow(row)) {
			return;
		}
		if (row.kind === "subagent-summary") {
			this.expandSubagentList(row);
			return;
		}
		if (row.kind === "subagent") {
			this.openSelectedSubagent(row);
			return;
		}
		if (!row.summary.activeSessionId && !row.summary.sessionFile) {
			this.setStatusMessage("Cannot open agent without an active runtime or saved session file");
			return;
		}
		this.finish({ type: "open", summary: row.summary });
	}

	private expandSubagentList(row: AgentsViewRow): void {
		if (!row.parentIdentity) {
			return;
		}
		this.expandedSubagentParents.add(row.parentIdentity);
		this.rebuildRows();
		const firstChild = this.rows.findIndex(
			(candidate) => candidate.kind === "subagent" && candidate.parentIdentity === row.parentIdentity,
		);
		if (firstChild >= 0) {
			this.selectedIndex = firstChild;
		}
		this.syncSelectedRowState();
		this.ui.requestRender();
	}

	/**
	 * Toggle the full spawn program for the agent owning the selected row:
	 * one press shows it, another hides it. The subagent list is expanded as
	 * needed so the code sits directly above the subagents it launched.
	 */
	private cycleProgramForSelected(): void {
		const row = this.rows[this.selectedIndex];
		if (!row) {
			return;
		}
		const target = row.kind === "agent" ? row.identity : row.parentIdentity;
		if (!target) {
			return;
		}
		if (!this.targetHasSpawnCode(target)) {
			this.setStatusMessage("No program recorded for these subagents");
			return;
		}
		// Code only renders inside an expanded subagent list, so reveal it too.
		this.expandedSubagentParents.add(target);
		if (this.programShownParents.has(target)) {
			this.programShownParents.delete(target);
		} else {
			this.programShownParents.add(target);
		}
		const prevIdentity = row.identity;
		this.rebuildRows();
		// The collapsed summary row vanishes once expanded; keep a sane selection.
		if (this.rows[this.selectedIndex]?.identity !== prevIdentity) {
			const agentIndex = this.rows.findIndex((candidate) => candidate.identity === target);
			if (agentIndex >= 0) {
				this.selectedIndex = agentIndex;
			}
		}
		this.syncSelectedRowState();
		this.ui.requestRender();
	}

	/** Whether any subagent under the given agent identity carries spawn code. */
	private targetHasSpawnCode(target: string): boolean {
		for (const row of this.rows) {
			if (row.parentIdentity !== target) {
				continue;
			}
			if (row.kind === "subagent-summary") {
				return row.hasSpawnCode === true;
			}
			if (row.kind === "subagent" && rowHasSpawnCode(row)) {
				return true;
			}
		}
		return false;
	}

	/** True when the selected row exposes the "show program" affordance. */
	private selectedRowCanShowProgram(): boolean {
		const row = this.rows[this.selectedIndex];
		if (!row) {
			return false;
		}
		const target = row.kind === "agent" ? row.identity : row.parentIdentity;
		return target !== undefined && this.targetHasSpawnCode(target);
	}

	private openSelectedSubagent(row: AgentsViewRow): void {
		const root = this.findSubagentRootRow(row);
		if (!root || !(root.summary.activeSessionId || root.summary.sessionFile)) {
			this.setStatusMessage("Cannot open subagent without its parent agent");
			return;
		}
		this.finish({
			type: "open",
			summary: root.summary,
			subagent: row.summary,
			subagentAncestorSessionIds: this.collectSubagentAncestorSessionIds(row),
		});
	}

	/** Session ids of every ancestor of a subagent row, root-most first. */
	private collectSubagentAncestorSessionIds(row: AgentsViewRow): string[] {
		const ancestors: string[] = [];
		let parentIdentity = row.parentIdentity;
		while (parentIdentity !== undefined) {
			const parent = this.rows.find((candidate) => candidate.identity === parentIdentity);
			if (!parent) {
				break;
			}
			ancestors.unshift(parent.summary.sessionId);
			parentIdentity = parent.parentIdentity;
		}
		return ancestors;
	}

	/**
	 * The whole subagent tree belongs to the root agent's session, so nested
	 * subagents also resolve to their top-level ancestor.
	 */
	private findSubagentRootRow(row: AgentsViewRow): AgentsViewRow | undefined {
		let root = this.rows.find((candidate) => candidate.identity === row.parentIdentity);
		while (root && root.kind !== "agent") {
			const parentIdentity = root.parentIdentity;
			root = this.rows.find((candidate) => candidate.identity === parentIdentity);
		}
		return root;
	}

	private async toggleReplyTarget(): Promise<void> {
		const selectedRow = this.rows[this.selectedIndex];
		// Subagents are read-only; replying is reserved for top-level agents.
		if (selectedRow?.kind !== "agent") {
			return;
		}
		const activeSessionId = selectedRow.summary.activeSessionId;
		if (!activeSessionId) {
			return;
		}
		if (this.pendingDeleteAgent?.identity === getSelectedRowIdentity(selectedRow)) {
			return;
		}
		if (this.replyActiveSessionId === activeSessionId) {
			this.setReplyTarget(undefined);
			return;
		}
		this.setReplyTarget(activeSessionId);
		this.replyLastAssistantTextLoading = true;
		try {
			const latestAssistantText = await this.getLastAssistantText(activeSessionId);
			if (this.replyActiveSessionId === activeSessionId) {
				this.replyLastAssistantText = latestAssistantText;
				this.replyLastAssistantTextLoading = false;
				this.ui.requestRender();
			}
		} catch (error) {
			if (this.replyActiveSessionId === activeSessionId) {
				this.replyLastAssistantTextLoading = false;
				this.setStatusMessage(formatError("Failed to load latest response", error));
			}
		}
	}

	private setReplyTarget(activeSessionId: string | undefined): void {
		this.replyActiveSessionId = activeSessionId;
		this.replyLastAssistantText = undefined;
		this.replyLastAssistantTextLoading = false;
		// Captured once on entry so the header does not count up while reply mode stays open.
		this.replyHeaderTime = activeSessionId ? this.getReplyHeaderTime(activeSessionId) : "";
		this.editor.setPlaceholder(activeSessionId ? REPLY_PROMPT_FALLBACK_PLACEHOLDER : DEFAULT_PROMPT_PLACEHOLDER);
		this.editor.setAutocompleteProvider(this.createAutocompleteProvider());
		this.ui.requestRender();
	}

	private enterRenameMode(): void {
		const row = this.rows[this.selectedIndex];
		// Only top-level agents carry a renameable session; subagents do not.
		if (row?.kind !== "agent" || !row.selectable) {
			return;
		}
		const activeSessionId = row.summary.activeSessionId;
		if (!activeSessionId) {
			this.setStatusMessage("This agent has no active session to rename");
			return;
		}
		this.setReplyTarget(undefined);
		this.pendingDeleteAgent = undefined;
		this.pendingKillSubagent = undefined;
		this.renameTarget = { activeSessionId, identity: getSummaryIdentity(row.summary) };
		this.editor.setPlaceholder("Name this agent session");
		this.editor.setText(row.summary.sessionName ?? "");
		this.ui.requestRender();
	}

	private exitRenameMode(): void {
		this.renameTarget = undefined;
		this.editor.setText("");
		this.editor.setPlaceholder(DEFAULT_PROMPT_PLACEHOLDER);
		this.ui.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const target = this.renameTarget;
		if (!target) {
			return;
		}
		const name = value.trim();
		if (!name) {
			this.exitRenameMode();
			return;
		}
		this.exitRenameMode();
		this.setStatusMessage("Renaming agent...");
		try {
			await this.requireClient().request({
				type: "rename",
				activeSessionId: target.activeSessionId,
				name,
			});
			this.setStatusMessage(`Renamed to ${name}`, { render: false });
			await this.refreshSessions();
		} catch (error) {
			this.setStatusMessage(
				isUnknownDaemonCommandError(error, "rename")
					? "Failed to rename: the daemon is running an older build; restart the daemon and try again"
					: formatError("Failed to rename agent", error),
			);
		}
	}

	private getReplyHeaderTime(activeSessionId: string): string {
		const summary = this.findSummaryByActiveSessionId(activeSessionId);
		return formatAgentsViewRelativeTime(summary?.modified ?? summary?.created);
	}

	private findSummaryByActiveSessionId(activeSessionId: string): SessionSummary | undefined {
		return this.rows.find((row) => (row.summary.activeSessionId ?? row.summary.id) === activeSessionId)?.summary;
	}

	private renderReplyHeaderLine(): string | undefined {
		if (this.renameTarget) {
			return theme.fg("warning", "Rename agent session");
		}
		if (!this.replyActiveSessionId) {
			return undefined;
		}
		const headline =
			createAgentsViewReplyHeadline(this.replyLastAssistantText) ??
			theme.fg("dim", this.replyLastAssistantTextLoading ? "Loading last response..." : "No response yet");
		return this.replyHeaderTime ? `${theme.fg("warning", this.replyHeaderTime)} ${headline}` : headline;
	}

	private async getLastAssistantText(activeSessionId: string): Promise<string | undefined> {
		const response = await this.requireClient().request({
			type: "get_last_assistant_text",
			activeSessionId,
		});
		const data = requireDaemonData(response);
		if (!isRecord(data)) {
			throw new Error("Daemon returned an invalid last assistant response");
		}
		if (data.text === null || data.text === undefined) {
			return undefined;
		}
		if (typeof data.text !== "string") {
			throw new Error("Daemon returned an invalid last assistant response");
		}
		return data.text;
	}

	private async sendReply(activeSessionId: string, text: string): Promise<void> {
		const behavior = this.findSummaryByActiveSessionId(activeSessionId)?.isStreaming ? "followUp" : undefined;
		this.setStatusMessage("Sending reply...");
		try {
			await this.sendPrompt(activeSessionId, text, undefined, behavior);
			this.setStatusMessage("Reply sent");
			this.setReplyTarget(undefined);
			await this.refreshSessions();
		} catch (error) {
			this.setStatusMessage(formatError("Failed to send reply", error));
		}
	}

	private async handleDeleteSelected(): Promise<void> {
		const row = this.rows[this.selectedIndex];
		if (!row?.selectable) {
			return;
		}
		if (row.kind === "subagent") {
			this.pendingDeleteAgent = undefined;
			await this.handleKillSubagentSelected(row);
			return;
		}
		if (row.kind !== "agent") {
			return;
		}
		this.pendingKillSubagent = undefined;
		const identity = getSummaryIdentity(row.summary);
		if (this.pendingDeleteAgent?.identity === identity) {
			if (this.isDeleteConfirmationVisible()) {
				await this.deactivatePendingAgent();
				return;
			}
			this.showDeleteConfirmation();
			return;
		}
		await this.stopAgentForDeletion(row);
	}

	// Subagent rows only stay visible while the daemon hosts their session, and
	// the daemon releases a child session as soon as its run settles, so any
	// visible subagent is part of an active run regardless of its idle/streaming
	// status. A kill that races completion reports "already finished".
	private async handleKillSubagentSelected(row: AgentsViewRow): Promise<void> {
		const identity = getSummaryIdentity(row.summary);
		if (this.pendingKillSubagent?.identity === identity && this.isDeleteConfirmationVisible()) {
			const pending = this.pendingKillSubagent;
			this.clearDeleteConfirmation({ render: false });
			await this.killSubagent(pending);
			return;
		}
		const childId = row.summary.rlmChildId;
		const rootActiveSessionId = this.findSubagentRootRow(row)?.summary.activeSessionId;
		if (!childId || !rootActiveSessionId) {
			this.setStatusMessage("Cannot stop subagent without its parent agent");
			return;
		}
		this.pendingKillSubagent = { identity, rootActiveSessionId, childId };
		this.showDeleteConfirmation();
	}

	private async killSubagent(pending: PendingKillSubagent): Promise<void> {
		this.setStatusMessage("Stopping subagent...");
		try {
			const response = await this.requireClient().request({
				type: "cancel_rlm_child",
				activeSessionId: pending.rootActiveSessionId,
				childId: pending.childId,
			});
			const data = requireDaemonData(response);
			const cancelled = isRecord(data) && data.cancelled === true;
			this.setStatusMessage(cancelled ? "Subagent stopped" : "Subagent already finished", { render: false });
			await this.refreshSessions();
		} catch (error) {
			this.setStatusMessage(
				isUnknownDaemonCommandError(error, "cancel_rlm_child")
					? "Failed to stop subagent: the daemon is running an older build; restart the daemon and try again"
					: formatError("Failed to stop subagent", error),
			);
		}
	}

	private async stopAgentForDeletion(row: AgentsViewRow): Promise<void> {
		const identity = getSummaryIdentity(row.summary);
		const activeSessionId = row.summary.activeSessionId;
		if (!activeSessionId) {
			this.pendingDeleteAgent = {
				identity,
				sessionFile: row.summary.sessionFile,
				summary: row.summary,
				stopped: false,
			};
			this.setStatusMessage(undefined, { render: false });
			this.setReplyTarget(undefined);
			this.showDeleteConfirmation();
			return;
		}
		if (!isRunningSessionSummary(row.summary)) {
			this.pendingDeleteAgent = {
				identity,
				activeSessionId,
				sessionFile: row.summary.sessionFile,
				summary: row.summary,
				stopped: false,
			};
			this.setStatusMessage(undefined, { render: false });
			this.setReplyTarget(undefined);
			this.showDeleteConfirmation();
			return;
		}
		this.setStatusMessage("Stopping agent...");
		try {
			const response = await this.requireClient().request({
				type: "kill",
				activeSessionId,
			});
			requireDaemonData(response);
			this.pendingDeleteAgent = {
				identity,
				activeSessionId,
				sessionFile: row.summary.sessionFile,
				summary: row.summary,
				stopped: true,
			};
			this.selectedActiveSessionId = activeSessionId;
			this.setReplyTarget(undefined);
			this.setStatusMessage(undefined, { render: false });
			this.showDeleteConfirmation();
			await this.refreshSessions();
		} catch (error) {
			this.setStatusMessage(formatError("Failed to stop agent", error));
		}
	}

	private async deactivatePendingAgent(): Promise<void> {
		const pending = this.pendingDeleteAgent;
		if (!pending) {
			return;
		}
		this.setStatusMessage("Deactivating agent...");
		try {
			if (pending.activeSessionId) {
				try {
					const killResponse = await this.requireClient().request({
						type: "kill",
						activeSessionId: pending.activeSessionId,
					});
					requireDaemonData(killResponse);
				} catch (error) {
					if (!isUnknownActiveSessionError(error)) {
						throw error;
					}
				}
			}
			// Skip a file deleted between listing and now: SessionManager.open would
			// recreate a stub at the old path instead of loading it.
			if (pending.sessionFile && existsSync(pending.sessionFile)) {
				// Persist archived unless it already is: sessions with no prior
				// session_state entry would otherwise resurface on the next scan.
				const sessionManager = SessionManager.open(pending.sessionFile, this.options.config.sessionDir);
				if (sessionManager.getSessionState()?.status !== "archived") {
					sessionManager.appendSessionState({ status: "archived" });
				}
			}
			this.inactiveAgentIdentities.add(pending.identity);
			this.pendingDeleteAgent = undefined;
			this.clearDeleteConfirmation({ render: false });
			this.selectedActiveSessionId = undefined;
			this.setStatusMessage("Agent inactive", { render: false });
			await this.refreshSessions();
		} catch (error) {
			this.setStatusMessage(formatError("Failed to deactivate agent", error));
		}
	}

	private async createAgentForPrompt(
		text: string,
		images?: ImageContent[],
	): Promise<{ summary: SessionSummary; activeSessionId: string } | undefined> {
		const client = this.requireClient();
		this.setStatusMessage("Creating agent...");
		try {
			const response = await client.request({
				type: "create",
				config: this.options.config,
				name: createAgentsViewSessionName(text),
			});
			const summary = expectSessionSummary(requireDaemonData(response));
			const activeSessionId = summary.activeSessionId ?? summary.id;
			await this.sendPrompt(activeSessionId, text, images);
			this.setStatusMessage("Agent started");
			await this.refreshSessions();
			this.selectedRowIdentity = getSummaryIdentity(summary);
			this.selectedActiveSessionId = activeSessionId;
			this.selectedSessionKey = getAgentsViewSelectionKey(summary);
			this.persistentState.selectedRowIdentity = this.selectedRowIdentity;
			this.persistentState.selectedSessionKey = this.selectedSessionKey;
			this.restoreSelection();
			return { summary, activeSessionId };
		} catch (error) {
			this.setStatusMessage(formatError("Failed to create agent", error));
			return undefined;
		}
	}

	private async sendPrompt(
		activeSessionId: string,
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
	): Promise<void> {
		const command: PromptCommand = {
			type: "prompt",
			activeSessionId,
			message,
		};
		if (images && images.length > 0) {
			command.images = images;
		}
		if (streamingBehavior) {
			command.streamingBehavior = streamingBehavior;
		}
		const response = await this.requireClient().request(command);
		requireDaemonData(response);
	}

	private async sendInitialPrompts(): Promise<void> {
		if (this.persistentState.initialPromptsSent) {
			return;
		}
		this.persistentState.initialPromptsSent = true;
		const initialMessages = this.options.initialMessages ?? [];
		const firstMessage = this.options.initialMessage ?? initialMessages[0];
		if (!firstMessage) {
			return;
		}
		const remainingMessages = this.options.initialMessage ? initialMessages : initialMessages.slice(1);
		const created = await this.createAgentForPrompt(firstMessage, this.options.initialImages);
		if (!created) {
			return;
		}
		const { activeSessionId } = created;
		for (const message of remainingMessages) {
			try {
				await this.sendPrompt(activeSessionId, message, undefined, "followUp");
			} catch (error) {
				this.setStatusMessage(formatError("Failed to send startup prompt", error));
				break;
			}
		}
		await this.refreshSessions();
	}

	private async refreshSessions(): Promise<void> {
		if (this.reconnectPromise || this.daemonShutdownReceived) {
			return;
		}
		const client = this.requireClient();
		try {
			const response = await client.request(createAgentsViewListCommand());
			const data = requireDaemonData(response);
			this.applySessionList(expectSessionList(data));
			await this.sendInitialPrompts();
		} catch (error) {
			if (!this.reconnectPromise) {
				if (client.isConnected) {
					this.setStatusMessage(formatError("Failed to refresh agents", error));
				} else {
					this.startClientReconnect(client, error);
				}
			}
		}
	}

	private applySessionList(sessions: SessionSummary[]): void {
		this.lastListedSummaries = sessions;
		const visibleSessions = sessions.filter((summary) =>
			shouldShowAgentsViewSession(summary, this.inactiveAgentIdentities.has(getSummaryIdentity(summary))),
		);
		this.lastVisibleSummaries = this.withPendingDeleteSession(visibleSessions);
		this.rows = buildAgentsViewRows(
			this.lastVisibleSummaries,
			this.expandedSubagentParents,
			this.programShownParents,
		);
		this.applyPendingAncestorExpansion();
		this.restoreSelection();
		this.ui.requestRender();
	}

	private withPendingDeleteSession(sessions: readonly SessionSummary[]): SessionSummary[] {
		const pending = this.pendingDeleteAgent;
		if (!pending) {
			return [...sessions];
		}
		if (!this.isDeleteConfirmationVisible()) {
			return [...sessions];
		}
		let replaced = false;
		const merged = sessions.map((summary) => {
			if (getSummaryIdentity(summary) !== pending.identity) {
				return summary;
			}
			replaced = true;
			return pending.summary;
		});
		return replaced ? merged : [...merged, pending.summary];
	}

	private restoreSelection(): void {
		if (this.rows.length === 0) {
			this.selectedIndex = 0;
			this.selectedActiveSessionId = undefined;
			return;
		}
		const index = this.findSelectedRowIndex();
		if (index >= 0) {
			this.selectedIndex = index;
		} else if (!this.rows[this.selectedIndex]?.selectable) {
			this.selectedIndex = this.getSelectableRowIndexes()[0] ?? 0;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, this.rows.length - 1);
		}
		this.syncSelectedRowState();
	}

	private findSelectedRowIndex(): number {
		const identity = this.selectedRowIdentity ?? this.persistentState.selectedRowIdentity;
		const key = this.selectedSessionKey ?? this.persistentState.selectedSessionKey;
		return resolveAgentsViewSelectionIndex(this.rows, identity, key);
	}

	private getSelectableRowIndexes(): number[] {
		return this.rows.flatMap((row, index) => (row.selectable ? [index] : []));
	}

	private syncSelectedRowState(): void {
		const row = this.rows[this.selectedIndex];
		this.selectedActiveSessionId = row?.selectable ? (row.summary.activeSessionId ?? row.summary.id) : undefined;
		this.selectedRowIdentity = getSelectedRowIdentity(row);
		this.selectedSessionKey = row?.selectable ? getAgentsViewSelectionKey(row.summary) : undefined;
		this.persistentState.selectedRowIdentity = this.selectedRowIdentity;
		this.persistentState.selectedSessionKey = this.selectedSessionKey;
	}

	private finish(result: AgentsViewRunResult): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		this.clearCtrlCExitHint({ render: false });
		this.clearDeleteConfirmation({ render: false });
		this.setStatusMessage(undefined, { render: false });
		this.ui.stop({
			preserveAltScreen: result.type === "open",
			flushFullscreen: false,
		});
		stopThemeWatcher();
		this.unsubscribeClientClose?.();
		this.unsubscribeClientClose = undefined;
		this.client?.close();
		this.client = undefined;
		this.resolveRun?.(result);
		this.resolveRun = undefined;
	}

	private subscribeToClientClose(client: DaemonClient): void {
		this.unsubscribeClientClose?.();
		this.unsubscribeClientClose = client.onClose((error) => {
			if (!shouldReconnectAgentsViewDaemon(getDaemonSocketCloseReason(error))) {
				this.handleDaemonShutdown(client, error);
				return;
			}
			this.startClientReconnect(client, error);
		});
	}

	private handleDaemonShutdown(client: DaemonClient, error: Error): void {
		if (this.stopped || client !== this.client) {
			return;
		}
		this.daemonShutdownReceived = true;
		this.reconnectTimedOut = false;
		this.setStatusMessage(`Prime Agent daemon shut down. Restart Prime Agent to reconnect. ${error.message}`, {
			tone: "error",
			sticky: true,
		});
		this.applySessionList([]);
	}

	private startClientReconnect(client: DaemonClient, error: unknown): void {
		if (this.stopped || client !== this.client || this.reconnectPromise || this.daemonShutdownReceived) {
			return;
		}
		if (!this.reconnectTimedOut) {
			this.setStatusMessage("Daemon connection lost; reconnecting…", { tone: "warning", sticky: true });
		}
		const reconnectPromise = this.reconnectClient(client, error).finally(() => {
			if (this.reconnectPromise === reconnectPromise) {
				this.reconnectPromise = undefined;
			}
		});
		this.reconnectPromise = reconnectPromise;
	}

	private async reconnectClient(client: DaemonClient, initialError: unknown): Promise<void> {
		const deadline = Date.now() + (this.options.reconnectTimeoutMs ?? RECONNECT_TIMEOUT_MS);
		let lastError = initialError;
		while (!this.stopped && !this.daemonShutdownReceived && client === this.client && Date.now() < deadline) {
			try {
				await this.options.recoverDaemon?.();
				await client.reconnect(1000);
				const response = await client.request(createAgentsViewListCommand());
				const data = requireDaemonData(response);
				const sessions = expectSessionList(data);
				this.daemonShutdownReceived = false;
				this.reconnectTimedOut = false;
				this.setStatusMessage("Daemon reconnected", { render: false });
				this.applySessionList(sessions);
				await this.sendInitialPrompts();
				return;
			} catch (error) {
				lastError = error;
			}
			await new Promise<void>((resolve) => {
				const retryTimer = setTimeout(resolve, RECONNECT_RETRY_MS);
				retryTimer.unref?.();
			});
		}
		if (!this.stopped && !this.daemonShutdownReceived && client === this.client) {
			this.reconnectTimedOut = true;
			this.setStatusMessage(formatError("Daemon unavailable; retrying", lastError), {
				tone: "error",
				sticky: true,
				render: false,
			});
			this.applySessionList([]);
		}
	}

	private requireClient(): DaemonClient {
		if (!this.client) {
			throw new Error("Agents view daemon client is not connected");
		}
		return this.client;
	}

	private getAgentCountsText(): string {
		const counts = countRowsBySection(this.rows);
		const parts: string[] = [];
		if (counts["needs-input"] > 0) {
			parts.push(`${counts["needs-input"]} needs input`);
		}
		parts.push(`${counts.working} working`, `${counts.completed} completed`);
		return parts.join(", ");
	}

	private renderSessionRows(width: number, maxRows: number): string[] {
		if (maxRows <= 0) {
			return [];
		}
		if (this.rows.length === 0) {
			return [
				theme.bold(sectionTitle("working")),
				theme.fg("dim", "  No agents yet. Describe a task below to start one."),
			].slice(0, maxRows);
		}

		const displayItems = buildDisplayItems(this.rows);
		const selectedIdentity = this.rows[this.selectedIndex]?.identity;
		const selectedDisplayIndex = displayItems.findIndex(
			(item) => item.type === "row" && item.row.identity === selectedIdentity,
		);
		const visibleRows = Math.min(maxRows, this.visibleListRows());
		const start = Math.max(
			0,
			Math.min(displayItems.length - visibleRows, selectedDisplayIndex - Math.floor(visibleRows / 2)),
		);
		const showLeadingEllipsis = start > 0;
		let showTrailingEllipsis = start + visibleRows < displayItems.length;
		if ((showLeadingEllipsis ? 1 : 0) + (showTrailingEllipsis ? 1 : 0) >= visibleRows) {
			showTrailingEllipsis = false;
		}
		const contentVisibleRows = Math.max(
			0,
			visibleRows - (showLeadingEllipsis ? 1 : 0) - (showTrailingEllipsis ? 1 : 0),
		);
		const visibleItems = displayItems.slice(start, start + contentVisibleRows);
		const lines = visibleItems.map((item) => {
			if (item.type === "spacer") {
				return "";
			}
			if (item.type === "heading") {
				return theme.bold(sectionTitle(item.section));
			}
			if (item.type === "empty") {
				return theme.fg("dim", "  No agents");
			}
			return this.renderRow(item.row, width);
		});
		if (showLeadingEllipsis) {
			lines.unshift(theme.fg("dim", "  ..."));
		}
		if (showTrailingEllipsis) {
			lines.push(theme.fg("dim", "  ..."));
		}
		return lines;
	}

	private renderRow(row: AgentsViewRow, width: number): string {
		const selected = row.selectable && row.identity === this.rows[this.selectedIndex]?.identity;
		if (row.kind === "subagent-code") {
			return this.renderCodeRow(row);
		}
		if (row.kind === "subagent-summary") {
			const indent = "  ".repeat(row.depth);
			const hint = row.hasSpawnCode ? theme.fg("dim", ` · ${keyText("app.agents.program")} show program`) : "";
			const label = `${theme.fg("dim", `▸ ${row.title}`)}${hint}`;
			const line = padLine(truncateToWidth(`${indent}${label}`, width, ""), width);
			return selected ? `${SELECTED_ROW_MARKER}${line}` : line;
		}
		const pendingDelete = row.kind === "agent" && this.isPendingDeleteRow(row);
		const pendingKill = row.kind === "subagent" && this.isPendingKillSubagentRow(row);
		const rawIcon = this.getRowIcon(row.section);
		const icon = this.formatRowIcon(row.section, rawIcon);
		const indent = "  ".repeat(row.depth);
		const timeWidth = 10;
		const titleWidth = Math.max(0, width - visibleWidth(indent) - visibleWidth(rawIcon) - timeWidth - 2);
		const title = pendingDelete
			? this.getPendingDeleteTitle()
			: pendingKill
				? `${keyText("app.agents.delete")} again to stop`
				: row.title;
		// Append the background summary as a dim suffix on the same line, e.g.
		// "fix auth · Refactoring token validation". Hidden during delete/stop
		// confirmations so the warning text stands alone.
		const summaryText = !pendingDelete && !pendingKill ? row.summary.summary : undefined;
		const titleContent = summaryText ? `${title} ${theme.fg("dim", `· ${summaryText}`)}` : title;
		const titleCell = formatTableCell(titleContent, titleWidth);
		const cells = [
			icon,
			pendingDelete || pendingKill ? theme.fg("error", titleCell) : titleCell,
			formatRightTableCell(formatSessionDuration(row.summary), timeWidth),
		];
		const base = `${indent}${cells[0]} ${cells[1]} ${cells[2]}`;
		const line = padLine(truncateToWidth(base, width, ""), width);
		return selected ? `${SELECTED_ROW_MARKER}${line}` : line;
	}

	// Spawn-code rows are read-only context. They render deemphasized — muted
	// text on a panel background (applied in finalizeRenderedLine) so the program
	// reads as one quiet segmented block rather than competing with agent rows.
	private renderCodeRow(row: AgentsViewRow): string {
		const indent = "  ".repeat(row.depth);
		const body = theme.fg("muted", row.code || " ");
		return `${CODE_ROW_MARKER}${indent}  ${body}`;
	}

	private finalizeRenderedLine(line: string, width: number): string {
		const code = line.startsWith(CODE_ROW_MARKER);
		const selected = !code && line.startsWith(SELECTED_ROW_MARKER);
		let content = code
			? line.slice(CODE_ROW_MARKER.length)
			: selected
				? line.slice(SELECTED_ROW_MARKER.length)
				: line;
		// Each rendered line must occupy exactly one terminal row; a stray
		// newline would shift every line below it and overlap the editor.
		if (content.includes("\n") || content.includes("\r")) {
			content = content.replace(/[\r\n]+/g, " ");
		}
		const padded = padLine(truncateToWidth(content, width), width);
		if (code) {
			return theme.bg("toolPanelBg", padded);
		}
		return selected ? theme.bg("selectedBg", padded) : padded;
	}

	private isPendingDeleteRow(row: AgentsViewRow): boolean {
		return (
			getSummaryIdentity(row.summary) === this.pendingDeleteAgent?.identity && this.isDeleteConfirmationVisible()
		);
	}

	private isPendingKillSubagentRow(row: AgentsViewRow): boolean {
		return (
			getSummaryIdentity(row.summary) === this.pendingKillSubagent?.identity && this.isDeleteConfirmationVisible()
		);
	}

	private getPendingDeleteTitle(): string {
		const deleteKey = keyText("app.agents.delete");
		return this.pendingDeleteAgent?.stopped
			? `stopped - ${deleteKey} again to remove`
			: `${deleteKey} again to remove`;
	}

	private renderPrompt(width: number): string[] {
		return this.editor.render(width);
	}

	private renderDock(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return [...this.renderPrompt(safeWidth), this.renderHints(safeWidth)].map((line) =>
			this.finalizeRenderedLine(line, safeWidth),
		);
	}

	private renderHints(width: number): string {
		if (this.isCtrlCExitHintVisible()) {
			const clearKey = keyText("app.clear");
			const hint = clearKey ? `Press ${clearKey} again to exit` : "Press again to exit";
			return truncateToWidth(theme.fg("muted", hint), width);
		}
		if (this.statusMessage) {
			return truncateToWidth(theme.fg(this.statusMessageTone, this.statusMessage), width);
		}
		if (this.renameTarget) {
			const hint = `${keyText("tui.select.confirm")} save   ${keyText("tui.select.cancel")} cancel`;
			return truncateToWidth(theme.fg("muted", hint), width);
		}
		// Replying is reserved for top-level agents; subagents can be stopped.
		const selectedRow = this.rows[this.selectedIndex];
		const selectedAgent = selectedRow?.kind === "agent";
		const selectedSubagent = selectedRow?.kind === "subagent";
		const hints = [
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} move`,
			`${keyText("tui.select.confirm")} open/send`,
			`${keyText("app.agents.open")} open`,
			"/ commands",
			selectedAgent ? `${keyText("app.agents.reply")} reply` : undefined,
			selectedAgent ? `${keyText("app.agents.rename")} rename` : undefined,
			selectedAgent ? `${keyText("app.agents.delete")} stop/deactivate` : undefined,
			selectedSubagent ? `${keyText("app.agents.delete")} stop` : undefined,
			this.selectedRowCanShowProgram() ? `${keyText("app.agents.program")} program` : undefined,
			this.replyActiveSessionId ? `${keyText("app.agents.back")} back` : undefined,
		]
			.filter((hint): hint is string => hint !== undefined)
			.join("   ");
		return truncateToWidth(theme.fg("muted", hints), width);
	}

	private visibleListRows(): number {
		return Math.max(4, this.ui.terminal.rows - 9);
	}

	private contentHeight(width: number): number {
		const rows = this.ui.terminal.rows;
		const dockHeight = clippedFullscreenDockHeight(this.renderDock(width).length, rows);
		return Math.max(0, rows - dockHeight);
	}

	private getSplashModelId(): string | undefined {
		return this.rows[this.selectedIndex]?.summary.model?.id ?? this.options.startupModelId;
	}

	private getSplashCwd(): string {
		return this.rows[this.selectedIndex]?.summary.cwd ?? this.options.uiServices.getInitialCwd();
	}

	private getRowIcon(section: AgentsViewSection): string {
		switch (section) {
			case "working":
				return workingIconFrame(this.workingIconFrame);
			case "needs-input":
				return NEEDS_INPUT_ROW_ICON;
			case "completed":
				return COMPLETED_ROW_ICON;
			default: {
				const _exhaustive: never = section;
				return _exhaustive;
			}
		}
	}

	private formatRowIcon(section: AgentsViewSection, icon: string): string {
		switch (section) {
			case "working":
				return theme.bold(icon);
			case "needs-input":
				return theme.fg("warning", icon);
			case "completed":
				return theme.fg("success", icon);
			default: {
				const _exhaustive: never = section;
				return _exhaustive;
			}
		}
	}
}

type DisplayItem =
	| { type: "spacer" }
	| { type: "heading"; section: AgentsViewSection }
	| { type: "empty"; section: AgentsViewSection }
	| { type: "row"; row: AgentsViewRow };

function buildDisplayItems(rows: readonly AgentsViewRow[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	const sections: AgentsViewSection[] = ["needs-input", "working", "completed"];
	for (const [index, section] of sections.entries()) {
		if (index > 0) {
			items.push({ type: "spacer" });
		}
		items.push({ type: "heading", section });
		const sectionRows = getDisplayRowsForSection(rows, section);
		if (sectionRows.length === 0) {
			items.push({ type: "empty", section });
			continue;
		}
		for (const row of sectionRows) {
			items.push({ type: "row", row });
		}
	}
	return items;
}

// Nested rows (subagent summaries and expanded subagents) always render in
// their top-level agent's section block, regardless of their own section.
function getDisplayRowsForSection(rows: readonly AgentsViewRow[], section: AgentsViewSection): AgentsViewRow[] {
	const result: AgentsViewRow[] = [];
	let include = false;
	for (const row of rows) {
		if (row.depth === 0) {
			include = row.section === section;
		}
		if (include) {
			result.push(row);
		}
	}
	return result;
}

function countRowsBySection(rows: readonly AgentsViewRow[]): Record<AgentsViewSection, number> {
	const agents = rows.filter((row) => row.kind === "agent");
	return {
		working: agents.filter((row) => row.section === "working").length,
		"needs-input": agents.filter((row) => row.section === "needs-input").length,
		completed: agents.filter((row) => row.section === "completed").length,
	};
}

function getSelectedRowIdentity(row: AgentsViewRow | undefined): string | undefined {
	return row?.identity;
}

function rowHasSpawnCode(row: AgentsViewRow): boolean {
	const code = row.summary.spawnCode;
	return typeof code === "string" && code.trim().length > 0;
}

function isRunningSessionSummary(summary: SessionSummary): boolean {
	return summary.activity === "working";
}

export function resolveAgentsViewAutocompleteCwd(initialCwd: string, replyTarget?: SessionSummary): string {
	const replyCwd = replyTarget?.cwd;
	return replyCwd && existsSync(replyCwd) ? replyCwd : initialCwd;
}

export function createAgentsViewAutocompleteProvider(
	cwd: string,
	fdPath: string | undefined,
	getModelArgumentCompletions: NonNullable<SlashCommand["getArgumentCompletions"]>,
): CombinedAutocompleteProvider {
	const commands: SlashCommand[] = AGENTS_VIEW_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
		...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
	}));
	const modelCommand = commands.find((command) => command.name === "model");
	if (modelCommand) {
		modelCommand.getArgumentCompletions = getModelArgumentCompletions;
	}
	return new CombinedAutocompleteProvider(commands, cwd, fdPath ?? null);
}

export function createAgentsViewSessionName(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > SESSION_NAME_MAX_LENGTH
		? `${normalized.slice(0, SESSION_NAME_MAX_LENGTH - 3)}...`
		: normalized;
}

function formatTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function formatRightTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

function formatSessionDuration(summary: SessionSummary): string {
	return formatAgentsViewRelativeTime(summary.created ?? summary.modified);
}

export function formatAgentsViewRelativeTime(value: string | undefined, now: number = Date.now()): string {
	const timestamp = parseSessionTimestamp(value);
	if (!timestamp) {
		return "";
	}
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function parseSessionTimestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function requireDaemonData(response: DaemonResponse): unknown {
	if (!response.success) {
		throw new Error(response.error);
	}
	return response.data;
}

function expectSessionList(value: unknown): SessionSummary[] {
	if (!isRecord(value) || !Array.isArray(value.sessions)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	if (!value.sessions.every(isSessionSummary)) {
		throw new Error("Daemon returned an invalid session summary");
	}
	return value.sessions;
}

function expectSessionSummary(value: unknown): SessionSummary {
	if (!isSessionSummary(value)) {
		throw new Error("Daemon returned an invalid session summary");
	}
	return value;
}

function isSessionSummary(value: unknown): value is SessionSummary {
	return isRecord(value) && typeof value.id === "string" && typeof value.sessionId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(prefix: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return formatAgentsViewStatusLine(`${prefix}: ${message}`);
}

// The agents view shows open failures as a one-line status only, so a client-side
// crash (e.g. "Maximum call stack size exceeded") leaves no stack to debug from.
// Persist the full stack to a file — the TUI owns stdout/stderr, so a log file is
// the only safe sink.
function logClientError(prefix: string, error: unknown): void {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	appendRotatingLog(getClientErrorLogPath(), `[${new Date().toISOString()}] ${prefix}: ${detail}`);
}

function padLine(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
