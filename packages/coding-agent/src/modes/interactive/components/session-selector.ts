import * as os from "node:os";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../../core/keybindings.js";
import { type DeleteSessionFileResult, deleteSessionFile } from "../../../core/session-file-actions.js";
import { canonicalizePath as _canonicalizePath } from "../../../utils/paths.js";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSessionListProgress,
} from "../../agent-connection/index.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.js";
import { keyHint, keyText } from "./keybinding-hints.js";
import { shouldTreatAsBack } from "./modal-back.js";
import { filterAndSortSessions, hasSessionName, type NameFilter, type SortMode } from "./session-selector-search.js";

type SessionScope = "current" | "all";

export interface SessionListCallbacks {
	onProgress?: AgentConnectionSessionListProgress;
	onSession?: (session: AgentConnectionSavedSessionInfo) => void;
}

// Mirrors the agents view delete flow: press the delete key once to arm, again
// within this window to confirm; anything else (or the timeout) cancels.
const DELETE_CONFIRM_DURATION_MS = 2000;

function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function canonicalizePath(path: string | undefined): string | undefined {
	if (!path) return path;
	return _canonicalizePath(path);
}

function formatMutationError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class SessionSelectorHeader implements Component {
	private scope: SessionScope;
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private loadProgress: { loaded: number; total: number } | null = null;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	constructor(scope: SessionScope, sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.scope = scope;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setScope(scope: SessionScope): void {
		this.scope = scope;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
		// Progress is scoped to the current load; clear whenever the loading state is set
		this.loadProgress = null;
	}

	setProgress(loaded: number, total: number): void {
		this.loadProgress = { loaded, total };
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
		this.statusTimeout.unref?.();
	}

	invalidate(): void {}

	render(width: number): string[] {
		const leftText = theme.bold("Resume Session");

		const sortLabel = this.sortMode === "threaded" ? "threaded" : this.sortMode === "recent" ? "recent" : "fuzzy";
		const segments: string[] = [];
		if (this.loading) {
			const progressText = this.loadProgress ? `${this.loadProgress.loaded}/${this.loadProgress.total}` : "...";
			segments.push(`loading ${progressText}`);
		} else {
			segments.push(this.scope === "current" ? "current folder" : "all projects");
		}
		segments.push(`sort: ${sortLabel}`);
		if (this.nameFilter === "named") {
			segments.push("named only");
		}
		const rightText = truncateToWidth(theme.fg("muted", segments.join("  ")), width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		// Build hint lines - changes based on state (all branches truncate to width)
		let hintLine1: string;
		let hintLine2: string;
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Press ${keyText("app.agents.delete")} again to delete`;
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			hintLine2 = "";
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			hintLine2 = "";
		} else {
			const pathState = this.showPath ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const hint1 =
				keyHint("tui.input.tab", "scope") + sep + theme.fg("muted", 're:<pattern> regex · "phrase" exact');
			const hint2Parts = [
				keyHint("app.session.toggleSort", "sort"),
				keyHint("app.session.toggleNamedFilter", "named"),
				keyHint("app.agents.delete", "delete"),
				keyHint("app.session.togglePath", `path ${pathState}`),
			];
			if (this.showRenameHint) {
				hint2Parts.push(keyHint("app.session.rename", "rename"));
			}
			const hint2 = hint2Parts.join(sep);
			hintLine1 = truncateToWidth(hint1, width, "…");
			hintLine2 = truncateToWidth(hint2, width, "…");
		}

		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

/** A session tree node for hierarchical display */
interface SessionTreeNode {
	session: AgentConnectionSavedSessionInfo;
	children: SessionTreeNode[];
}

/** Flattened node for display with tree structure info */
interface FlatSessionNode {
	session: AgentConnectionSavedSessionInfo;
	depth: number;
	isLast: boolean;
	/** For each ancestor level, whether there are more siblings after it */
	ancestorContinues: boolean[];
}

/**
 * Build a tree structure from sessions based on parentSessionPath.
 * Returns root nodes sorted by modified date (descending).
 */
function buildSessionTree(sessions: AgentConnectionSavedSessionInfo[]): SessionTreeNode[] {
	const byPath = new Map<string, SessionTreeNode>();

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		byPath.set(sessionPath, { session, children: [] });
	}

	const roots: SessionTreeNode[] = [];

	for (const session of sessions) {
		const sessionPath = canonicalizePath(session.path) ?? session.path;
		const node = byPath.get(sessionPath)!;
		const parentPath = canonicalizePath(session.parentSessionPath);

		if (parentPath && byPath.has(parentPath)) {
			byPath.get(parentPath)!.children.push(node);
		} else {
			roots.push(node);
		}
	}

	// Sort children and roots by modified date (descending)
	const sortNodes = (nodes: SessionTreeNode[]): void => {
		nodes.sort((a, b) => b.session.modified.getTime() - a.session.modified.getTime());
		for (const node of nodes) {
			sortNodes(node.children);
		}
	};
	sortNodes(roots);

	return roots;
}

/**
 * Flatten tree into display list with tree structure metadata.
 */
function flattenSessionTree(roots: SessionTreeNode[]): FlatSessionNode[] {
	const result: FlatSessionNode[] = [];

	const walk = (node: SessionTreeNode, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
		result.push({ session: node.session, depth, isLast, ancestorContinues });

		for (let i = 0; i < node.children.length; i++) {
			const childIsLast = i === node.children.length - 1;
			// Only show continuation line for non-root ancestors
			const continues = depth > 0 ? !isLast : false;
			walk(node.children[i]!, depth + 1, [...ancestorContinues, continues], childIsLast);
		}
	};

	for (let i = 0; i < roots.length; i++) {
		walk(roots[i]!, 0, [], i === roots.length - 1);
	}

	return result;
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.session.path;
	}
	private allSessions: AgentConnectionSavedSessionInfo[] = [];
	private filteredSessions: FlatSessionNode[] = [];
	private selectedIndex: number = 0;
	private searchInput: Input;
	private showCwd = false;
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private keybindings: KeybindingsManager;
	private showPath = false;
	private streaming = false;
	private confirmingDeletePath: string | null = null;
	private deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;
	private currentSessionCanonicalPath?: string;
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	public onExit: () => void = () => {};
	public onToggleScope?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 10; // Max sessions visible (one line each)

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		sessions: AgentConnectionSavedSessionInfo[],
		showCwd: boolean,
		sortMode: SortMode,
		nameFilter: NameFilter,
		keybindings: KeybindingsManager,
		currentSessionFilePath?: string,
	) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.showCwd = showCwd;
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.keybindings = keybindings;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		this.filterSessions("");

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.session.path);
				}
			}
		};
	}

	setMaxVisible(maxVisible: number): void {
		this.maxVisible = Math.max(3, maxVisible);
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: AgentConnectionSavedSessionInfo[], showCwd: boolean, streaming = false): void {
		const selectedPath = this.getSelectedSessionPath();
		this.allSessions = sessions;
		this.showCwd = showCwd;
		this.streaming = streaming;
		this.filterSessions(this.searchInput.getValue());
		if (selectedPath) {
			const selectedIndex = this.filteredSessions.findIndex((session) => session.session.path === selectedPath);
			if (selectedIndex >= 0) {
				this.selectedIndex = selectedIndex;
			}
		}
	}

	private filterSessions(query: string): void {
		const trimmed = query.trim();
		const nameFiltered =
			this.nameFilter === "all" ? this.allSessions : this.allSessions.filter((session) => hasSessionName(session));

		if (this.sortMode === "threaded" && !trimmed && !this.streaming) {
			// Threaded mode without search: show tree structure
			const roots = buildSessionTree(nameFiltered);
			this.filteredSessions = flattenSessionTree(roots);
		} else {
			// Other modes or with search: flat list
			const filtered = filterAndSortSessions(nameFiltered, query, this.sortMode, "all");
			this.filteredSessions = filtered.map((session) => ({
				session,
				depth: 0,
				isLast: true,
				ancestorContinues: [],
			}));
		}
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	private clearDeleteConfirmation(): void {
		if (this.deleteConfirmTimer) {
			clearTimeout(this.deleteConfirmTimer);
			this.deleteConfirmTimer = null;
		}
		if (this.confirmingDeletePath !== null) {
			this.setConfirmingDeletePath(null);
		}
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		// Prevent deleting current session
		if (this.isCurrentSessionPath(selected.session.path)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		// Second press within the window confirms.
		if (this.confirmingDeletePath === selected.session.path) {
			const pathToDelete = this.confirmingDeletePath;
			this.clearDeleteConfirmation();
			void this.onDeleteSession?.(pathToDelete);
			return;
		}

		this.clearDeleteConfirmation();
		this.setConfirmingDeletePath(selected.session.path);
		this.deleteConfirmTimer = setTimeout(() => {
			this.deleteConfirmTimer = null;
			this.setConfirmingDeletePath(null);
		}, DELETE_CONFIRM_DURATION_MS);
		this.deleteConfirmTimer.unref?.();
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.filteredSessions.length === 0) {
			let emptyMessage: string;
			if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				if (this.showCwd) {
					emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
				} else {
					emptyMessage = `  No named sessions in current folder. Press ${toggleKey} to show all, or Tab to view all.`;
				}
			} else if (this.showCwd) {
				// "All" scope - no sessions anywhere that match filter
				emptyMessage = "  No sessions found";
			} else {
				// "Current folder" scope - hint to try "all"
				emptyMessage = "  No sessions in current folder. Press Tab to view all.";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions like agents view rows: icon, title, right-aligned details.
		for (let i = startIndex; i < endIndex; i++) {
			const node = this.filteredSessions[i]!;
			const session = node.session;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.path === this.confirmingDeletePath;
			const isCurrent = this.isCurrentSessionPath(session.path);

			// Build tree prefix
			const prefix = this.buildTreePrefix(node);

			// Session display text (name or first message); an armed delete shows
			// the confirm prompt in place of the title like the agents view.
			const displayText = isConfirmingDelete
				? `${keyText("app.agents.delete")} again to remove`
				: (session.name ?? session.firstMessage);
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// Right side: message count and age
			const age = formatSessionDate(session.modified);
			let rightPart = `${session.messageCount} · ${age}`;
			if (this.showCwd && session.cwd) {
				rightPart = `${shortenPath(session.cwd)}  ${rightPart}`;
			}
			if (this.showPath) {
				rightPart = `${shortenPath(session.path)}  ${rightPart}`;
			}

			const rawIcon = isConfirmingDelete ? "✗" : "✓";
			const icon = isConfirmingDelete
				? theme.fg("error", rawIcon)
				: isCurrent
					? theme.fg("accent", rawIcon)
					: theme.fg("success", rawIcon);

			// Calculate available width for message
			const prefixWidth = visibleWidth(prefix);
			const rightWidth = visibleWidth(rightPart) + 2; // +2 for spacing
			const availableForMsg = width - 2 - prefixWidth - rightWidth - 2; // icon + gap

			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			const styledMsg = isConfirmingDelete ? theme.fg("error", truncatedMsg) : truncatedMsg;

			// Build line
			const leftPart = `${theme.fg("dim", prefix)}${icon} ${styledMsg}`;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			let line = leftPart + " ".repeat(spacing) + styledRight;
			if (isSelected) {
				const padded = truncateToWidth(line, width);
				line = theme.bg("selectedBg", padded + " ".repeat(Math.max(0, width - visibleWidth(padded))));
			}
			lines.push(truncateToWidth(line, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			lines.push(scrollInfo);
		}

		return lines;
	}

	private buildTreePrefix(node: FlatSessionNode): string {
		if (node.depth === 0) {
			return "";
		}

		const parts = node.ancestorContinues.map((continues) => (continues ? "│  " : "   "));
		const branch = node.isLast ? "└─ " : "├─ ";
		return parts.join("") + branch;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Any key other than another delete press cancels an armed confirmation
		// and is then handled normally, like the agents view.
		const hadDeleteConfirmation = this.confirmingDeletePath !== null;
		if (
			hadDeleteConfirmation &&
			!kb.matches(keyData, "app.agents.delete") &&
			!kb.matches(keyData, "app.session.deleteNoninvasive")
		) {
			this.clearDeleteConfirmation();
		}

		if (kb.matches(keyData, "tui.input.tab")) {
			if (this.onToggleScope) {
				this.onToggleScope();
			}
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (this.keybindings.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		// Ctrl+P: toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// Same binding as the agents view: arm on first press, confirm on second.
		if (kb.matches(keyData, "app.agents.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Rename selected session
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.session.path);
			}
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		}
		// Page up - jump up by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.session.path);
			}
		}
		// Escape, or left arrow when the search field is at its start - cancel.
		// If this same keypress just disarmed a delete confirmation, left only
		// disarms (like other nav keys); Esc still cancels, matching its role.
		else if (
			kb.matches(keyData, "tui.select.cancel") ||
			(!hadDeleteConfirmation && shouldTreatAsBack(keyData, this.searchInput))
		) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

type SessionsLoader = (callbacks?: SessionListCallbacks) => Promise<AgentConnectionSavedSessionInfo[]>;
type SessionDeleter = (sessionPath: string) => Promise<DeleteSessionFileResult>;

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
	}

	private canRename = true;
	private readonly frameless: boolean;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private keybindings: KeybindingsManager;
	private scope: SessionScope = "current";
	private sortMode: SortMode = "threaded";
	private nameFilter: NameFilter = "all";
	private currentSessions: AgentConnectionSavedSessionInfo[] | null = null;
	private allSessions: AgentConnectionSavedSessionInfo[] | null = null;
	private currentSessionsLoader: SessionsLoader;
	private allSessionsLoader: SessionsLoader;
	private onCancel: () => void;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	private deleteSession: SessionDeleter;
	private currentLoading = false;
	private allLoading = false;
	private currentLoadSeq = 0;
	private allLoadSeq = 0;

	private mode: "list" | "rename" = "list";
	private renameInput = new Input();
	private renameTargetPath: string | null = null;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		this.addChild(new Spacer(1));
		if (!this.frameless) {
			this.addChild(new DynamicBorder((s) => theme.fg("borderMuted", s)));
			this.addChild(new Spacer(1));
		}
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		if (!this.frameless) {
			this.addChild(new Spacer(1));
			this.addChild(new DynamicBorder((s) => theme.fg("borderMuted", s)));
		}
	}

	constructor(
		currentSessionsLoader: SessionsLoader,
		allSessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		onExit: () => void,
		requestRender: () => void,
		options?: {
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			deleteSession?: SessionDeleter;
			showRenameHint?: boolean;
			keybindings?: KeybindingsManager;
			/** Skip the framing borders; used when the selector fills the whole screen. */
			frameless?: boolean;
		},
		currentSessionFilePath?: string,
	) {
		super();
		this.frameless = options?.frameless ?? false;
		this.keybindings = options?.keybindings ?? KeybindingsManager.create();
		this.currentSessionsLoader = currentSessionsLoader;
		this.allSessionsLoader = allSessionsLoader;
		this.onCancel = onCancel;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.scope, this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.deleteSession = options?.deleteSession ?? deleteSessionFile;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList(
			[],
			false,
			this.sortMode,
			this.nameFilter,
			this.keybindings,
			currentSessionFilePath,
		);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// Ensure header status timeouts are cleared when leaving the selector
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionPath) => {
			clearStatusMessage();
			onSelect(sessionPath);
		};
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			onCancel();
		};
		this.sessionList.onExit = () => {
			clearStatusMessage();
			onExit();
		};
		this.sessionList.onToggleScope = () => this.toggleScope();
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.scope === "current" && this.currentLoading) return;
			if (this.scope === "all" && this.allLoading) return;

			const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
			const session = sessions.find((s) => s.path === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// Handle session deletion
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			let result: DeleteSessionFileResult;
			try {
				result = await this.deleteSession(sessionPath);
			} catch (error) {
				this.header.setStatusMessage(
					{ type: "error", message: `Failed to delete: ${formatMutationError(error)}` },
					3000,
				);
				this.requestRender();
				return;
			}

			if (result.ok) {
				if (this.currentSessions) {
					this.currentSessions = this.currentSessions.filter((s) => s.path !== sessionPath);
				}
				if (this.allSessions) {
					this.allSessions = this.allSessions.filter((s) => s.path !== sessionPath);
				}

				const sessions = this.scope === "all" ? (this.allSessions ?? []) : (this.currentSessions ?? []);
				const showCwd = this.scope === "all";
				const streaming = this.scope === "all" ? this.allLoading : this.currentLoading;
				this.sessionList.setSessions(sessions, showCwd, streaming);

				const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
				try {
					await this.refreshSessionsAfterMutation();
					this.header.setStatusMessage({ type: "info", message: msg }, 2000);
				} catch (error) {
					this.header.setStatusMessage(
						{ type: "error", message: `${msg}; refresh failed: ${formatMutationError(error)}` },
						3000,
					);
				}
			} else {
				const errorMessage = result.error ?? "Unknown error";
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			}

			this.requestRender();
		};

		// Start loading current sessions immediately
		this.loadCurrentSessions();
	}

	private loadCurrentSessions(): void {
		void this.loadScope("current", "initial");
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// Find current name for callback
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
		} catch (error) {
			this.exitRenameMode();
			this.header.setStatusMessage(
				{ type: "error", message: `Failed to rename: ${formatMutationError(error)}` },
				4000,
			);
			this.requestRender();
			return;
		}

		try {
			await this.refreshSessionsAfterMutation();
		} catch (error) {
			this.exitRenameMode();
			this.header.setStatusMessage(
				{ type: "error", message: `Session renamed; refresh failed: ${formatMutationError(error)}` },
				4000,
			);
			this.requestRender();
			return;
		}

		this.exitRenameMode();
	}

	private async loadScope(scope: SessionScope, reason: "initial" | "refresh" | "toggle"): Promise<void> {
		const showCwd = scope === "all";

		// Mark loading
		if (scope === "current") {
			this.currentLoading = true;
		} else {
			this.allLoading = true;
		}

		const seq = scope === "current" ? ++this.currentLoadSeq : ++this.allLoadSeq;
		this.header.setScope(scope);
		this.header.setLoading(true);
		this.requestRender();
		const isLatestLoad = () => seq === (scope === "current" ? this.currentLoadSeq : this.allLoadSeq);
		const isCurrentView = () => scope === this.scope;
		const streamedSessions = new Map<string, AgentConnectionSavedSessionInfo>();

		const onProgress = (loaded: number, total: number) => {
			if (!isLatestLoad() || !isCurrentView()) return;
			this.header.setProgress(loaded, total);
			this.requestRender();
		};
		const onSession = (session: AgentConnectionSavedSessionInfo) => {
			if (reason === "refresh" || !isLatestLoad() || !isCurrentView()) return;
			streamedSessions.set(session.path, session);
			const sessions = [...streamedSessions.values()];
			if (scope === "current") {
				this.currentSessions = sessions;
			} else {
				this.allSessions = sessions;
			}
			this.sessionList.setSessions(sessions, showCwd, true);
			this.requestRender();
		};

		try {
			const sessions = await (scope === "current"
				? this.currentSessionsLoader({ onProgress, onSession })
				: this.allSessionsLoader({ onProgress, onSession }));

			if (!isLatestLoad()) return;

			if (scope === "current") {
				this.currentSessions = sessions;
				this.currentLoading = false;
			} else {
				this.allSessions = sessions;
				this.allLoading = false;
			}

			if (!isCurrentView()) return;

			this.header.setLoading(false);
			this.sessionList.setSessions(sessions, showCwd);
			this.requestRender();

			if (scope === "all" && sessions.length === 0 && (this.currentSessions?.length ?? 0) === 0) {
				this.onCancel();
			}
		} catch (err) {
			if (!isLatestLoad()) return;

			if (scope === "current") {
				this.currentLoading = false;
			} else {
				this.allLoading = false;
			}

			if (!isCurrentView()) return;

			const message = err instanceof Error ? err.message : String(err);
			this.header.setLoading(false);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);

			if (reason === "initial") {
				this.sessionList.setSessions([], showCwd);
			}
			this.requestRender();
		}
	}

	private toggleSortMode(): void {
		// Cycle: threaded -> recent -> relevance -> threaded
		this.sortMode = this.sortMode === "threaded" ? "recent" : this.sortMode === "recent" ? "relevance" : "threaded";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private async refreshSessionsAfterMutation(): Promise<void> {
		await this.loadScope(this.scope, "refresh");
	}

	private toggleScope(): void {
		if (this.scope === "current") {
			this.scope = "all";
			this.header.setScope(this.scope);

			if (this.allSessions !== null) {
				this.header.setLoading(this.allLoading);
				this.sessionList.setSessions(this.allSessions, true, this.allLoading);
				this.requestRender();
				return;
			}

			if (!this.allLoading) {
				void this.loadScope("all", "toggle");
			}
			return;
		}

		this.scope = "current";
		this.header.setScope(this.scope);
		this.header.setLoading(this.currentLoading);
		this.sessionList.setSessions(this.currentSessions ?? [], false);
		this.requestRender();
	}

	setListMaxVisible(maxVisible: number): void {
		this.sessionList.setMaxVisible(maxVisible);
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
