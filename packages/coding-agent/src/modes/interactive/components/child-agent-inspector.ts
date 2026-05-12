import type { AssistantMessage, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import {
	type Component,
	type Focusable,
	getKeybindings,
	type MarkdownTheme,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToolDefinition } from "../../../core/extensions/types.js";
import { theme } from "../theme/theme.js";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent, type ToolExecutionOptions } from "./tool-execution.js";
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
	getToolDefinition?: (toolName: string) => ToolDefinition | undefined;
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

interface SidebarLine {
	text: string;
	selected: boolean;
}

interface DetailSections {
	headerLines: string[];
	bodyLines: string[];
}

export class ChildAgentInspectorComponent implements Component, Focusable {
	focused = false;
	private readonly paddingX = 2;
	private nodes: readonly ChildAgentInspectorNode[] = [];
	private selectedId: string | undefined;

	onCancel?: () => void;
	onOpenDetail?: (nodeId: string) => void;

	constructor(private readonly getViewportHeight: () => number = () => 0) {}

	setNodes(nodes: readonly ChildAgentInspectorNode[]): void {
		this.nodes = nodes;
		const flat = this.flatten();
		if (flat.length === 0) {
			this.selectedId = undefined;
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
		return this.renderSidebar(safeWidth).map((line) => this.panelLine(line.text, safeWidth, line.selected));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		const flat = this.flatten();
		if (flat.length === 0) {
			return;
		}

		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			if (this.selectedId) {
				this.onOpenDetail?.(this.selectedId);
			}
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

	private renderSidebar(width: number): SidebarLine[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const flat = this.flatten();
		const running = flat.filter((entry) => entry.node.status === "running").length;
		const targetHeight = Math.max(0, this.getViewportHeight());
		const lines: SidebarLine[] = [{ text: this.headerLine(running, flat.length, contentWidth), selected: false }];
		const availableRows = targetHeight > 0 ? Math.max(0, targetHeight - 2) : flat.length;
		if (availableRows === 0) {
			return lines;
		}
		lines.push({ text: "", selected: false });

		const selectedIndex = Math.max(
			0,
			flat.findIndex((entry) => entry.node.id === this.selectedId),
		);
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(availableRows / 2), flat.length - availableRows));
		for (const entry of flat.slice(start, start + availableRows)) {
			const selected = this.focused && entry.node.id === this.selectedId;
			lines.push({ text: this.renderListEntry(entry, contentWidth, selected), selected });
		}
		while (targetHeight > 0 && lines.length < targetHeight) {
			lines.push({ text: "", selected: false });
		}
		return lines;
	}

	private renderListEntry(entry: FlatChildAgentNode, width: number, selected: boolean): string {
		const selector = selected ? theme.fg("accent", "▌") : " ";
		const indent = " ".repeat(Math.min(6, entry.depth * 2));
		const line = `${selector} ${indent}${this.statusLabel(entry.node.status)} ${theme.fg("dim", "·")} ${theme.fg("muted", entry.node.label)}`;
		return this.truncate(line, width, "…");
	}
	private flatten(): FlatChildAgentNode[] {
		const result: FlatChildAgentNode[] = [];
		const walk = (nodes: readonly ChildAgentInspectorNode[], depth: number): void => {
			for (const node of nodes) {
				result.push({ node, depth });
				walk(node.children ?? [], depth + 1);
			}
		};
		walk(this.nodes, 0);
		return result;
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

	private headerLine(running: number, total: number, width: number): string {
		const left = theme.bold("agents");
		const right = theme.fg("muted", `${running}/${total} running`);
		const gap = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
		return this.truncate(`${left}${gap}${right}`, width);
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

	private panelLine(line: string, width: number, selected: boolean): string {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const truncated = this.truncate(line, contentWidth);
		const paddedContent = truncated + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
		const padded = `${" ".repeat(this.paddingX)}${paddedContent}${" ".repeat(this.paddingX)}`;
		return selected ? theme.bg("selectedBg", padded) : theme.bg("customMessageBg", padded);
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

	onCancel?: () => void;

	constructor(
		private readonly getViewportHeight: () => number = () => 0,
		private readonly options: ChildAgentDetailOptions = {},
	) {}

	setNode(node: ChildAgentInspectorNode | undefined): void {
		this.node = node;
		this.rebuildTranscriptComponents();
	}

	invalidate(): void {
		this.rebuildTranscriptComponents();
		for (const component of this.transcriptComponents) {
			component.invalidate?.();
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const targetHeight = Math.max(0, this.getViewportHeight());
		const sections = this.renderDetail(safeWidth);
		const lines = [...sections.headerLines, ...sections.bodyLines];
		while (lines.length < targetHeight) {
			lines.push(this.panelLine("", safeWidth));
		}
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
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
					components.push(new Text(theme.fg("error", entry.text), 1, 0));
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
		);
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
		component.setExpanded(this.options.getToolsExpanded?.() ?? false);
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
		const truncated = this.truncate(line, width);
		const padded = truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
		return theme.bg("customMessageBg", padded);
	}

	private truncate(line: string, width: number): string {
		return truncateToWidth(line, width, "");
	}
}
