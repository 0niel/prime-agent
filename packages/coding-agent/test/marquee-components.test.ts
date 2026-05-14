import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { type Component, TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import {
	ChildAgentDetailComponent,
	ChildAgentInspectorComponent,
	type ChildAgentInspectorNode,
	ChildAgentSummaryComponent,
} from "../src/modes/interactive/components/child-agent-inspector.js";
import { IPythonCellComponent, type IPythonCellState } from "../src/modes/interactive/components/ipython-cell.js";
import { SubAgentTreeComponent } from "../src/modes/interactive/components/sub-agent-tree.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class HostComponent implements Component {
	constructor(private child: Component) {}

	render(width: number): string[] {
		return this.child.render(width);
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

function createAssistantMessage(text: string, thinking?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [...(thinking ? [{ type: "thinking" as const, thinking }] : []), { type: "text", text }],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

async function renderInVirtualTerminal(component: Component, width = 100, height = 30): Promise<string> {
	const terminal = new VirtualTerminal(width, height);
	const tui = new TUI(terminal);
	tui.addChild(new HostComponent(component));
	tui.start();
	await terminal.waitForRender();
	const output = stripAnsi(terminal.getScrollBuffer().join("\n"));
	tui.stop();
	return output;
}

describe("marquee TUI components", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders ipython cells with shell magic and collapsed traceback", async () => {
		const state: IPythonCellState = {
			code: "%%bash\necho hi",
			content: [
				{
					type: "text",
					text: 'hi\nTraceback (most recent call last):\n  File "<stdin>", line 1\nValueError: bad',
				},
			],
			details: { status: "error", durationMs: 1234, errorEname: "ValueError" },
			isError: true,
			expanded: false,
			executionStarted: true,
			argsComplete: true,
			showImages: true,
		};
		const component = new IPythonCellComponent(state);

		const collapsed = await renderInVirtualTerminal(component);
		expect(collapsed).toContain("error · 1.2s");
		expect(collapsed).not.toContain("ipython");
		expect(collapsed).toContain("%%bash");
		expect(collapsed).toContain("hi");
		expect(collapsed).toContain("ValueError: bad");
		expect(collapsed).toContain("traceback collapsed");
		expect(collapsed).not.toContain('File "<stdin>"');

		component.update({ ...state, expanded: true });
		const expanded = await renderInVirtualTerminal(component);
		expect(expanded).toContain("Traceback (most recent call last):");
		expect(expanded).toContain('File "<stdin>"');

		for (const line of component.render(44)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(44);
		}
	});

	test("renders sub-agent tree nodes with status, previews, and transcript expansion", async () => {
		const component = new SubAgentTreeComponent({
			rootLabel: "root: triage logs",
			nodes: [
				{
					id: "shard-0",
					label: "shard-0",
					status: "done",
					durationMs: 12300,
					tokenCount: 4200,
					costUsd: 0.25,
					answerPreview: "no anomaly, normal loss curve",
					transcript: [{ role: "assistant", text: "no anomaly found in this shard" }],
				},
				{
					id: "shard-1",
					label: "shard-1",
					status: "running",
					durationMs: 7800,
				},
				{
					id: "shard-2",
					label: "shard-2",
					status: "done",
					durationMs: 11100,
					tokenCount: 4700,
					answerPreview: "NaN at step 2103",
				},
			],
		});

		const collapsed = await renderInVirtualTerminal(component);
		expect(collapsed).toContain("root: triage logs");
		expect(collapsed).toContain(' ├─ done shard-0 · 12.3s · "no anomaly, normal loss curve"');
		expect(collapsed).toContain(" ├─ running shard-1 · 7.8s");
		expect(collapsed).toContain(' └─ done shard-2 · 11.1s · "NaN at step 2103"');
		expect(collapsed).not.toContain("tok");
		expect(collapsed).not.toContain("$0.25");
		expect(collapsed).not.toContain("no anomaly found in this shard");

		component.setExpanded("shard-0", true);
		const expanded = await renderInVirtualTerminal(component);
		expect(expanded).toContain("assistant: no anomaly found in this shard");
	});

	test("renders child agent summary and bounded inspector list", () => {
		const summary = new ChildAgentSummaryComponent(
			() => "agents-sidebar",
			() => "37% context left",
		);
		const component = new ChildAgentInspectorComponent();
		const node: ChildAgentInspectorNode = {
			id: "sub-a",
			label: "inspect training logs",
			status: "running",
			sessionDir: "/tmp/session/sub-a",
			transcript: [
				{ role: "user", text: "inspect training logs" },
				{ role: "assistant", text: "reading shard metrics" },
				{ role: "tool", text: "bash: hi" },
			],
			structuredTranscript: [
				{
					type: "message",
					role: "user",
					text: "inspect training logs",
					message: createUserMessage("inspect training logs"),
				},
				{
					type: "message",
					role: "assistant",
					text: "reading shard metrics",
					message: createAssistantMessage("reading shard metrics", "checking loss curve"),
				},
				{
					type: "tool",
					role: "tool",
					text: "bash: hi",
					toolCallId: "tool-sub-a",
					toolName: "bash",
					args: { command: "echo hi" },
					result: {
						content: [{ type: "text", text: "hi" }],
						isError: false,
					},
					isPartial: false,
					executionStarted: true,
					argsComplete: true,
				},
			],
			children: [
				{
					id: "sub-b",
					label: "check shard 2",
					status: "done",
					sessionDir: "/tmp/session/sub-b",
					transcript: [{ role: "assistant", text: "no anomaly" }],
				},
			],
		};
		summary.setNodes([node]);
		component.setNodes([node]);

		const summaryText = stripAnsi(summary.render(60).join("\n"));
		expect(summaryText).toContain("agents-sidebar");
		expect(summaryText).toContain("37% context left");
		expect(summaryText).toContain("1 subagent running");
		expect(summaryText).not.toContain("2 total");
		expect(summary.render(60)).toHaveLength(1);

		summary.focused = true;
		const focusedSummary = stripAnsi(summary.render(60).join("\n"));
		expect(focusedSummary).toContain("agents-sidebar");
		expect(focusedSummary).toContain("37% context left");
		expect(focusedSummary).toContain("1 subagent running");
		expect(focusedSummary).not.toContain("▌");
		const summaryRow = summary.render(60).at(-1) ?? "";
		expect(visibleWidth(summaryRow)).toBe(60);
		expect(stripAnsi(summaryRow).endsWith("37% context left")).toBe(true);

		const queueSummary = new ChildAgentSummaryComponent(
			() => "agents-sidebar",
			() => "37% context left",
			() => "alt+enter to queue message",
		);
		queueSummary.setNodes([node]);
		const queueText = stripAnsi(queueSummary.render(60).join("\n"));
		expect(queueText).toContain("alt+enter to queue message");
		expect(queueText).toContain("37% context left");
		expect(queueText).not.toContain("1 subagent running");
		expect(queueSummary.render(60)).toHaveLength(1);

		const compact = stripAnsi(component.render(42).join("\n"));
		expect(compact).toContain("subagents");
		expect(compact).toContain("─");
		expect(visibleWidth(component.render(42)[0] ?? "")).toBe(42);
		expect(compact).toContain("1 running · 2 total");
		expect(compact).toContain("running · inspect training logs");
		expect(compact).toContain("done · check shard 2");
		expect(compact).not.toContain("└─");
		expect(compact).not.toContain("├─");
		expect(compact).not.toContain("assistant: reading shard metrics");
		for (const line of component.render(96)) {
			expect(visibleWidth(line)).toBe(96);
		}

		component.focused = true;
		const focused = stripAnsi(component.render(42).join("\n"));
		expect(focused).toContain("▌ running · inspect training logs");
		expect(focused).not.toContain("assistant: reading shard metrics");

		let openedNodeId: string | undefined;
		component.onOpenDetail = (nodeId) => {
			openedNodeId = nodeId;
		};
		component.handleInput("\r");
		expect(openedNodeId).toBe("sub-a");
		expect(stripAnsi(component.render(42).join("\n"))).not.toContain("assistant: reading shard metrics");

		const detailComponent = new ChildAgentDetailComponent(() => 20);
		detailComponent.setNode(node);
		const detailLines = detailComponent.render(42);
		const detail = stripAnsi(detailLines.join("\n"));
		expect(detail).toContain("running inspect training logs");
		expect(detail).toContain("sub-a");
		expect(detail).toContain("inspect training logs");
		expect(detail).toContain("checking loss curve");
		expect(detail).toContain("reading shard metrics");
		expect(detail).toContain("$ echo hi");
		expect(detail).toContain("hi");
		expect(detail).not.toContain("user: inspect training logs");
		expect(detail).not.toContain("assistant: reading shard metrics");
		expect(detail).not.toContain("tool: bash");

		component.handleInput("\x1b");
		const returned = stripAnsi(component.render(42).join("\n"));
		expect(returned).toContain("▌ running · inspect training logs");
		expect(returned).not.toContain("assistant: reading shard metrics");

		for (const line of component.render(42)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(42);
		}

		const narrow = stripAnsi(component.render(24).join("\n"));
		expect(narrow).toContain("inspect t…");
	});

	test("renders full child agent detail without internal scroll controls", () => {
		const detailComponent = new ChildAgentDetailComponent(() => 6);
		detailComponent.setNode({
			id: "sub-scroll",
			label: "inspect long output",
			status: "done",
			sessionDir: "/tmp/session/sub-scroll",
			transcript: Array.from({ length: 12 }, (_, index) => ({
				role: "assistant" as const,
				text: `fallback transcript row ${String(index + 1).padStart(2, "0")}`,
			})),
		});

		const firstLines = detailComponent.render(48);
		const first = stripAnsi(firstLines.join("\n"));
		expect(first).toContain("fallback transcript row 01");
		expect(first).toContain("fallback transcript row 12");
		expect(first).not.toContain("↑");
		expect(first).not.toContain("↓");
		expect(firstLines.length).toBeGreaterThan(6);
	});

	test("routes built-in ipython tool rows through the cell renderer", () => {
		const component = new ToolExecutionComponent(
			"ipython",
			"tool-1",
			{ code: "print(55)" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult({
			content: [{ type: "text", text: "55" }],
			details: { status: "ok", durationMs: 12 },
			isError: false,
		});

		const output = stripAnsi(component.render(100).join("\n"));
		expect(output).toContain("done · 12ms");
		expect(output).not.toContain("ipython");
		expect(output).toContain("print(55)");
		expect(output).toContain("55");
		expect(output).not.toContain('"code"');
	});
});
