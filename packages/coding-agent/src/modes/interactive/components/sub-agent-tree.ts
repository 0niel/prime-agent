import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export type SubAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface SubAgentTranscriptLine {
	role: "user" | "assistant" | "tool" | "system";
	text: string;
}

export interface SubAgentTreeNode {
	id: string;
	label: string;
	status: SubAgentStatus;
	durationMs?: number;
	tokenCount?: number;
	costUsd?: number;
	answerPreview?: string;
	transcript?: readonly SubAgentTranscriptLine[];
	children?: readonly SubAgentTreeNode[];
	expanded?: boolean;
}

export interface SubAgentTreeOptions {
	rootLabel?: string;
	nodes?: readonly SubAgentTreeNode[];
	emptyText?: string;
}

type SubAgentNodePatch = Partial<Omit<SubAgentTreeNode, "id" | "children">> & {
	children?: readonly SubAgentTreeNode[];
};

export class SubAgentTreeComponent implements Component {
	private rootLabel: string;
	private emptyText: string;
	private nodes: readonly SubAgentTreeNode[];
	private expandedIds = new Set<string>();
	private expandAll = false;

	constructor(options: SubAgentTreeOptions = {}) {
		this.rootLabel = options.rootLabel ?? "sub-agents";
		this.emptyText = options.emptyText ?? "no recursive calls in this turn";
		this.nodes = options.nodes ?? [];
	}

	setNodes(nodes: readonly SubAgentTreeNode[]): void {
		this.nodes = nodes;
	}

	setExpanded(expanded: boolean): void;
	setExpanded(nodeId: string, expanded: boolean): void;
	setExpanded(nodeIdOrExpanded: string | boolean, expanded?: boolean): void {
		if (typeof nodeIdOrExpanded === "boolean") {
			this.expandAll = nodeIdOrExpanded;
			return;
		}
		if (expanded) {
			this.expandedIds.add(nodeIdOrExpanded);
		} else {
			this.expandedIds.delete(nodeIdOrExpanded);
		}
	}

	toggleNode(nodeId: string): void {
		this.setExpanded(nodeId, !this.expandedIds.has(nodeId));
	}

	updateNode(nodeId: string, patch: SubAgentNodePatch): void {
		this.nodes = this.nodes.map((node) => this.patchNode(node, nodeId, patch));
	}

	invalidate(): void {
		// Rendering is derived from node state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines: string[] = [];
		lines.push(theme.fg("borderAccent", "─".repeat(safeWidth)));

		const totalTokens = this.nodes.reduce((total, node) => total + this.tokenRollup(node), 0);
		const totalCost = this.nodes.reduce((total, node) => total + this.costRollup(node), 0);
		const headerParts = [theme.bold(this.rootLabel)];
		if (totalTokens > 0) {
			headerParts.push(theme.fg("muted", this.formatTokens(totalTokens)));
		}
		if (totalCost > 0) {
			headerParts.push(theme.fg("muted", `$${totalCost.toFixed(4)}`));
		}
		lines.push(truncateToWidth(headerParts.join(" "), safeWidth));

		if (this.nodes.length === 0) {
			lines.push(truncateToWidth(`  ${theme.fg("muted", this.emptyText)}`, safeWidth));
			lines.push(theme.fg("borderMuted", "─".repeat(safeWidth)));
			return lines;
		}

		for (const [index, node] of this.nodes.entries()) {
			this.renderNode(lines, node, "", index === this.nodes.length - 1, safeWidth);
		}
		lines.push(theme.fg("borderMuted", "─".repeat(safeWidth)));
		return lines;
	}

	private patchNode(node: SubAgentTreeNode, nodeId: string, patch: SubAgentNodePatch): SubAgentTreeNode {
		const children = node.children?.map((child) => this.patchNode(child, nodeId, patch));
		if (node.id !== nodeId) {
			return children ? { ...node, children } : node;
		}
		return {
			...node,
			...patch,
			children: patch.children ?? children ?? node.children,
		};
	}

