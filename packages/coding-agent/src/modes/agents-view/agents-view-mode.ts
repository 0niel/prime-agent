import type { ImageContent } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	ProcessTerminal,
	setKeybindings,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { APP_TITLE, VERSION } from "../../config.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import { SessionManager } from "../../core/session-manager.js";
import { DaemonAgentConnection } from "../agent-connection/daemon-agent-connection.js";
import { DaemonClient } from "../daemon/daemon-client.js";
import type { DaemonCommand, DaemonResponse } from "../daemon/daemon-protocol.js";
import type { SessionSummary } from "../daemon/daemon-session-list.js";
import { CustomEditor } from "../interactive/components/custom-editor.js";
import { keyText } from "../interactive/components/keybinding-hints.js";
import { BrandSplashHeader, InteractiveMode } from "../interactive/interactive-mode.js";
import type { InteractiveModeUiServices } from "../interactive/interactive-mode-services.js";
import {
	getEditorTheme,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	theme,
} from "../interactive/theme/theme.js";
import {
	type AgentsViewRow,
	type AgentsViewSection,
	buildAgentsViewRows,
	sectionTitle,
	shouldShowAgentsViewSession,
} from "./agents-view-state.js";

const POLL_INTERVAL_MS = 1000;
const WORKING_ICON_INTERVAL_MS = 250;
const EXIT_HINT_DURATION_MS = 2000;
const DELETE_CONFIRM_DURATION_MS = 2000;
const STATUS_MESSAGE_DURATION_MS = 4500;
const SESSION_NAME_MAX_LENGTH = 80;
const DEFAULT_PROMPT_PLACEHOLDER = "Describe a task for a new session";
const REPLY_PROMPT_FALLBACK_PLACEHOLDER = "Write a reply to this agent";
const COMPLETED_ROW_ICON = "✓";
const WORKING_ICON_FRAMES = ["◇", "◈", "◆", "◈"] as const;
const SELECTED_ROW_MARKER = "\0agents-view-selected-row\0";

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
}

type AgentsViewRunResult = { type: "exit" } | { type: "open"; summary: SessionSummary };
type AgentsViewPersistentState = {
	selectedRowIdentity?: string;
	statusMessage?: string;
	initialPromptsSent?: boolean;
};

type PromptCommand = Extract<DaemonCommand, { type: "prompt" }>;
type PendingDeleteAgent = {
	identity: string;
	activeSessionId?: string;
	sessionFile?: string;
	summary: SessionSummary;
	stopped: boolean;
};

export async function resolveAgentsViewSessionUiServices(
	options: Pick<AgentsViewModeOptions, "createUiServicesForSession" | "uiServices">,
	summary: SessionSummary,
): Promise<InteractiveModeUiServices> {
	return options.createUiServicesForSession ? await options.createUiServicesForSession(summary) : options.uiServices;
}

export function createAgentsViewResumeConfig(config: AgentSessionRuntimeConfig): AgentSessionRuntimeConfig {
	const resumeConfig: AgentSessionRuntimeConfig = { ...config };
	delete resumeConfig.cwd;
	return resumeConfig;
}

export function createAgentsViewReplyHeadline(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.find((line) => line.length > 0);
}

