import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	getKeybindings,
	type Keybinding,
	type MarkdownTheme,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";
import { getWorkingPulseFrame, workingIconFrame } from "../theme/working-icon.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { CollapsibleErrorComponent, shouldCollapseErrorDetails } from "./collapsible-error.js";
import { keyText } from "./keybinding-hints.js";
import { ToolExecutionComponent, type ToolExecutionDefinition, type ToolExecutionOptions } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export type ChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface ChildAgentTranscriptLine {
	role: "user" | "assistant" | "tool" | "system";
	text: string;
}

export interface ChildAgentToolResult {
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
}

export interface ChildAgentMessageTranscriptEntry {
	type: "message";
	role: "user" | "assistant";
	text: string;
	message: UserMessage | AssistantMessage;
}

export interface ChildAgentToolTranscriptEntry {
	type: "tool";
	role: "tool";
	text: string;
	toolCallId: string;
	toolName: string;
	args: unknown;
	result?: ChildAgentToolResult;
	isPartial: boolean;
	executionStarted: boolean;
	argsComplete: boolean;
}

export interface ChildAgentSystemTranscriptEntry {
	type: "system";
	role: "system";
	text: string;
}

export type ChildAgentStructuredTranscriptEntry =
	| ChildAgentMessageTranscriptEntry
	| ChildAgentToolTranscriptEntry
	| ChildAgentSystemTranscriptEntry;

export interface ChildAgentInspectorNode {
	id: string;
	label: string;
	status: ChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	sessionDir: string;
	transcript: readonly ChildAgentTranscriptLine[];
	structuredTranscript?: readonly ChildAgentStructuredTranscriptEntry[];
	children?: readonly ChildAgentInspectorNode[];
}

export interface ChildAgentDetailOptions {
	ui?: TUI;
	getCwd?: () => string;
	getToolDefinition?: (toolName: string) => ToolExecutionDefinition | undefined;
	getToolOptions?: () => ToolExecutionOptions;
	getMarkdownTheme?: () => MarkdownTheme;
	getToolsExpanded?: () => boolean;
	getHideThinkingBlock?: () => boolean;
	getHiddenThinkingLabel?: () => string;
}

interface FlatChildAgentNode {
	node: ChildAgentInspectorNode;
	depth: number;
}

interface DetailSections {
	headerLines: string[];
	bodyLines: string[];
}

interface ExpandableComponent extends Component {
	setExpanded(expanded: boolean): void;
}

function isExpandableComponent(component: Component): component is ExpandableComponent {
	return "setExpanded" in component && typeof (component as { setExpanded?: unknown }).setExpanded === "function";
}

function flattenChildAgentNodes(nodes: readonly ChildAgentInspectorNode[]): FlatChildAgentNode[] {
	const result: FlatChildAgentNode[] = [];
	const walk = (items: readonly ChildAgentInspectorNode[], depth: number): void => {
		for (const node of items) {
			result.push({ node, depth });
			walk(node.children ?? [], depth + 1);
		}
	};
	walk(nodes, 0);
	return result;
}

interface KeyActionOptions {
	primaryOnly?: boolean;
}

function keyAction(keybinding: Keybinding, description: string, options: KeyActionOptions = {}): string | undefined {
	const keys = keyText(keybinding, options).trim();
	return keys ? `${theme.fg("dim", keys)}${theme.fg("muted", ` ${description}`)}` : undefined;
}

function combinedKeyAction(keybindings: readonly Keybinding[], description: string): string | undefined {
	const keys = keybindings
		.map((keybinding) => keyText(keybinding).trim())
		.filter((key) => key.length > 0)
		.join("/");
	return keys ? `${theme.fg("dim", keys)}${theme.fg("muted", ` ${description}`)}` : undefined;
}

function joinHints(hints: ReadonlyArray<string | undefined>): string {
	return hints.filter((hint) => hint !== undefined).join(theme.fg("dim", " · "));
}

function hintLine(hints: ReadonlyArray<string | undefined>, width: number): string {
	return truncateToWidth(joinHints(hints), width, "");
}

// Matches the agents view delete confirmation window.
const KILL_CONFIRM_DURATION_MS = 2000;

