import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount } from "../agent-activity.js";
import { theme } from "../theme/theme.js";
import { getWorkingPulseFrame, workingIconFrame } from "../theme/working-icon.js";
import { type ChildAgentInspectorNode, nodeActivityLabel } from "./child-agent-inspector.js";

/** Left padding so the tree aligns with the loader message / tool-call text. */
const PAD = " ";
/** How many subagents to show before collapsing the rest into a "+N more" line. */
const MAX_VISIBLE = 5;
/** Keep each node's label to the first few words so the row stays scannable. */
const LABEL_MAX_WORDS = 4;
const LABEL_MAX_CHARS = 32;

/**
 * Live, render-only tree of the current turn's in-flight subagents, shown above the
 * working loader and in addition to the inline list below the prompt bar. Each node is
 * two lines — label + tool-use/token counts, then its current recap — with an animated
 * working icon. Subagents drop out of the tree as soon as they finish.
 */
export class SubagentTreeView implements Component {
	private nodes: readonly ChildAgentInspectorNode[] = [];

	setNodes(nodes: readonly ChildAgentInspectorNode[]): void {
		// Flatten the whole inspector tree — nested subagents live under `children` —
		// and keep only the in-flight ones; finished subagents disappear.
		const flat: ChildAgentInspectorNode[] = [];
		const walk = (list: readonly ChildAgentInspectorNode[]): void => {
			for (const node of list) {
				if (node.status === "running" || node.status === "queued") {
					flat.push(node);
				}
				if (node.children) {
					walk(node.children);
				}
			}
		};
		walk(nodes);
		this.nodes = flat;
	}

	hasNodes(): boolean {
		return this.nodes.length > 0;
	}

	invalidate(): void {
		// Rendering is derived from the nodes set above.
	}

	render(width: number): string[] {
		if (this.nodes.length === 0) {
			return [];
		}
		const safeWidth = Math.max(1, width);
		const visible = this.nodes.slice(0, MAX_VISIBLE);
		const hidden = this.nodes.length - visible.length;
		const icon = theme.fg("accent", workingIconFrame(getWorkingPulseFrame()));

		// Leading blank line so the tree doesn't hug the tool call/output above it.
		const lines: string[] = [""];
		lines.push(truncateToWidth(`${PAD}${this.header()}`, safeWidth));
		for (const [index, node] of visible.entries()) {
			const isLast = index === visible.length - 1 && hidden === 0;
			this.renderNode(lines, node, isLast, icon, safeWidth);
		}
		if (hidden > 0) {
			lines.push(truncateToWidth(`${PAD}  ${theme.fg("muted", `+${hidden} more`)}`, safeWidth));
		}
		return lines;
	}

	private header(): string {
		const count = this.nodes.length;
		const noun = count === 1 ? "agent" : "agents";
		return theme.fg("text", `Running ${count} ${noun}…`);
	}

	private renderNode(
		lines: string[],
		node: ChildAgentInspectorNode,
		isLast: boolean,
		icon: string,
		width: number,
	): void {
		const edge = theme.fg("text", `${isLast ? "└" : "├"} `);
		lines.push(truncateToWidth(`${PAD}${edge}${icon} ${this.nodeSummary(node)}`, width));

		// Always a second line: the recap once we have it, else a live activity label
		// (mirroring the main agent's "Writing code" / "Executing" status) so the row
		// is never blank while we wait for the recap.
		const childEdge = theme.fg("text", isLast ? "  " : "│ ");
		const connector = theme.fg("dim", "└ ");
		const prefix = `${PAD}${childEdge}${connector}`;
		const detail = node.recap?.trim() || nodeActivityLabel(node);
		const text = truncateToWidth(detail, Math.max(1, width - visibleWidth(prefix)));
		lines.push(`${prefix}${theme.fg("dim", text)}`);
	}

	private nodeSummary(node: ChildAgentInspectorNode): string {
		const parts = [theme.fg("text", compactLabel(node.label))];
		const meta: string[] = [];
		if (node.toolUseCount && node.toolUseCount > 0) {
			meta.push(`${node.toolUseCount} ${node.toolUseCount === 1 ? "tool use" : "tool uses"}`);
		}
		if (node.tokenCount && node.tokenCount > 0) {
			meta.push(`${formatTokenCount(node.tokenCount)} tokens`);
		}
		if (meta.length > 0) {
			parts.push(theme.fg("muted", `· ${meta.join(" · ")}`));
		}
		return parts.join(" ");
	}
}

/** First few words of the prompt, clipped to a sensible width with an ellipsis. */
function compactLabel(label: string): string {
	const words = label.trim().split(/\s+/);
	let compact = words.slice(0, LABEL_MAX_WORDS).join(" ");
	const clipped = words.length > LABEL_MAX_WORDS;
	if (compact.length > LABEL_MAX_CHARS) {
		compact = compact.slice(0, LABEL_MAX_CHARS).trimEnd();
		return `${compact}…`;
	}
	return clipped ? `${compact}…` : compact;
}