	private renderNode(lines: string[], node: SubAgentTreeNode, prefix: string, isLast: boolean, width: number): void {
		const connector = `${prefix}${isLast ? "└─ " : "├─ "}`;
		const line = connector + this.nodeSummary(node);
		lines.push(truncateToWidth(line, width));

		const childPrefix = `${prefix}${isLast ? "   " : "│  "}`;
		if (this.expandAll || node.expanded || this.expandedIds.has(node.id)) {
			this.renderTranscript(lines, node, childPrefix, width);
		}

		const children = node.children ?? [];
		for (const [index, child] of children.entries()) {
			this.renderNode(lines, child, childPrefix, index === children.length - 1, width);
		}
	}

	private renderTranscript(lines: string[], node: SubAgentTreeNode, prefix: string, width: number): void {
		const transcript = node.transcript ?? [];
		if (transcript.length === 0) {
			lines.push(truncateToWidth(`${prefix}   ${theme.fg("muted", "(transcript unavailable)")}`, width));
			return;
		}

		for (const entry of transcript) {
			const label = theme.fg("dim", `${entry.role}: `);
			const wrapped = wrapTextWithAnsi(
				entry.text,
				Math.max(1, width - visibleWidth(prefix) - 3 - visibleWidth(label)),
			);
			for (const [index, line] of wrapped.entries()) {
				const entryPrefix = index === 0 ? `${prefix}   ${label}` : `${prefix}   ${" ".repeat(visibleWidth(label))}`;
				lines.push(truncateToWidth(entryPrefix + line, width));
			}
		}
	}

	private nodeSummary(node: SubAgentTreeNode): string {
		const parts = [this.statusLabel(node.status), theme.bold(node.label)];
		const meta: string[] = [];
		const duration = this.formatDuration(node.durationMs);
		if (duration) {
			meta.push(duration);
		}
		const tokenCount = this.tokenRollup(node);
		if (tokenCount > 0) {
			meta.push(this.formatTokens(tokenCount));
		} else if (node.status === "running") {
			meta.push("... tok");
		}
		const cost = this.costRollup(node);
		if (cost > 0) {
			meta.push(`$${cost.toFixed(4)}`);
		}
		if (meta.length > 0) {
			parts.push(theme.fg("muted", `(${meta.join(", ")})`));
		}
		if (node.answerPreview) {
			parts.push(theme.fg("toolOutput", `-> "${node.answerPreview}"`));
		}
		return parts.join(" ");
	}

	private statusLabel(status: SubAgentStatus): string {
		switch (status) {
			case "queued":
				return theme.fg("muted", "[queued]");
			case "running":
				return theme.fg("bashMode", "[running]");
			case "done":
				return theme.fg("success", "[done]");
			case "error":
				return theme.fg("error", "[error]");
			case "cancelled":
				return theme.fg("warning", "[cancelled]");
		}
	}

	private formatDuration(durationMs: number | undefined): string | undefined {
		if (durationMs === undefined) {
			return undefined;
		}
		if (durationMs < 1000) {
			return `${Math.round(durationMs)}ms`;
		}
		return `${(durationMs / 1000).toFixed(1)}s`;
	}

	private formatTokens(tokens: number): string {
		if (tokens >= 1000) {
			return `${(tokens / 1000).toFixed(1)}k tok`;
		}
		return `${tokens} tok`;
	}

	private tokenRollup(node: SubAgentTreeNode): number {
		const own = node.tokenCount ?? 0;
		const children = node.children?.reduce((total, child) => total + this.tokenRollup(child), 0) ?? 0;
		return own + children;
	}

	private costRollup(node: SubAgentTreeNode): number {
		const own = node.costUsd ?? 0;
		const children = node.children?.reduce((total, child) => total + this.costRollup(child), 0) ?? 0;
		return own + children;
	}
}
