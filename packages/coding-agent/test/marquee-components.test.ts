import type { AssistantMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import { type Component, setKeybindings, TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import {
	ChildAgentDetailComponent,
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
		setKeybindings(new KeybindingsManager());
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
		// Collapsed: marker + the bash command + duration + error name, on one line.
		expect(collapsed).toContain("bash");
		expect(collapsed).toContain("echo hi");
		expect(collapsed).not.toContain("%%bash");
		expect(collapsed).toContain("1.2s");
		expect(collapsed).toContain("ValueError");
		expect(collapsed).not.toContain("ValueError: bad");
		expect(collapsed).not.toContain("ipython");
		expect(collapsed).toContain("Ctrl+O to expand");
		expect(collapsed).not.toContain("traceback collapsed");
		expect(collapsed).not.toContain('File "<stdin>"');

		component.update({ ...state, expanded: true });
		const expanded = await renderInVirtualTerminal(component);
		expect(expanded).toContain("Traceback (most recent call last):");
		expect(expanded).toContain('File "<stdin>"');

		for (const line of component.render(44)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(44);
		}
	});

	test("renders structured ipython bash errors with traceback details collapsed", async () => {
		const traceback = [
			"Traceback (most recent call last):",
			"  Cell In[15], line 1",
			"----> 1 get_ipython().run_cell_magic('bash', '', 'cat /tmp/missing-file\\n')",
			"CalledProcessError: Command 'cat /tmp/missing-file' returned non-zero exit status 1.",
		];
		const state: IPythonCellState = {
			code: "%%bash\ncat /tmp/missing-file",
			content: [
				{
					type: "text",
					text: ["cat: /tmp/missing-file: No such file or directory", ...traceback].join("\n"),
				},
			],
			details: {
				status: "error",
				durationMs: 29,
				stdout: "",
				stderr: "cat: /tmp/missing-file: No such file or directory\n",
				error: {
					ename: "CalledProcessError",
					evalue: "Command 'cat /tmp/missing-file' returned non-zero exit status 1.",
					traceback,
				},
			},
			isError: true,
			expanded: false,
			executionStarted: true,
			argsComplete: true,
		};
		const component = new IPythonCellComponent(state);

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("cat /tmp/missing-file");
		expect(collapsed).toContain("CalledProcessError · Ctrl+O to expand");
		expect(collapsed).not.toContain("No such file or directory");
		expect(collapsed).not.toContain("returned non-zero exit status 1.");
		expect(collapsed).not.toContain("traceback collapsed");
		expect(collapsed).not.toContain("get_ipython().run_cell_magic");
		expect(collapsed).not.toContain("Cell In[15]");

		component.update({ ...state, expanded: true });
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("get_ipython().run_cell_magic");
		expect(expanded).toContain("Cell In[15]");
	});

	test("keeps ipython stack frame locations out of collapsed traceback previews", () => {
		const state: IPythonCellState = {
			code: "run_job()",
			content: [
				{
					type: "text",
					text: [
						"Traceback (most recent call last):",
						'  File "/tmp/internal.py", line 12, in run',
						"    run_job()",
					].join("\n"),
				},
			],
			details: { status: "error", errorEname: "RuntimeError" },
			isError: true,
			expanded: false,
			executionStarted: true,
			argsComplete: true,
		};
		const component = new IPythonCellComponent(state);

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("RuntimeError · Ctrl+O to expand");
		expect(collapsed).not.toContain("no output");
		expect(collapsed).not.toContain("/tmp/internal.py");
		expect(collapsed).not.toContain("line 12");
	});

	test("caches ipython cell renders until state, width, or invalidation changes", () => {
		const state: IPythonCellState = {
			code: "value = 1\nprint(value)",
			content: [{ type: "text", text: "1" }],
			details: { status: "ok", durationMs: 15 },
			executionStarted: true,
			argsComplete: true,
		};
		const component = new IPythonCellComponent(state);

		const first = component.render(80);
		expect(component.render(80)).toBe(first);

		component.update(state);
		const afterSameStateUpdate = component.render(80);
		expect(afterSameStateUpdate).not.toBe(first);
		expect(afterSameStateUpdate).toEqual(first);
		expect(component.render(80)).toBe(afterSameStateUpdate);

		component.invalidate();
		const afterInvalidate = component.render(80);
		expect(afterInvalidate).not.toBe(afterSameStateUpdate);
		expect(afterInvalidate).toEqual(afterSameStateUpdate);
		expect(component.render(80)).toBe(afterInvalidate);
	});

	test("collapses long ipython input until tool expansion is enabled", () => {
		const code = Array.from({ length: 8 }, (_, index) => `line_${index} = ${index}`).join("\n");
		const state: IPythonCellState = {
			code,
			content: [{ type: "text", text: "done" }],
			details: { status: "ok", durationMs: 15 },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		};
		const component = new IPythonCellComponent(state);

		const collapsed = stripAnsi(component.render(100).join("\n"));
		// Collapsed python shows a one-line preview, the input line count, and the expand hint.
		expect(collapsed).toContain("line_0 = 0");
		expect(collapsed).not.toContain("line_7 = 7");
		expect(collapsed).toContain("↑ 8");
		expect(collapsed.match(/to expand/g)?.length).toBe(1);

		component.update({ ...state, expanded: true });
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("line_0 = 0");
		expect(expanded).toContain("line_7 = 7");
	});

	test("shows one expand hint when ipython input and output are both collapsed", () => {
		const code = Array.from({ length: 8 }, (_, index) => `line_${index} = ${index}`).join("\n");
		const output = Array.from({ length: 8 }, (_, index) => `out_${index}`).join("\n");
		const component = new IPythonCellComponent({
			code,
			content: [{ type: "text", text: output }],
			details: { status: "ok", durationMs: 15 },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});

		const collapsed = stripAnsi(component.render(100).join("\n"));
		// A single status line carries both counts and exactly one expand hint.
		expect(collapsed).toContain("↑ 8 ↓ 8 lines");
		expect(collapsed.match(/to expand/g)?.length).toBe(1);
	});

	test("reflows cached ipython cells when terminal width changes", () => {
		const state: IPythonCellState = {
			code: "result = 'this is a deliberately long line that should wrap differently by terminal width'",
			content: [
				{
					type: "text",
					text: "this output line is also deliberately long so the rendered panel must reflow on resize",
				},
			],
			details: { status: "ok", durationMs: 15 },
			executionStarted: true,
			argsComplete: true,
			// Expanded so the long code/output lines wrap and reflow with width.
			expanded: true,
		};
		const component = new IPythonCellComponent(state);

		const narrow = component.render(36);
		expect(component.render(36)).toBe(narrow);
		for (const line of narrow) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(36);
		}

		const wide = component.render(80);
		expect(wide).not.toBe(narrow);
		expect(wide.length).toBeLessThan(narrow.length);
		for (const line of wide) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		expect(component.render(80)).toBe(wide);
	});

	test("invalidates ipython cell cache when expanded state changes", () => {
		const state: IPythonCellState = {
			code: "raise ValueError('bad')",
			content: [
				{
					type: "text",
					text: 'before\nTraceback (most recent call last):\n  File "<stdin>", line 1\nValueError: bad',
				},
			],
			details: { status: "error", errorEname: "ValueError" },
			isError: true,
			expanded: false,
			executionStarted: true,
			argsComplete: true,
		};
		const component = new IPythonCellComponent(state);

		const collapsed = component.render(100);
		const collapsedText = stripAnsi(collapsed.join("\n"));
		expect(collapsedText).toContain("Ctrl+O to expand");
		expect(collapsedText).not.toContain("traceback collapsed");
		expect(collapsedText).not.toContain('File "<stdin>"');

		component.update({ ...state, expanded: true });
		const expanded = component.render(100);
		expect(expanded).not.toBe(collapsed);
		const expandedText = stripAnsi(expanded.join("\n"));
		expect(expandedText).toContain("Traceback (most recent call last):");
		expect(expandedText).toContain('File "<stdin>"');
		expect(component.render(100)).toBe(expanded);
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

	test("renders assistant thinking as quiet text without background styling", () => {
		const component = new AssistantMessageComponent(
			createAssistantMessage("answer", "Check **bold** and `code` first.\n```ts\nconst value = 1;\n```"),
		);

		const rendered = component.render(80).join("\n");
		const plain = stripAnsi(rendered);

		expect(plain).toContain("Check bold and code first.");
		expect(plain).not.toContain("**bold**");
		expect(plain).not.toContain("`code`");
		expect(plain).not.toContain("```ts");
		expect(plain).toContain("const value = 1;");
		expect(rendered).not.toMatch(/\x1b\[(?:4\d|10\d|48;)/);
	});

	test("collapses multiline assistant errors without changing short errors", () => {
		const multilineError = [
			"Provider request failed",
			"Traceback (most recent call last):",
			'  File "/tmp/internal.py", line 12, in run',
			"RuntimeError: backend crashed",
		].join("\n");
		const message: AssistantMessage = {
			...createAssistantMessage(""),
			content: [],
			stopReason: "error",
			errorMessage: multilineError,
		};
		const component = new AssistantMessageComponent(message);

		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("Error: Provider request failed");
		expect(collapsed).toContain("Ctrl+O to expand");
		expect(collapsed).not.toContain("error details collapsed");
		expect(collapsed).not.toContain("/tmp/internal.py");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(100).join("\n"));
		expect(expanded).toContain("/tmp/internal.py");

		const tracebackFirstMessage: AssistantMessage = {
			...createAssistantMessage(""),
			content: [],
			stopReason: "error",
			errorMessage: [
				"Traceback (most recent call last):",
				'  File "/tmp/internal.py", line 12, in run',
				"RuntimeError: backend crashed",
			].join("\n"),
		};
		const tracebackFirstComponent = new AssistantMessageComponent(tracebackFirstMessage);
		const tracebackFirstCollapsed = stripAnsi(tracebackFirstComponent.render(100).join("\n"));
		expect(tracebackFirstCollapsed).toContain("Error: RuntimeError: backend crashed");
		expect(tracebackFirstCollapsed).not.toContain("Traceback (most recent call last):");
		expect(tracebackFirstCollapsed).not.toContain("/tmp/internal.py");

		const frameFirstMessage: AssistantMessage = {
			...createAssistantMessage(""),
			content: [],
			stopReason: "error",
			errorMessage: ['  File "/tmp/internal.py", line 12, in run', "RuntimeError: backend crashed"].join("\n"),
		};
		const frameFirstComponent = new AssistantMessageComponent(frameFirstMessage);
		const frameFirstCollapsed = stripAnsi(frameFirstComponent.render(100).join("\n"));
		expect(frameFirstCollapsed).toContain("Error: RuntimeError: backend crashed");
		expect(frameFirstCollapsed).not.toContain("/tmp/internal.py");
		expect(frameFirstCollapsed).not.toContain("line 12");

		const shortMessage: AssistantMessage = {
			...createAssistantMessage(""),
			content: [],
			stopReason: "error",
			errorMessage: "provider failure",
		};
		const shortComponent = new AssistantMessageComponent(shortMessage);
		const short = stripAnsi(shortComponent.render(100).join("\n"));
		expect(short).toContain("Error: provider failure");
		expect(short).not.toContain("error details collapsed");
		expect(short).not.toContain("Ctrl+O to expand");
	});

	test("renders child agent summary inline list and detail view", () => {
		const summary = new ChildAgentSummaryComponent(
			() => "agents-sidebar",
			() => "37% context left",
		);
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

		// The info line carries location/context; the list renders the subagents
		// below a separator, with the time pinned at the right edge.
		const summaryLines = summary.render(90).map(stripAnsi);
		const summaryText = summaryLines.join("\n");
		expect(summaryText).toContain("agents-sidebar");
		expect(summaryText).toContain("37% context left");
		expect(summaryText).toContain("Subagent 1");
		expect(summaryText).toContain("inspect training logs");
		expect(summaryLines.some((line) => line.includes("─"))).toBe(true);
		const infoRow = summary.render(90)[0] ?? "";
		expect(visibleWidth(infoRow)).toBe(90);

		summary.focused = true;
		let openedNodeId: string | undefined;
		summary.onOpenDetail = (nodeId) => {
			openedNodeId = nodeId;
		};
		// Right opens the selected subagent, like Enter.
		summary.handleInput("\x1b[C");
		expect(openedNodeId).toBe("sub-a");

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
		expect(detail).toContain("← back to chat");
		expect(detail).not.toContain("user: inspect training logs");
		expect(detail).not.toContain("assistant: reading shard metrics");
		expect(detail).not.toContain("tool: bash");
	});

	test("collapses multiline child agent system errors in detail view", () => {
		const detailComponent = new ChildAgentDetailComponent(() => 20);
		const errorText = [
			"ChildProcessError: child exited with status 1",
			"Traceback (most recent call last):",
			'  File "/tmp/rlm_harness/internal.py", line 10, in run',
			"ChildProcessError: child exited with status 1",
		].join("\n");
		detailComponent.setNode({
			id: "sub-error",
			label: "inspect failure",
			status: "error",
			sessionDir: "/tmp/session/sub-error",
			transcript: [],
			structuredTranscript: [{ type: "system", role: "system", text: errorText }],
		});

		const collapsed = stripAnsi(detailComponent.render(100).join("\n"));
		expect(collapsed).toContain("ChildProcessError: child exited with status 1");
		expect(collapsed).toContain("Ctrl+O to expand");
		expect(collapsed).not.toContain("error details collapsed");
		expect(collapsed).not.toContain("/tmp/rlm_harness/internal.py");

		detailComponent.setToolsExpanded(true);
		const expanded = stripAnsi(detailComponent.render(100).join("\n"));
		expect(expanded).toContain("/tmp/rlm_harness/internal.py");
	});

	test("keeps child agent assistant errors expanded after transcript rebuilds", () => {
		const detailComponent = new ChildAgentDetailComponent(() => 20);
		detailComponent.setToolsExpanded(true);
		const assistantError: AssistantMessage = {
			...createAssistantMessage(""),
			content: [],
			stopReason: "error",
			errorMessage: [
				"Provider request failed",
				"Traceback (most recent call last):",
				'  File "/tmp/internal.py", line 12, in run',
				"RuntimeError: backend crashed",
			].join("\n"),
		};
		detailComponent.setNode({
			id: "sub-assistant-error",
			label: "inspect failure",
			status: "error",
			sessionDir: "/tmp/session/sub-assistant-error",
			transcript: [],
			structuredTranscript: [
				{
					type: "message",
					role: "assistant",
					text: assistantError.errorMessage ?? "",
					message: assistantError,
				},
			],
		});

		const expanded = stripAnsi(detailComponent.render(100).join("\n"));
		expect(expanded).toContain("/tmp/internal.py");
		expect(expanded).not.toContain("Ctrl+O to expand");

		detailComponent.invalidate();
		const afterInvalidate = stripAnsi(detailComponent.render(100).join("\n"));
		expect(afterInvalidate).toContain("/tmp/internal.py");
		expect(afterInvalidate).not.toContain("Ctrl+O to expand");
	});

	test("routes child agent detail tool expansion through app keybindings", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+x" }));
		try {
			const detailComponent = new ChildAgentDetailComponent(() => 20);
			let toggleCount = 0;
			detailComponent.onToggleToolsExpanded = () => {
				toggleCount += 1;
			};
			detailComponent.setNode({
				id: "sub-a",
				label: "inspect training logs",
				status: "running",
				sessionDir: "/tmp/session/sub-a",
				transcript: [],
				structuredTranscript: [
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
			});

			const before = stripAnsi(detailComponent.render(80).join("\n"));
			expect(before).toContain("Ctrl+X to expand");
			detailComponent.handleInput("\x18");

			expect(toggleCount).toBe(1);
			detailComponent.setToolsExpanded(true);
			const after = stripAnsi(detailComponent.render(80).join("\n"));
			expect(after).toContain("Ctrl+X to collapse");
		} finally {
			setKeybindings(new KeybindingsManager());
		}
	});

	test("keeps child agent summary visible when the right tray label is long", () => {
		const summary = new ChildAgentSummaryComponent(
			() => undefined,
			() => "Pursuing goal (1m 05s) · 25% context left",
		);
		summary.setNodes([
			{
				id: "sub-a",
				label: "inspect training logs",
				status: "running",
				sessionDir: "/tmp/session/sub-a",
				transcript: [],
			},
		]);

		const lines = summary.render(32);
		const infoRow = lines[0] ?? "";

		expect(visibleWidth(infoRow)).toBe(32);
		expect(stripAnsi(infoRow)).toContain("Pursuing goal");
		// The subagent itself renders as a list row below the info line.
		expect(stripAnsi(lines.join("\n"))).toContain("Subagent 1");
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
		expect(first).toContain("← back to chat");
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

		// Collapsed: routed through the cell renderer (a status line), not the
		// generic JSON arg dump.
		const collapsed = stripAnsi(component.render(100).join("\n"));
		expect(collapsed).toContain("python");
		expect(collapsed).toContain("12ms");
		expect(collapsed).not.toContain("ipython");
		expect(collapsed).not.toContain('"code"');

		// Expanded: full panel with the code and output on the panel background.
		component.setExpanded(true);
		const rawOutput = component.render(100).join("\n");
		expect(rawOutput).toMatch(/\x1b\[48;(?:2|5);/);
		const panelLine = component.render(100).find((line) => line.includes("\x1b[48;")) ?? "";
		expect(panelLine.startsWith("\x1b[48;")).toBe(true);
		expect(panelLine.endsWith("\x1b[49m")).toBe(true);
		expect(visibleWidth(panelLine)).toBe(100);
		const expanded = stripAnsi(rawOutput);
		expect(expanded).toContain("print(55)");
		expect(expanded).toContain("55");
		expect(expanded).not.toContain('"code"');
	});
});