function isKillableChildAgentStatus(status: ChildAgentStatus): boolean {
	return status === "running" || status === "queued";
}

// Subagent list entries mirror the agents view row format: icon, title, right-aligned time.
function childAgentStatusIcon(status: ChildAgentStatus): string {
	switch (status) {
		case "queued":
			return "◇";
		case "running":
			return "◆";
		case "done":
			return "✓";
		case "error":
		case "cancelled":
			return "✗";
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function formatChildAgentStatusIcon(status: ChildAgentStatus, icon: string): string {
	switch (status) {
		case "queued":
			return theme.fg("dim", icon);
		case "running":
			return theme.bold(icon);
		case "done":
			return theme.fg("success", icon);
		case "error":
			return theme.fg("error", icon);
		case "cancelled":
			return theme.fg("warning", icon);
		default: {
			const _exhaustive: never = status;
			return _exhaustive;
		}
	}
}

function formatChildAgentDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) {
		return "";
	}
	const seconds = Math.max(0, Math.floor(durationMs / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	return `${Math.floor(minutes / 60)}h`;
}

function padTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

// Rows shown at once in the inline list below the prompt; extras scroll.
const SUMMARY_VISIBLE_ROWS = 5;
const SUMMARY_LIST_INDENT = 1;
const SHARED_PREFIX_MIN = 12;
// Gap between the "Subagent N" column and the prompt.
const SUMMARY_LABEL_GAP = 4;
// Opening chars of the prompt kept for context before eliding a shared prefix.
const PROMPT_LEADING_CONTEXT = 14;
// Words of context kept on each side of the divergence.
const PROMPT_DIFF_CONTEXT_WORDS = 2;

export class ChildAgentSummaryComponent implements Component, Focusable {
	focused = false;
	private readonly paddingX = 1;
	private nodes: readonly ChildAgentInspectorNode[] = [];
	private hidden = false;
	private selectedId: string | undefined;

	onOpen?: () => void;
	onCancel?: () => void;
	onExit?: () => void;
	onOpenDetail?: (nodeId: string) => void;
	// Chat actions that should still work while the list holds focus.
	onChatAction?: (data: string) => void;

	constructor(
		private readonly getLocationLabel: () => string | undefined = () => undefined,
		private readonly getContextLabel: () => string | undefined = () => undefined,
		private readonly getOverrideLabel: () => string | undefined = () => undefined,
	) {}

	setNodes(nodes: readonly ChildAgentInspectorNode[]): void {
		this.nodes = nodes;
		const flat = flattenChildAgentNodes(this.nodes);
		if (flat.length === 0) {
			this.selectedId = undefined;
			return;
		}
		if (!this.selectedId || !flat.some((entry) => entry.node.id === this.selectedId)) {
			this.selectedId = flat.find((entry) => entry.node.status === "running")?.node.id ?? flat[0]?.node.id;
		}
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
	}

	selectNode(nodeId: string): void {
		if (flattenChildAgentNodes(this.nodes).some((entry) => entry.node.id === nodeId)) {
			this.selectedId = nodeId;
		}
	}

	hasNodes(): boolean {
		return flattenChildAgentNodes(this.nodes).length > 0;
	}

	invalidate(): void {
		// Render output is derived from node state.
	}

	render(width: number): string[] {
		if (this.hidden) {
			return [];
		}

		const safeWidth = Math.max(1, width);
		const flat = flattenChildAgentNodes(this.nodes);
		const lines = [...this.renderInfoLine(safeWidth)];
		lines.push(...this.renderSubagentList(flat, safeWidth));
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const flat = flattenChildAgentNodes(this.nodes);
		const open = () => (this.selectedId ? this.onOpenDetail?.(this.selectedId) : this.onOpen?.());
		if (kb.matches(data, "tui.select.confirm") || kb.matches(data, "app.agents.open")) {
			open();
			return;
		}
		if (kb.matches(data, "app.agents.back")) {
			this.onExit?.();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1, flat);
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			if (this.isAtFirstRow(flat)) {
				this.onCancel?.();
			} else {
				this.moveSelection(-1, flat);
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		// Keys the list doesn't own fall through to chat actions (expand tools, etc.).
		this.onChatAction?.(data);
	}

	private isAtFirstRow(flat: readonly FlatChildAgentNode[]): boolean {
		return flat.length === 0 || flat[0]?.node.id === this.selectedId;
	}

	private moveSelection(delta: number, flat: readonly FlatChildAgentNode[]): void {
		if (flat.length === 0) {
			return;
		}
		const current = Math.max(
			0,
			flat.findIndex((entry) => entry.node.id === this.selectedId),
		);
		const next = Math.max(0, Math.min(flat.length - 1, current + delta));
		this.selectedId = flat[next]?.node.id;
	}

	private renderInfoLine(width: number): string[] {
		const overrideLabel = this.getOverrideLabel()?.trim();
		const locationLabel = this.getLocationLabel()?.trim();
		const contextLabel = this.getContextLabel()?.trim();
		const override = overrideLabel ? theme.fg("muted", overrideLabel) : "";
		const location = !override && locationLabel ? theme.fg("muted", locationLabel) : "";
		const context = contextLabel ? theme.fg("muted", contextLabel) : "";
		const leftSegments = [override, location].filter((segment) => segment.length > 0);
		if (leftSegments.length === 0 && !context) {
			return [];
		}

		const rawLeft = leftSegments.join(theme.fg("dim", "  "));
		const paddedLine = context
			? this.renderSplitLine(rawLeft, context, width)
			: this.renderCompactLine(rawLeft, width);
		return [paddedLine];
	}

	private renderSubagentList(flat: readonly FlatChildAgentNode[], width: number): string[] {
		if (flat.length === 0) {
			return [];
		}
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const selectedIndex = Math.max(
			0,
			flat.findIndex((entry) => entry.node.id === this.selectedId),
		);
		const start = Math.max(
			0,
			Math.min(selectedIndex - (SUMMARY_VISIBLE_ROWS - 1), flat.length - SUMMARY_VISIBLE_ROWS),
		);
		const clampedStart = Math.max(0, start);
		const window = flat.slice(clampedStart, clampedStart + SUMMARY_VISIBLE_ROWS);

		const labelWidth = `Subagent ${flat.length}`.length;
		const promptPrefix = this.sharedPromptPrefix(window);
		const promptSuffix = this.sharedPromptSuffix(window, promptPrefix);

		const lines: string[] = [theme.fg("borderMuted", "─".repeat(width))];
		for (const entry of window) {
			const selected = this.focused && entry.node.id === this.selectedId;
			const number = flat.indexOf(entry) + 1;
			lines.push(
				this.panelLine(
					this.renderListEntry(entry, number, labelWidth, promptPrefix, promptSuffix, contentWidth),
					width,
					selected,
				),
			);
		}
		const scrollHint = this.scrollHint(flat.length, clampedStart, contentWidth);
		if (scrollHint) {
			lines.push(this.panelLine(scrollHint, width, false));
		}
		return lines;
	}

	// Only elide when the prefix is long enough and leaves a distinguishing tail.
	private sharedPromptPrefix(flat: readonly FlatChildAgentNode[]): string {
		if (flat.length < 2) {
			return "";
		}
		const labels = flat.map((entry) => entry.node.label);
		let prefix = labels[0] ?? "";
		for (const label of labels) {
			let i = 0;
			while (i < prefix.length && i < label.length && prefix[i] === label[i]) {
				i++;
			}
			prefix = prefix.slice(0, i);
			if (!prefix) {
				break;
			}
		}
		const minTail = labels.some((label) => label.length <= prefix.length);
		return prefix.length >= SHARED_PREFIX_MIN && !minTail ? prefix : "";
	}

	// Common trailing run after the divergence, so the diff window can also drop a
	// shared tail. Only used when it leaves room past the prefix for a real diff.
	private sharedPromptSuffix(flat: readonly FlatChildAgentNode[], prefix: string): string {
		if (flat.length < 2 || !prefix) {
			return "";
		}
		const labels = flat.map((entry) => entry.node.label);
		let suffix = labels[0] ?? "";
		for (const label of labels) {
			let i = 0;
			while (
				i < suffix.length &&
				i < label.length &&
				suffix[suffix.length - 1 - i] === label[label.length - 1 - i]
			) {
				i++;
			}
			suffix = suffix.slice(suffix.length - i);
		}
		// Keep the suffix clear of the prefix on every label so the diff survives.
		const safe = labels.every((label) => prefix.length + suffix.length < label.length);
		return safe && suffix.length >= SHARED_PREFIX_MIN ? suffix : "";
	}

	private renderListEntry(
		entry: FlatChildAgentNode,
		number: number,
		labelWidth: number,
		sharedPrefix: string,
		sharedSuffix: string,
		width: number,
	): string {
		const indent = " ".repeat(SUMMARY_LIST_INDENT + Math.min(6, entry.depth * 2));
		// Running rows pulse the shared working glyph; other states stay static.
		const rawIcon =
			entry.node.status === "running"
				? workingIconFrame(getWorkingPulseFrame())
				: childAgentStatusIcon(entry.node.status);
		const icon = formatChildAgentStatusIcon(entry.node.status, rawIcon);
		const numberCell = theme.fg("muted", padTableCell(`Subagent ${number}`, labelWidth));
		const time = formatChildAgentDuration(entry.node.durationMs);
		const timeWidth = 6;
		// Fixed columns consume: icon + space, the label gap, and a space before time.
		const fixed = visibleWidth(indent) + visibleWidth(rawIcon) + 1 + labelWidth + SUMMARY_LABEL_GAP + 1 + timeWidth;
		// The prompt may use all remaining space; the elision keeps it short and the
		// gap fill still right-aligns the time.
		const promptWidth = Math.max(0, width - fixed);
		const prompt = this.elidePrompt(entry.node.label, sharedPrefix, sharedSuffix, promptWidth);
		const promptCell = theme.fg("dim", prompt);
		const labelGap = " ".repeat(SUMMARY_LABEL_GAP);
		const fillWidth = Math.max(
			0,
			width -
				visibleWidth(indent) -
				visibleWidth(rawIcon) -
				1 -
				labelWidth -
				SUMMARY_LABEL_GAP -
				visibleWidth(prompt) -
				visibleWidth(time) -
				1,
		);
		const fill = " ".repeat(fillWidth);
		const timeCell = theme.fg("muted", time);
		return `${indent}${icon} ${numberCell}${labelGap}${promptCell}${fill} ${timeCell}`;
	}

	// Coloring is applied by the caller so the trailing ellipsis matches the text.
	private elidePrompt(label: string, sharedPrefix: string, sharedSuffix: string, width: number): string {
		const text = this.elideAroundDiff(label, sharedPrefix, sharedSuffix);
		// Column-aware truncation (handles wide/combining chars), with the ellipsis
		// reserved inside the budget rather than appended past it.
		return truncateToWidth(text, Math.max(0, width), "…");
	}

	// Window the prompt around its divergence: "<leading context>…<~2 words before
	// the diff><diff><~2 words after the diff>…", dropping the shared head and tail.
	private elideAroundDiff(label: string, sharedPrefix: string, sharedSuffix: string): string {
		// Nothing useful to elide if the whole shared run fits in the leading window.
		if (!sharedPrefix || !label.startsWith(sharedPrefix) || sharedPrefix.length <= PROMPT_LEADING_CONTEXT) {
			return label;
		}
		// Snap the leading window to a word boundary so it doesn't cut mid-word.
		const leadSpace = label.lastIndexOf(" ", PROMPT_LEADING_CONTEXT);
		const lead = label.slice(0, leadSpace > 0 ? leadSpace : PROMPT_LEADING_CONTEXT).trimEnd();

		// Back the window start up a couple words before the divergence.
		let start = sharedPrefix.length;
		for (let words = 0; words < PROMPT_DIFF_CONTEXT_WORDS && start > 0; words++) {
			const prevSpace = label.lastIndexOf(" ", start - 2);
			if (prevSpace <= lead.length) {
				break;
			}
			start = prevSpace + 1;
		}

		// Advance the window end a couple words past where the labels re-converge.
		let end = label.length;
		if (sharedSuffix && label.endsWith(sharedSuffix)) {
			end = label.length - sharedSuffix.length;
			for (let words = 0; words < PROMPT_DIFF_CONTEXT_WORDS && end < label.length; words++) {
				const nextSpace = label.indexOf(" ", end + 1);
				if (nextSpace < 0) {
					end = label.length;
					break;
				}
				end = nextSpace;
			}
		}

		const middle = label.slice(start, end).trimEnd();
		const tail = end < label.length ? "…" : "";
		return `${lead}…${middle}${tail}`;
	}

	private scrollHint(total: number, start: number, width: number): string | undefined {
		if (total <= SUMMARY_VISIBLE_ROWS) {
			return undefined;
		}
		const above = start;
		const below = total - (start + SUMMARY_VISIBLE_ROWS);
		const segments: string[] = [];
		if (above > 0) {
			segments.push(theme.fg("dim", `▴ ${above} above`));
		}
		if (below > 0) {
			segments.push(theme.fg("dim", `▾ ${below} below`));
		}
		const hint = this.focused
			? joinHints([
					combinedKeyAction(["tui.select.up", "tui.select.down"], "scroll"),
					keyAction("tui.select.confirm", "open"),
				])
			: "";
		const left = segments.join(theme.fg("dim", " · "));
		const body = hint ? `${left}${theme.fg("dim", "  ")}${hint}` : left;
		return this.truncate(`${" ".repeat(SUMMARY_LIST_INDENT)}${body}`, width);
	}

	private panelLine(line: string, width: number, selected: boolean): string {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const truncated = this.truncate(line, contentWidth);
		const paddedContent = truncated + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
		const padded = `${" ".repeat(this.paddingX)}${paddedContent}${" ".repeat(this.paddingX)}`;
		return selected ? theme.bg("selectedBg", padded) : padded;
	}

	private truncate(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}

	private renderCompactLine(line: string, width: number): string {
		const panelWidth = Math.min(width, visibleWidth(line) + this.paddingX * 2);
		const contentWidth = Math.max(1, panelWidth - this.paddingX * 2);
		const truncated = this.truncate(line, contentWidth);
		return `${" ".repeat(this.paddingX)}${truncated}${" ".repeat(Math.max(0, panelWidth - this.paddingX - visibleWidth(truncated)))}`;
	}

	private renderSplitLine(left: string, right: string, width: number): string {
		const contentWidth = Math.max(1, width - this.paddingX);
		const gapWidth = left ? 2 : 0;
		const leftWidth = visibleWidth(left);
		const rightWidthLimit =
			left && contentWidth > gapWidth && leftWidth + gapWidth + visibleWidth(right) > contentWidth
				? contentWidth - gapWidth - Math.min(leftWidth, Math.max(1, Math.floor((contentWidth - gapWidth) / 3)))
				: contentWidth;
		const renderedRight = this.truncate(right, Math.max(0, rightWidthLimit));
		const rightWidth = visibleWidth(renderedRight);
		const renderedLeftWidth = Math.max(0, contentWidth - rightWidth - gapWidth);
		const renderedLeft = renderedLeftWidth > 0 ? this.truncate(left, renderedLeftWidth) : "";
		const gap = Math.max(0, contentWidth - visibleWidth(renderedLeft) - rightWidth);
		return `${" ".repeat(this.paddingX)}${renderedLeft}${" ".repeat(gap)}${renderedRight}`;
	}
}

export class ChildAgentDetailComponent implements Component, Focusable {
	focused = false;
	private node: ChildAgentInspectorNode | undefined;
	private transcriptComponents: Component[] = [];
	private readonly fallbackTui = { requestRender: () => {} } as TUI;
	private toolsExpanded = false;
	private killConfirmExpiresAt = 0;
	private killConfirmTimer: ReturnType<typeof setTimeout> | undefined;

	onCancel?: () => void;
	onToggleToolsExpanded?: () => void;
	onKill?: (nodeId: string) => void;

	constructor(
		_getViewportHeight: () => number = () => 0,
		private readonly options: ChildAgentDetailOptions = {},
	) {
		this.toolsExpanded = this.options.getToolsExpanded?.() ?? false;
	}

	setNode(node: ChildAgentInspectorNode | undefined): void {
		if (node?.id !== this.node?.id) {
			this.clearKillConfirmation({ render: false });
		}
		this.node = node;
		this.toolsExpanded = this.options.getToolsExpanded?.() ?? this.toolsExpanded;
		this.rebuildTranscriptComponents();
	}

	setToolsExpanded(expanded: boolean): void {
		this.toolsExpanded = expanded;
		for (const component of this.transcriptComponents) {
			if (isExpandableComponent(component)) {
				component.setExpanded(expanded);
			}
		}
	}

	invalidate(): void {
		this.rebuildTranscriptComponents();
		for (const component of this.transcriptComponents) {
			component.invalidate?.();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const sections = this.renderDetail(safeWidth);
		return [
			...sections.headerLines,
			...sections.bodyLines,
			this.panelLine(theme.fg("borderMuted", "─".repeat(safeWidth)), safeWidth),
			this.panelLine(this.detailHintLine(safeWidth), safeWidth),
		];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		// Any input other than the kill key disarms the pending confirmation,
		// matching the agents view delete flow.
		if (!kb.matches(data, "app.agents.delete")) {
			this.clearKillConfirmation({ render: false });
		}
		if (kb.matches(data, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
			return;
		}
		if (kb.matches(data, "app.agents.delete")) {
			this.handleKillKey();
			return;
		}
		if (kb.matches(data, "app.agents.back")) {
			this.onCancel?.();
		}
	}

	private handleKillKey(): void {
		const node = this.node;
		if (!node || !isKillableChildAgentStatus(node.status)) {
			this.clearKillConfirmation({ render: false });
			return;
		}
		if (this.isKillConfirmationVisible()) {
			this.clearKillConfirmation({ render: false });
			this.onKill?.(node.id);
			return;
		}
		this.showKillConfirmation();
	}

	private showKillConfirmation(): void {
		if (this.killConfirmTimer) {
			clearTimeout(this.killConfirmTimer);
		}
		this.killConfirmExpiresAt = Date.now() + KILL_CONFIRM_DURATION_MS;
		this.killConfirmTimer = setTimeout(() => {
			this.killConfirmTimer = undefined;
			this.killConfirmExpiresAt = 0;
			this.requestRender();
		}, KILL_CONFIRM_DURATION_MS);
		this.killConfirmTimer.unref?.();
		this.requestRender();
	}

	private clearKillConfirmation(options: { render?: boolean } = {}): void {
		if (!this.killConfirmTimer && this.killConfirmExpiresAt === 0) {
			return;
		}
		if (this.killConfirmTimer) {
			clearTimeout(this.killConfirmTimer);
			this.killConfirmTimer = undefined;
		}
		this.killConfirmExpiresAt = 0;
		if (options.render !== false) {
			this.requestRender();
		}
	}

	private isKillConfirmationVisible(): boolean {
		return this.killConfirmExpiresAt > Date.now();
	}

	private requestRender(): void {
		(this.options.ui ?? this.fallbackTui).requestRender();
	}

	private renderDetail(width: number): DetailSections {
		const selected = this.node;
		if (!selected) {
			return {
				headerLines: [this.panelLine(this.headerLine(theme.fg("muted", "agent unavailable"), width), width)],
				bodyLines: [],
			};
		}

		const headerLines = [
			this.panelLine(
				this.headerLine(`${this.statusLabel(selected.status)} ${theme.fg("dim", selected.label)}`, width),
				width,
			),
		];
		const sessionDirParts = selected.sessionDir.split("/");
		const leaf = sessionDirParts[sessionDirParts.length - 1];
		if (leaf) {
			headerLines.push(this.panelLine(this.truncate(theme.fg("dim", leaf), width), width));
		}
		headerLines.push(this.panelLine(theme.fg("borderMuted", "─".repeat(width)), width));

		const bodyLines: string[] = [];
		if (selected.structuredTranscript && selected.structuredTranscript.length > 0) {
			for (const component of this.transcriptComponents) {
				bodyLines.push(...component.render(width));
			}
			return { headerLines, bodyLines };
		}
		for (const line of selected.transcript) {
			const label = theme.fg("dim", `${line.role}: `);
			const wrapped = wrapTextWithAnsi(line.text, Math.max(1, width - visibleWidth(label)));
			for (const [index, wrappedLine] of wrapped.entries()) {
				const prefix = index === 0 ? label : " ".repeat(visibleWidth(label));
				bodyLines.push(this.panelLine(this.truncate(prefix + wrappedLine, width), width));
			}
		}
		return { headerLines, bodyLines };
	}

	private rebuildTranscriptComponents(): void {
		const transcript = this.node?.structuredTranscript;
		if (!transcript || transcript.length === 0) {
			this.transcriptComponents = [];
			return;
		}

		const components: Component[] = [];
		for (const entry of transcript) {
			switch (entry.type) {
				case "message":
					components.push(this.createMessageComponent(entry));
					break;
				case "tool":
					components.push(this.createToolComponent(entry));
					break;
				case "system":
					components.push(this.createSystemComponent(entry));
					break;
			}
		}
		this.transcriptComponents = components;
	}

	private createMessageComponent(entry: ChildAgentMessageTranscriptEntry): Component {
		if (entry.message.role === "user") {
			const text = this.readUserMessageText(entry.message);
			return text
				? new UserMessageComponent(text, this.options.getMarkdownTheme?.())
				: new Text(theme.fg("userMessageText", entry.text), 1, 0);
		}
		return new AssistantMessageComponent(
			entry.message,
			this.options.getHideThinkingBlock?.() ?? false,
			this.options.getMarkdownTheme?.(),
			this.options.getHiddenThinkingLabel?.() ?? "Thinking...",
			{ expanded: this.toolsExpanded },
		);
	}

	private createSystemComponent(entry: ChildAgentSystemTranscriptEntry): Component {
		if (!shouldCollapseErrorDetails(entry.text)) {
			return new Text(theme.fg("error", entry.text), 1, 0);
		}
		return new CollapsibleErrorComponent({
			text: entry.text,
			expanded: this.toolsExpanded,
		});
	}

	private createToolComponent(entry: ChildAgentToolTranscriptEntry): Component {
		const component = new ToolExecutionComponent(
			entry.toolName,
			entry.toolCallId,
			entry.args,
			this.options.getToolOptions?.() ?? {},
			this.options.getToolDefinition?.(entry.toolName),
			this.options.ui ?? this.fallbackTui,
			this.options.getCwd?.() ?? process.cwd(),
		);
		component.setExpanded(this.toolsExpanded);
		if (entry.executionStarted) {
			component.markExecutionStarted();
		}
		if (entry.argsComplete) {
			component.setArgsComplete();
		}
		if (entry.result) {
			component.updateResult(entry.result, entry.isPartial);
		}
		return component;
	}

	private readUserMessageText(message: UserMessage): string {
		if (typeof message.content === "string") {
			return message.content;
		}
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}

	private headerLine(text: string, width: number): string {
		const plainWidth = visibleWidth(text);
		const rule = "─".repeat(Math.max(1, width - plainWidth - 1));
		return this.truncate(`${text} ${theme.fg("borderMuted", rule)}`, width);
	}

	private detailHintLine(width: number): string {
		const expandAction = keyAction("app.tools.expand", this.toolsExpanded ? "to collapse" : "to expand");
		const killable = this.node !== undefined && isKillableChildAgentStatus(this.node.status);
		const stopAction = !killable
			? undefined
			: this.isKillConfirmationVisible()
				? theme.fg("error", `${keyText("app.agents.delete", { primaryOnly: true }).trim()} again to stop`)
				: keyAction("app.agents.delete", "stop", { primaryOnly: true });
		return hintLine(
			[keyAction("app.agents.back", "back to chat", { primaryOnly: true }), expandAction, stopAction],
			width,
		);
	}

	private statusLabel(status: ChildAgentStatus): string {
		switch (status) {
			case "queued":
				return theme.fg("muted", "queued");
			case "running":
				return theme.fg("accent", "running");
			case "done":
				return theme.fg("success", "done");
			case "error":
				return theme.fg("error", "error");
			case "cancelled":
				return theme.fg("warning", "cancelled");
		}
	}

	private panelLine(line: string, width: number): string {
		return this.truncate(line, width);
	}

	private truncate(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}
}