async function openAgentsViewSession(
	options: AgentsViewModeOptions,
	summary: SessionSummary,
): Promise<{ connection: DaemonAgentConnection; summary: SessionSummary }> {
	let client = await connectAgentsViewDaemonClient(options.socketPath);
	if (summary.activeSessionId) {
		try {
			const connection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
				closeClientOnDispose: true,
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

	try {
		const response = await client.request({
			type: "create",
			config: createAgentsViewResumeConfig(options.config),
			sessionPath: summary.sessionFile,
		});
		const createdSummary = expectSessionSummary(requireDaemonData(response));
		const activeSessionId = getRequiredActiveSessionId(createdSummary);
		const connection = await DaemonAgentConnection.attach(client, activeSessionId, {
			closeClientOnDispose: true,
		});
		return { connection, summary: createdSummary };
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

	while (true) {
		const view = new AgentsViewMode(options, persistentState);
		const result = await view.run();
		if (result.type === "exit") {
			return;
		}
		persistentState.selectedRowIdentity = getSummaryIdentity(result.summary);

		let opened: { connection: DaemonAgentConnection; summary: SessionSummary } | undefined;
		try {
			opened = await openAgentsViewSession(options, result.summary);
			const uiServices = await resolveAgentsViewSessionUiServices(options, opened.summary);
			const interactiveMode = new InteractiveMode({
				agentConnection: opened.connection,
				uiServices,
				bindLocalSessionExtensions: false,
				migratedProviders: options.migratedProviders,
				modelFallbackMessage: opened.summary.modelFallbackMessage ?? options.modelFallbackMessage,
				verbose: options.verbose,
				returnToAgentsView: true,
			});
			await interactiveMode.run();
		} catch (error) {
			await opened?.connection.dispose().catch(() => undefined);
			persistentState.statusMessage = formatError("Failed to open agent", error);
		}
	}
}

class AgentsViewMode implements Component, Focusable {
	focused = false;

	private readonly ui: TUI;
	private readonly editor: CustomEditor;
	private readonly splash: BrandSplashHeader;
	private readonly keybindings: KeybindingsManager;
	private client: DaemonClient | undefined;
	private resolveRun: ((result: AgentsViewRunResult) => void) | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private animationTimer: NodeJS.Timeout | undefined;
	private ctrlCExitHintExpiresAt = 0;
	private ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined;
	private deleteConfirmExpiresAt = 0;
	private deleteConfirmTimer: ReturnType<typeof setTimeout> | undefined;
	private workingIconFrame = 0;
	private rows: AgentsViewRow[] = [];
	private selectedIndex = 0;
	private selectedRowIdentity: string | undefined;
	private selectedActiveSessionId: string | undefined;
	private replyActiveSessionId: string | undefined;
	private replyLastAssistantText: string | undefined;
	private replyLastAssistantTextLoading = false;
	private replyHeaderTime = "";
	private pendingDeleteAgent: PendingDeleteAgent | undefined;
	private readonly inactiveAgentIdentities = new Set<string>();
	private statusMessage: string | undefined;
	private statusMessageTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	constructor(
		private readonly options: AgentsViewModeOptions,
		private readonly persistentState: AgentsViewPersistentState = {},
	) {
		this.selectedRowIdentity = persistentState.selectedRowIdentity;
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
		this.splash = new BrandSplashHeader(
			VERSION,
			() => this.getSplashModelId(),
			() => this.getSplashCwd(),
			undefined,
			{
				getExtraMetadata: () => [{ label: "agents", value: this.getAgentCountsText() }],
			},
		);
	}

	async run(): Promise<AgentsViewRunResult> {
		this.client = new DaemonClient(this.options.socketPath);
		await this.client.connect();

		this.ui.addChild(this);
		this.ui.setFocus(this);
		this.ui.start();
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
		await this.sendInitialPrompts();
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
		if (this.keybindings.matches(data, "app.clear")) {
			this.handleCtrlC();
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
		if (this.editor.getText().length === 0 && this.handleListNavigation(data)) {
			return;
		}
		this.editor.handleInput(data);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.ui.terminal.rows);
		const promptLines = [...this.renderPrompt(safeWidth), this.renderHints(safeWidth)];
		const contentHeight = Math.max(0, height - promptLines.length);
		const lines = this.renderContent(safeWidth, contentHeight).slice(0, contentHeight);
		while (lines.length < contentHeight) {
			lines.push("");
		}
		lines.push(...promptLines.slice(0, Math.max(0, height - lines.length)));
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
		lines.push("");
		const listRows = Math.max(0, height - lines.length);
		lines.push(...this.renderSessionRows(width, listRows));
		return lines;
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

	private setStatusMessage(message: string | undefined, options: { render?: boolean } = {}): void {
		if (this.statusMessageTimer) {
			clearTimeout(this.statusMessageTimer);
			this.statusMessageTimer = undefined;
		}
		this.statusMessage = message;
		if (message) {
			this.statusMessageTimer = setTimeout(() => {
				this.statusMessageTimer = undefined;
				if (this.statusMessage === message) {
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
		this.syncSelectedRowState();
		this.clearDeleteConfirmation({ render: false });
		if (this.replyActiveSessionId && this.replyActiveSessionId !== this.selectedActiveSessionId) {
			this.setReplyTarget(undefined);
		}
		this.ui.requestRender();
	}

	private async submit(value: string): Promise<void> {
		const text = value.trim();
		if (!text) {
			if (this.replyActiveSessionId) {
				return;
			}
			this.openSelected();
			return;
		}

		this.editor.setText("");
		if (this.replyActiveSessionId) {
			await this.sendReply(this.replyActiveSessionId, text);
			return;
		}
		await this.createAgentForPrompt(text);
	}

	private openSelected(): void {
		const row = this.rows[this.selectedIndex];
		if (!row?.selectable || this.isPendingDeleteRow(row)) {
			return;
		}
		if (!row.summary.activeSessionId && !row.summary.sessionFile) {
			this.setStatusMessage("Cannot open agent without an active runtime or saved session file");
			return;
		}
		this.finish({ type: "open", summary: row.summary });
	}

	private async toggleReplyTarget(): Promise<void> {
		const selectedRow = this.rows[this.selectedIndex];
		const activeSessionId = selectedRow?.summary.activeSessionId;
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
		this.ui.requestRender();
	}

	private getReplyHeaderTime(activeSessionId: string): string {
		const summary = this.findSummaryByActiveSessionId(activeSessionId);
		return formatAgentsViewRelativeTime(summary?.modified ?? summary?.created);
	}

	private findSummaryByActiveSessionId(activeSessionId: string): SessionSummary | undefined {
		return this.rows.find((row) => (row.summary.activeSessionId ?? row.summary.id) === activeSessionId)?.summary;
	}

	private renderReplyHeaderLine(): string | undefined {
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
			if (pending.sessionFile) {
				// The kill above normally persists sleep, but it can be skipped or
				// hit an unknown session (e.g. the daemon died after listing). Make
				// sure the file is not left marked active, or a restarted daemon
				// would resurrect a deliberately deactivated agent.
				const sessionManager = SessionManager.open(pending.sessionFile, this.options.config.sessionDir);
				if (sessionManager.getSessionState()?.status === "active") {
					sessionManager.appendSessionState({ status: "sleep" });
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

	private async createAgentForPrompt(text: string, images?: ImageContent[]): Promise<string | undefined> {
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
			this.persistentState.selectedRowIdentity = this.selectedRowIdentity;
			this.restoreSelection();
			return activeSessionId;
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
		const activeSessionId = await this.createAgentForPrompt(firstMessage, this.options.initialImages);
		if (!activeSessionId) {
			return;
		}
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
		const client = this.requireClient();
		try {
			const command: Extract<DaemonCommand, { type: "list" }> = { type: "list", all: true };
			if (this.options.config.sessionDir) {
				command.sessionDir = this.options.config.sessionDir;
			}
			const response = await client.request(command);
			const data = requireDaemonData(response);
			const sessions = expectSessionList(data);
			const visibleSessions = sessions.filter((summary) =>
				shouldShowAgentsViewSession(summary, this.inactiveAgentIdentities.has(getSummaryIdentity(summary))),
			);
			this.rows = buildAgentsViewRows(this.withPendingDeleteSession(visibleSessions));
			this.restoreSelection();
			this.ui.requestRender();
		} catch (error) {
			this.setStatusMessage(formatError("Failed to refresh agents", error));
		}
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
		const selectedIdentity = this.selectedRowIdentity ?? this.persistentState.selectedRowIdentity;
		let index =
			selectedIdentity === undefined
				? -1
				: this.rows.findIndex((row) => row.selectable && getSummaryIdentity(row.summary) === selectedIdentity);
		const selectedId = this.selectedActiveSessionId;
		if (index < 0) {
			index =
				selectedId === undefined
					? -1
					: this.rows.findIndex(
							(row) => row.selectable && (row.summary.activeSessionId ?? row.summary.id) === selectedId,
						);
		}
		if (index >= 0) {
			this.selectedIndex = index;
		} else if (!this.rows[this.selectedIndex]?.selectable) {
			this.selectedIndex = this.getSelectableRowIndexes()[0] ?? 0;
		} else {
			this.selectedIndex = Math.min(this.selectedIndex, this.rows.length - 1);
		}
		this.syncSelectedRowState();
	}

	private getSelectedActiveSessionId(): string | undefined {
		const row = this.rows[this.selectedIndex];
		return row?.selectable ? (row.summary.activeSessionId ?? row.summary.id) : undefined;
	}

	private getSelectableRowIndexes(): number[] {
		return this.rows.flatMap((row, index) => (row.selectable ? [index] : []));
	}

	private syncSelectedRowState(): void {
		const row = this.rows[this.selectedIndex];
		this.selectedActiveSessionId = row?.selectable ? (row.summary.activeSessionId ?? row.summary.id) : undefined;
		this.selectedRowIdentity = getSelectedRowIdentity(row);
		this.persistentState.selectedRowIdentity = this.selectedRowIdentity;
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
		this.ui.stop();
		if (result.type === "open") {
			this.ui.terminal.clearScreen();
		}
		stopThemeWatcher();
		this.client?.close();
		this.client = undefined;
		this.resolveRun?.(result);
		this.resolveRun = undefined;
	}

	private requireClient(): DaemonClient {
		if (!this.client) {
			throw new Error("Agents view daemon client is not connected");
		}
		return this.client;
	}

	private getAgentCountsText(): string {
		const counts = countRowsBySection(this.rows);
		return `${counts.working} working, ${counts.completed} completed`;
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
		const selectedId = this.getSelectedActiveSessionId();
		const selectedDisplayIndex = displayItems.findIndex(
			(item) => item.type === "row" && (item.row.summary.activeSessionId ?? item.row.summary.id) === selectedId,
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
			if (item.type === "subagents") {
				return this.renderSubagentSummary(item.count, width);
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
		const activeSessionId = row.summary.activeSessionId ?? row.summary.id;
		const selected = row.selectable && activeSessionId === this.getSelectedActiveSessionId();
		const pendingDelete = this.isPendingDeleteRow(row);
		const rawIcon = this.getRowIcon(row.section);
		const icon = this.formatRowIcon(row.section, rawIcon);
		const indent = "  ".repeat(row.depth);
		const timeWidth = 10;
		const titleWidth = Math.max(0, width - visibleWidth(indent) - visibleWidth(rawIcon) - timeWidth - 2);
		const title = pendingDelete ? this.getPendingDeleteTitle() : row.title;
		const titleCell = formatTableCell(title, titleWidth);
		const cells = [
			icon,
			pendingDelete ? theme.fg("error", titleCell) : titleCell,
			formatRightTableCell(formatSessionDuration(row.summary), timeWidth),
		];
		const base = `${indent}${cells[0]} ${cells[1]} ${cells[2]}`;
		const line = padLine(truncateToWidth(base, width, ""), width);
		return selected ? `${SELECTED_ROW_MARKER}${line}` : line;
	}

	private renderSubagentSummary(count: number, width: number): string {
		const label = `  ${count} subagents running`;
		return padLine(truncateToWidth(theme.fg("dim", label), width), width);
	}

	private finalizeRenderedLine(line: string, width: number): string {
		const selected = line.startsWith(SELECTED_ROW_MARKER);
		const content = selected ? line.slice(SELECTED_ROW_MARKER.length) : line;
		const padded = padLine(truncateToWidth(content, width), width);
		return selected ? theme.bg("selectedBg", padded) : padded;
	}

	private isPendingDeleteRow(row: AgentsViewRow): boolean {
		return (
			getSummaryIdentity(row.summary) === this.pendingDeleteAgent?.identity && this.isDeleteConfirmationVisible()
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

	private renderHints(width: number): string {
		if (this.isCtrlCExitHintVisible()) {
			const clearKey = keyText("app.clear");
			const hint = clearKey ? `Press ${clearKey} again to exit` : "Press again to exit";
			return truncateToWidth(theme.fg("muted", hint), width);
		}
		if (this.statusMessage) {
			const tone = this.statusMessage.startsWith("Failed") ? "error" : "muted";
			return truncateToWidth(theme.fg(tone, this.statusMessage), width);
		}
		const hints = [
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} move`,
			`${keyText("tui.select.confirm")} open/send`,
			`${keyText("app.agents.reply")} reply`,
			`${keyText("app.agents.delete")} stop/deactivate`,
			this.replyActiveSessionId ? `${keyText("app.agents.back")} back` : undefined,
		]
			.filter((hint): hint is string => hint !== undefined)
			.join("  ");
		return truncateToWidth(theme.fg("muted", hints), width);
	}

	private visibleListRows(): number {
		return Math.max(4, this.ui.terminal.rows - 9);
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
				return WORKING_ICON_FRAMES[this.workingIconFrame % WORKING_ICON_FRAMES.length] ?? WORKING_ICON_FRAMES[0];
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
	| { type: "row"; row: AgentsViewRow }
	| { type: "subagents"; count: number };

function buildDisplayItems(rows: readonly AgentsViewRow[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	const sections: AgentsViewSection[] = ["working", "completed"];
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
			if (row.runningSubagentCount > 0) {
				items.push({ type: "subagents", count: row.runningSubagentCount });
			}
		}
	}
	return items;
}

function getDisplayRowsForSection(rows: readonly AgentsViewRow[], section: AgentsViewSection): AgentsViewRow[] {
	return rows.filter((row) => row.depth === 0 && row.section === section);
}

function countRowsBySection(rows: readonly AgentsViewRow[]): Record<AgentsViewSection, number> {
	return {
		working: rows.filter((row) => row.section === "working").length,
		completed: rows.filter((row) => row.section === "completed").length,
	};
}

function getSelectedRowIdentity(row: AgentsViewRow | undefined): string | undefined {
	return row ? getSummaryIdentity(row.summary) : undefined;
}

function getSummaryIdentity(summary: SessionSummary): string {
	if (summary.sessionFile) {
		return `file:${summary.sessionFile}`;
	}
	if (summary.activeSessionId) {
		return `active:${summary.activeSessionId}`;
	}
	return `session:${summary.sessionId}`;
}

function isRunningSessionSummary(summary: SessionSummary): boolean {
	return (
		summary.isStreaming ||
		summary.isCompacting ||
		summary.pendingMessageCount > 0 ||
		summary.status === "model" ||
		summary.status === "tool"
	);
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
	return `${prefix}: ${message}`;
}

function padLine(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
