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

interface InspectorLine {
	text: string;
	selected: boolean;
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

function countRunning(nodes: readonly FlatChildAgentNode[]): number {
	return nodes.filter((entry) => entry.node.status === "running").length;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
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

function padRightTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

export class ChildAgentSummaryComponent implements Component, Focusable {
	focused = false;
	private readonly paddingX = 1;
	private nodes: readonly ChildAgentInspectorNode[] = [];
	private hidden = false;

	onOpen?: () => void;
	onCancel?: () => void;

	constructor(
		private readonly getLocationLabel: () => string | undefined = () => undefined,
		private readonly getContextLabel: () => string | undefined = () => undefined,
		private readonly getOverrideLabel: () => string | undefined = () => undefined,
	) {}

	setNodes(nodes: readonly ChildAgentInspectorNode[]): void {
		this.nodes = nodes;
	}

	setHidden(hidden: boolean): void {
		this.hidden = hidden;
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
		const overrideLabel = this.getOverrideLabel()?.trim();
		const locationLabel = this.getLocationLabel()?.trim();
		const contextLabel = this.getContextLabel()?.trim();
		const override = overrideLabel ? theme.fg("muted", overrideLabel) : "";
		const location = !override && locationLabel ? theme.fg("muted", locationLabel) : "";
		const context = contextLabel ? theme.fg("muted", contextLabel) : "";
		const subagents = !override && flat.length > 0 ? this.subagentSummary(flat, this.focused) : "";
		const summaryHint = !override && this.focused && flat.length > 0 ? this.summaryHint() : "";
		const leftSegments = [override, location, subagents, summaryHint].filter((segment) => segment.length > 0);
		if (leftSegments.length === 0 && !context) {
			return [];
		}

		const rawLeft = leftSegments.join(theme.fg("dim", "  "));
		const paddedLine = context
			? this.renderSplitLine(rawLeft, context, safeWidth)
			: this.renderCompactLine(rawLeft, safeWidth);
		return [paddedLine];
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.confirm")) {
			this.onOpen?.();
			return;
		}
		if (kb.matches(data, "tui.select.cancel") || kb.matches(data, "tui.select.up")) {
			this.onCancel?.();
		}
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

	private subagentSummary(flat: readonly FlatChildAgentNode[], selected: boolean): string {
		const running = countRunning(flat);
		const summary =
			running > 0
				? `${running} ${pluralize(running, "subagent")} running`
				: `${flat.length} ${pluralize(flat.length, "subagent")}`;
		const rendered = theme.bold(summary);
		if (!selected) {
			return rendered;
		}
		return theme.bg("selectedBg", rendered);
	}

	private summaryHint(): string {
		return joinHints([keyAction("tui.select.confirm", "open")]);
	}
}

export class ChildAgentInspectorComponent implements Component, Focusable {
	focused = false;
	private readonly paddingX = 1;
	private nodes: readonly ChildAgentInspectorNode[] = [];
	private selectedId: string | undefined;
	private pendingKillId: string | undefined;
	private killConfirmExpiresAt = 0;
	private killConfirmTimer: ReturnType<typeof setTimeout> | undefined;

	onCancel?: () => void;
	onOpenDetail?: (nodeId: string) => void;
	onKill?: (nodeId: string) => void;

	constructor(
		private readonly getViewportHeight: () => number = () => 0,
		private readonly requestRender: () => void = () => {},
	) {}

	setNodes(nodes: readonly ChildAgentInspectorNode[]): void {
		this.nodes = nodes;
		const flat = this.flatten();
		if (flat.length === 0) {
			this.selectedId = undefined;
			this.clearKillConfirmation({ render: false });
			return;
		}
		if (!this.selectedId || !flat.some((entry) => entry.node.id === this.selectedId)) {
			this.selectedId = flat.find((entry) => entry.node.status === "running")?.node.id ?? flat[0]?.node.id;
		}
	}

	invalidate(): void {
		// Render output is derived from node state.
	}

	render(width: number): string[] {
		if (this.nodes.length === 0) {
			return [];
		}

		const safeWidth = Math.max(1, width);
		const lines = [theme.fg("borderMuted", "─".repeat(safeWidth))];
		for (const line of this.renderList(safeWidth)) {
			lines.push(this.panelLine(line.text, safeWidth, line.selected));
		}
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const flat = this.flatten();
		if (flat.length === 0) {
			return;
		}

		// Any input other than the kill key disarms the pending confirmation,
		// matching the agents view delete flow.
		if (!kb.matches(data, "app.agents.delete")) {
			this.clearKillConfirmation({ render: false });
		}
		if (kb.matches(data, "app.agents.back")) {
			this.onCancel?.();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (this.selectedId) {
				this.onOpenDetail?.(this.selectedId);
			}
			return;
		}
		if (kb.matches(data, "app.agents.delete")) {
			this.handleKillKey();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-5);
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			this.moveSelection(5);
		}
	}

	private renderList(width: number): InspectorLine[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const flat = this.flatten();
		const running = countRunning(flat);
		const targetHeight = Math.max(0, this.getViewportHeight());
		const lines: InspectorLine[] = [{ text: this.headerLine(running, flat.length, contentWidth), selected: false }];
		const availableRows = targetHeight > 0 ? Math.max(0, targetHeight - 3) : flat.length;

		const selectedIndex = Math.max(
			0,
			flat.findIndex((entry) => entry.node.id === this.selectedId),
		);
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(availableRows / 2), flat.length - availableRows));
		if (availableRows > 0) {
			for (const entry of flat.slice(start, start + availableRows)) {
				const selected = this.focused && entry.node.id === this.selectedId;
				lines.push({ text: this.renderListEntry(entry, contentWidth), selected });
			}
		}
		while (targetHeight > 0 && lines.length < targetHeight - 2) {
			lines.push({ text: "", selected: false });
		}
		lines.push({ text: this.listHintLine(contentWidth), selected: false });
		return lines;
	}

	private renderListEntry(entry: FlatChildAgentNode, width: number): string {
		const indent = " ".repeat(Math.min(6, entry.depth * 2));
		const rawIcon = childAgentStatusIcon(entry.node.status);
		const icon = formatChildAgentStatusIcon(entry.node.status, rawIcon);
		const timeWidth = 6;
		const titleWidth = Math.max(0, width - visibleWidth(indent) - visibleWidth(rawIcon) - timeWidth - 2);
		const pendingKill = this.isPendingKillNode(entry.node);
		const title = pendingKill ? `${keyText("app.agents.delete").trim()} again to stop` : entry.node.label;
		const titleCell = padTableCell(title, titleWidth);
		const timeCell = padRightTableCell(formatChildAgentDuration(entry.node.durationMs), timeWidth);
		const renderedTitleCell = pendingKill ? theme.fg("error", titleCell) : titleCell;
		return this.truncate(`${indent}${icon} ${renderedTitleCell} ${timeCell}`, width, "");
	}
	private flatten(): FlatChildAgentNode[] {
		return flattenChildAgentNodes(this.nodes);
	}

	private moveSelection(delta: number): void {
		const flat = this.flatten();
		if (flat.length === 0) {
			return;
		}
		const current = Math.max(
			0,
			flat.findIndex((entry) => entry.node.id === this.selectedId),
		);
		const next = (current + delta + flat.length) % flat.length;
		this.selectedId = flat[next]?.node.id;
	}

	private handleKillKey(): void {
		const selected = this.flatten().find((entry) => entry.node.id === this.selectedId)?.node;
		if (!selected || !isKillableChildAgentStatus(selected.status)) {
			this.clearKillConfirmation({ render: false });
			return;
		}
		if (this.pendingKillId === selected.id && this.isKillConfirmationVisible()) {
			this.clearKillConfirmation({ render: false });
			this.onKill?.(selected.id);
			return;
		}
		this.showKillConfirmation(selected.id);
	}

	private isPendingKillNode(node: ChildAgentInspectorNode): boolean {
		return (
			node.id === this.pendingKillId && isKillableChildAgentStatus(node.status) && this.isKillConfirmationVisible()
		);
	}

	private showKillConfirmation(nodeId: string): void {
		if (this.killConfirmTimer) {
			clearTimeout(this.killConfirmTimer);
		}
		this.pendingKillId = nodeId;
		this.killConfirmExpiresAt = Date.now() + KILL_CONFIRM_DURATION_MS;
		this.killConfirmTimer = setTimeout(() => {
			this.killConfirmTimer = undefined;
			this.pendingKillId = undefined;
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
		this.pendingKillId = undefined;
		this.killConfirmExpiresAt = 0;
		if (options.render !== false) {
			this.requestRender();
		}
	}

	private isKillConfirmationVisible(): boolean {
		return this.killConfirmExpiresAt > Date.now();
	}

	private headerLine(running: number, total: number, width: number): string {
		const left = theme.bold("subagents");
		const right =
			running > 0 ? theme.fg("muted", `${running} running · ${total} total`) : theme.fg("muted", `${total} total`);
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
		return this.truncate(`${left}${gap}${right}`, width);
	}

	private listHintLine(width: number): string {
		const selected = this.flatten().find((entry) => entry.node.id === this.selectedId)?.node;
		const killable = selected !== undefined && isKillableChildAgentStatus(selected.status);
		return hintLine(
			[
				combinedKeyAction(["tui.select.up", "tui.select.down"], "move"),
				keyAction("tui.select.confirm", "open"),
				killable ? keyAction("app.agents.delete", "stop", { primaryOnly: true }) : undefined,
				keyAction("app.agents.back", "back to chat", { primaryOnly: true }),
			],
			width,
		);
	}

	private panelLine(line: string, width: number, selected: boolean): string {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const truncated = this.truncate(line, contentWidth);
		const paddedContent = truncated + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
		const padded = `${" ".repeat(this.paddingX)}${paddedContent}${" ".repeat(this.paddingX)}`;
		return selected ? theme.bg("selectedBg", padded) : padded;
	}

	private truncate(line: string, width: number, ellipsis = ""): string {
		return truncateToWidth(line, width, ellipsis);
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
			[keyAction("app.agents.back", "back to subagents", { primaryOnly: true }), expandAction, stopAction],
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
