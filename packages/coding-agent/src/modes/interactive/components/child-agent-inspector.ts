import { getModels, type KnownProvider } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	getKeybindings,
	type Keybinding,
	Loader,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { AGENT_ACTIVITY_LABELS, formatTokenCount } from "../agent-activity.js";
import { theme } from "../theme/theme.js";
import { getWorkingPulseFrame, workingIconFrame } from "../theme/working-icon.js";
import { keyText } from "./keybinding-hints.js";

export type ChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface ChildAgentActivity {
	kind: "waiting" | "writing" | "executing";
	toolName?: string;
}

export interface ChildAgentInspectorNode {
	id: string;
	/** The child's own daemon active-session id, for attaching directly to its stream. */
	activeSessionId?: string;
	/** Stable daemon-visible session name for addressing/displaying the child. */
	sessionName?: string;
	/** Exact provider/model selector used by the child. */
	model?: string;
	label: string;
	status: ChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	toolUseCount?: number;
	tokenCount?: number;
	recap?: string;
	sessionDir: string;
	activity?: ChildAgentActivity;
	hasActiveHeartbeat?: boolean;
	error?: string;
	children?: readonly ChildAgentInspectorNode[];
}

export interface ChildAgentDetailOptions {
	ui?: TUI;
}

interface FlatChildAgentNode {
	node: ChildAgentInspectorNode;
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

// Active before finished, so completed agents settle to the bottom.
function childAgentSortRank(node: ChildAgentInspectorNode): number {
	return node.status === "running" || node.status === "queued" || node.hasActiveHeartbeat ? 0 : 1;
}

function flattenChildAgentNodes(nodes: readonly ChildAgentInspectorNode[]): FlatChildAgentNode[] {
	const result: FlatChildAgentNode[] = [];
	const walk = (items: readonly ChildAgentInspectorNode[]): void => {
		const ordered = [...items].sort((a, b) => childAgentSortRank(a) - childAgentSortRank(b));
		for (const node of ordered) {
			result.push({ node });
			walk(node.children ?? []);
		}
	};
	walk(nodes);
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

// Left indent for the detail panel's own lines, aligned with the conversation body.
const CONTENT_INDENT = 2;

function isKillableChildAgentStatus(status: ChildAgentStatus): boolean {
	return status === "running" || status === "queued";
}

/** A main-agent-style activity label ("Waiting" / "Writing" / "Executing"), shown until the recap lands. */
export function nodeActivityLabel(node: ChildAgentInspectorNode): string {
	if (node.status === "queued") {
		return "Waiting";
	}
	switch (node.activity?.kind) {
		case "executing":
			return node.activity.toolName ? `Executing ${node.activity.toolName}` : "Executing";
		case "writing":
			return "Writing";
		default:
			return "Waiting";
	}
}

// Subagent list entries mirror the agents view row format: icon, title, right-aligned time.
function childAgentStatusIcon(node: ChildAgentInspectorNode): string {
	if (node.hasActiveHeartbeat) {
		return "♥";
	}
	switch (node.status) {
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
			const _exhaustive: never = node.status;
			return _exhaustive;
		}
	}
}

function formatChildAgentStatusIcon(node: ChildAgentInspectorNode, icon: string): string {
	if (node.hasActiveHeartbeat) {
		return theme.fg("error", icon);
	}
	switch (node.status) {
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
			const _exhaustive: never = node.status;
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

function childAgentRecap(node: ChildAgentInspectorNode): string {
	if (node.status === "cancelled") {
		return "Cancelled";
	}
	const recap = node.recap?.replace(/\s+/g, " ").trim();
	return recap || (node.hasActiveHeartbeat ? "Heartbeat active" : nodeActivityLabel(node));
}

function padTableCell(value: string, width: number, ellipsis = ""): string {
	const truncated = truncateToWidth(value, width, ellipsis);
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function childAgentModelLabel(selector: string | undefined): string {
	if (!selector) {
		return "";
	}
	const separatorIndex = selector.indexOf("/");
	if (separatorIndex === -1) {
		return selector;
	}
	const provider = selector.slice(0, separatorIndex);
	const modelId = selector.slice(separatorIndex + 1);
	return getModels(provider as KnownProvider).find((model) => model.id === modelId)?.name ?? modelId;
}

function truncateModelLabel(value: string, width: number): string {
	if (visibleWidth(value) <= width) {
		return value;
	}
	if (width <= 1) {
		return truncateToWidth(value, width, "");
	}
	const prefixWidth = Math.max(1, Math.floor((width - 1) * 0.35));
	const suffixWidth = width - prefixWidth - 1;
	let suffix = "";
	for (const character of [...value].reverse()) {
		if (visibleWidth(character + suffix) > suffixWidth) {
			break;
		}
		suffix = character + suffix;
	}
	return `${truncateToWidth(value, prefixWidth, "")}…${suffix}`;
}

// Rows shown at once in the inline list below the prompt; extras scroll.
const SUMMARY_VISIBLE_ROWS = 5;
const SUMMARY_LIST_INDENT = 0;
const SHARED_PREFIX_MIN = 12;
const SUMMARY_COLUMN_GAP = 2;
const SUMMARY_PROMPT_MAX_WIDTH = 24;
const SUMMARY_RECAP_MIN_WIDTH = 12;
const SUMMARY_MODEL_WIDTH = 20;
const SUMMARY_TOKENS_WIDTH = 8;
const SUMMARY_DURATION_WIDTH = 4;
const SUMMARY_TOKEN_TIME_GAP = 2;
const SUMMARY_METRICS_WIDTH =
	SUMMARY_MODEL_WIDTH + 1 + SUMMARY_TOKENS_WIDTH + SUMMARY_TOKEN_TIME_GAP + SUMMARY_DURATION_WIDTH;
// Opening chars of the prompt kept for context before eliding a shared prefix.
const PROMPT_LEADING_CONTEXT = 6;
// Words of context kept on each side of the divergence.
const PROMPT_DIFF_CONTEXT_WORDS = 1;

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
		if (!this.focused || !this.selectedId || !flat.some((entry) => entry.node.id === this.selectedId)) {
			this.selectedId =
				flat.find(
					(entry) =>
						entry.node.status === "running" || entry.node.status === "queued" || entry.node.hasActiveHeartbeat,
				)?.node.id ?? flat[0]?.node.id;
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
		const start = this.focused
			? Math.max(0, Math.min(selectedIndex - (SUMMARY_VISIBLE_ROWS - 1), flat.length - SUMMARY_VISIBLE_ROWS))
			: 0;
		const clampedStart = Math.max(0, start);
		const window = flat.slice(clampedStart, clampedStart + SUMMARY_VISIBLE_ROWS);

		const agentWidth = `S${flat.length}`.length;
		const fixedWidth = SUMMARY_LIST_INDENT + 2 + agentWidth + SUMMARY_COLUMN_GAP * 3 + SUMMARY_METRICS_WIDTH;
		const flexibleWidth = Math.max(0, contentWidth - fixedWidth);
		const recapMinimum = Math.min(SUMMARY_RECAP_MIN_WIDTH, Math.floor(flexibleWidth / 2));
		const promptTarget = Math.min(SUMMARY_PROMPT_MAX_WIDTH, Math.max(10, Math.floor(flexibleWidth * 0.34)));
		const promptWidth = Math.max(0, Math.min(promptTarget, flexibleWidth - recapMinimum));
		const recapWidth = Math.max(0, flexibleWidth - promptWidth);
		const promptPrefix = this.sharedPromptPrefix(window);
		const promptSuffix = this.sharedPromptSuffix(window, promptPrefix);

		const lines: string[] = [];
		for (const entry of window) {
			const selected = this.focused && entry.node.id === this.selectedId;
			const number = flat.indexOf(entry) + 1;
			lines.push(
				this.panelLine(
					this.renderListEntry(entry, number, agentWidth, promptPrefix, promptSuffix, promptWidth, recapWidth),
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
		const labels = flat.map((entry) => this.entryLabel(entry));
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
		const labels = flat.map((entry) => this.entryLabel(entry));
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
		agentWidth: number,
		sharedPrefix: string,
		sharedSuffix: string,
		promptWidth: number,
		recapWidth: number,
	): string {
		const indent = " ".repeat(SUMMARY_LIST_INDENT);
		// Running rows pulse the shared working glyph; other states stay static.
		const rawIcon = entry.node.hasActiveHeartbeat
			? childAgentStatusIcon(entry.node)
			: entry.node.status === "running"
				? workingIconFrame(getWorkingPulseFrame())
				: childAgentStatusIcon(entry.node);
		const icon = formatChildAgentStatusIcon(entry.node, rawIcon);
		const agentLabel = `S${number}`;
		const agentCell = theme.fg("muted", padTableCell(agentLabel, agentWidth));
		const promptCell = this.elidePrompt(this.entryLabel(entry), sharedPrefix, sharedSuffix, promptWidth);
		const recapCell = theme.fg("muted", padTableCell(childAgentRecap(entry.node), recapWidth, "…"));
		const model = childAgentModelLabel(entry.node.model);
		const tokens = entry.node.tokenCount === undefined ? "" : `${formatTokenCount(entry.node.tokenCount)} tok`;
		const duration = formatChildAgentDuration(entry.node.durationMs);
		const modelCell = padTableCell(truncateModelLabel(model, SUMMARY_MODEL_WIDTH), SUMMARY_MODEL_WIDTH);
		const tokensCell = padTableCell(tokens, SUMMARY_TOKENS_WIDTH, "…");
		const durationCell = padTableCell(duration, SUMMARY_DURATION_WIDTH, "…");
		const metrics = `${modelCell} ${tokensCell}${" ".repeat(SUMMARY_TOKEN_TIME_GAP)}${durationCell}`;
		const gap = " ".repeat(SUMMARY_COLUMN_GAP);
		return `${indent}${icon} ${agentCell}${gap}${promptCell}${gap}${recapCell}${gap}${theme.fg("muted", metrics)}`;
	}

	private entryLabel(entry: FlatChildAgentNode): string {
		return entry.node.sessionName?.trim() || entry.node.label;
	}

	private elidePrompt(label: string, sharedPrefix: string, sharedSuffix: string, width: number): string {
		const text = this.elideAroundDiff(label, sharedPrefix, sharedSuffix);
		const safeWidth = Math.max(0, width);
		const truncated =
			visibleWidth(text) > safeWidth ? `${truncateToWidth(text, Math.max(0, safeWidth - 1), "").trimEnd()}…` : text;
		return theme.fg("dim", padTableCell(truncated, safeWidth));
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
	private bodyComponents: Component[] = [];
	private toolsExpanded = false;
	private readonly fallbackTui = { requestRender: () => {} } as TUI;
	private killConfirmExpiresAt = 0;
	private killConfirmTimer: ReturnType<typeof setTimeout> | undefined;
	private backHintLabel = "back to chat";
	private statusLoader: Loader | undefined;
	private lastStatusMessage: string | undefined;

	onCancel?: () => void;
	onToggleToolsExpanded?: () => void;
	onKill?: (nodeId: string) => void;

	constructor(
		_getViewportHeight: () => number = () => 0,
		private readonly options: ChildAgentDetailOptions = {},
	) {}

	setNode(node: ChildAgentInspectorNode | undefined): void {
		if (node?.id !== this.node?.id) {
			this.clearKillConfirmation({ render: false });
		}
		this.node = node;
		// Stop the spinner's interval once the subagent is no longer running, not just
		// when the panel closes, so it doesn't keep requesting redraws after completion.
		if (!node || (node.status !== "running" && node.status !== "queued")) {
			this.statusLoader?.stop();
			this.statusLoader = undefined;
			this.lastStatusMessage = undefined;
		}
	}

	setBodyComponents(components: Component[]): void {
		this.bodyComponents = components;
		this.requestRender();
	}

	setBackHintLabel(label: string): void {
		this.backHintLabel = label;
	}

	setToolsExpanded(expanded: boolean): void {
		this.toolsExpanded = expanded;
		for (const component of this.bodyComponents) {
			if (isExpandableComponent(component)) {
				component.setExpanded(expanded);
			}
		}
	}

	invalidate(): void {
		for (const component of this.bodyComponents) {
			component.invalidate?.();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const sections = this.renderDetail(safeWidth);
		return [
			...sections.headerLines,
			...sections.bodyLines,
			...this.statusAndRecapLines(safeWidth),
			this.panelLine(theme.fg("borderMuted", "─".repeat(safeWidth)), safeWidth),
			this.panelLine(this.detailHintLine(safeWidth), safeWidth),
		];
	}

	/** Subagent's own working status + recap, sitting just above the bottom divider. */
	private statusAndRecapLines(width: number): string[] {
		const node = this.node;
		if (!node) {
			return [];
		}
		const lines: string[] = [];
		if (node.status === "running" || node.status === "queued") {
			// Reuse the main agent's loader so the spinner and labels are identical.
			// The loader self-pads one space; add one more to align with the body.
			const loader = this.ensureStatusLoader();
			// setMessage triggers a render; only call it when the label actually changes,
			// or render()->setMessage->requestRender->render becomes a self-sustaining loop.
			const message = this.panelStatusLabel(node);
			if (message !== this.lastStatusMessage) {
				this.lastStatusMessage = message;
				loader.setMessage(message);
			}
			lines.push(...loader.render(width).map((line) => this.indent(line, width, 1)));
		}
		const recap = node.status === "cancelled" ? "Cancelled" : node.recap?.trim();
		if (recap) {
			lines.push("");
			lines.push(this.indent(this.truncate(theme.fg("dim", `Recap: ${recap}`), width - CONTENT_INDENT), width));
		}
		lines.push("");
		return lines;
	}

	private ensureStatusLoader(): Loader {
		if (!this.statusLoader) {
			this.statusLoader = new Loader(
				this.options.ui ?? this.fallbackTui,
				(spinner) => theme.fg("accent", spinner),
				(text) => theme.fg("muted", text),
				"",
			);
		}
		return this.statusLoader;
	}

	private panelStatusLabel(node: ChildAgentInspectorNode): string {
		if (node.status === "queued") {
			return AGENT_ACTIVITY_LABELS.waiting;
		}
		switch (node.activity?.kind) {
			case "executing":
				return AGENT_ACTIVITY_LABELS.executing;
			case "writing":
				return AGENT_ACTIVITY_LABELS.writing;
			default:
				return AGENT_ACTIVITY_LABELS.waiting;
		}
	}

	private indent(line: string, width: number, spaces = CONTENT_INDENT): string {
		if (line === "") {
			return line;
		}
		return this.truncate(`${" ".repeat(spaces)}${line}`, width);
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

		const headerLines = [this.indent(this.truncate(theme.fg("text", selected.label), width - CONTENT_INDENT), width)];
		headerLines.push(this.panelLine(theme.fg("borderMuted", "─".repeat(width)), width));

		const bodyLines: string[] = [];
		for (const component of this.bodyComponents) {
			bodyLines.push(...component.render(width));
		}
		return { headerLines, bodyLines };
	}

	private headerLine(text: string, width: number): string {
		const plainWidth = visibleWidth(text);
		const rule = "─".repeat(Math.max(1, width - plainWidth - 1));
		return this.truncate(`${text} ${theme.fg("borderMuted", rule)}`, width);
	}

	private detailHintLine(width: number): string {
		const backAction = keyAction("app.agents.back", this.backHintLabel, { primaryOnly: true });
		const expandAction = keyAction("app.tools.expand", this.toolsExpanded ? "to collapse" : "to expand");
		const killable = this.node !== undefined && isKillableChildAgentStatus(this.node.status);
		const stopAction = !killable
			? undefined
			: this.isKillConfirmationVisible()
				? theme.fg("error", `${keyText("app.agents.delete", { primaryOnly: true }).trim()} again to stop`)
				: keyAction("app.agents.delete", "stop", { primaryOnly: true });
		const actions = [backAction, expandAction, stopAction];
		const separatorWidth = visibleWidth(joinHints(["", ""]));
		const modelWidth = Math.max(0, width - visibleWidth(joinHints(actions)) - separatorWidth);
		const modelLabel = childAgentModelLabel(this.node?.model);
		const model =
			modelLabel && modelWidth >= 4 ? theme.fg("muted", truncateToWidth(modelLabel, modelWidth, "…")) : undefined;
		return hintLine([backAction, model, expandAction, stopAction], width);
	}

	private panelLine(line: string, width: number): string {
		return this.truncate(line, width);
	}

	private truncate(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}
}
