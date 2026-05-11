import {
	type Component,
	type Focusable,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export type ChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface ChildAgentTranscriptLine {
	role: "user" | "assistant" | "tool" | "system";
	text: string;
}

export interface ChildAgentInspectorNode {
	id: string;
	label: string;
	status: ChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	sessionDir: string;
	transcript: readonly ChildAgentTranscriptLine[];
	children?: readonly ChildAgentInspectorNode[];
}

interface FlatChildAgentNode {
	node: ChildAgentInspectorNode;
	depth: number;
}

interface SidebarLine {
	text: string;
	selected: boolean;
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

	onCancel?: () => void;

	constructor(private readonly getViewportHeight: () => number = () => 0) {}

	setNode(node: ChildAgentInspectorNode | undefined): void {
		this.node = node;
	}

	invalidate(): void {
		// Render output is derived from node state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = this.renderDetail(safeWidth);
		const targetHeight = Math.max(0, this.getViewportHeight());
		while (lines.length < targetHeight) {
			lines.push("");
		}
		return lines.map((line) => this.panelLine(line, safeWidth));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
		}
	}

	private renderDetail(width: number): string[] {
		const selected = this.node;
		if (!selected) {
			return [this.headerLine(theme.fg("muted", "agent unavailable"), width)];
		}

		const lines = [this.headerLine(`${this.statusLabel(selected.status)} ${theme.fg("dim", selected.label)}`, width)];
		const sessionDirParts = selected.sessionDir.split("/");
		const leaf = sessionDirParts[sessionDirParts.length - 1];
		if (leaf) {
			lines.push(this.truncate(theme.fg("dim", leaf), width));
		}
		lines.push(theme.fg("borderMuted", "─".repeat(width)));
		for (const line of selected.transcript) {
			const label = theme.fg("dim", `${line.role}: `);
			const wrapped = wrapTextWithAnsi(line.text, Math.max(1, width - visibleWidth(label)));
			for (const [index, wrappedLine] of wrapped.entries()) {
				const prefix = index === 0 ? label : " ".repeat(visibleWidth(label));
				lines.push(this.truncate(prefix + wrappedLine, width));
			}
		}
		return lines;
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
