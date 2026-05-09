import { type Component, TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
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
		expect(collapsed).toContain("ipython error 1.2s");
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

	test("renders sub-agent tree nodes with status, costs, previews, and transcript expansion", async () => {
		const component = new SubAgentTreeComponent({
			rootLabel: "root: triage logs",
			nodes: [
				{
					id: "shard-0",
					label: "shard-0",
					status: "done",
					durationMs: 12300,
					tokenCount: 4200,
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
		expect(collapsed).toContain("root: triage logs 8.9k tok");
		expect(collapsed).toContain('[done] shard-0 (12.3s, 4.2k tok) -> "no anomaly, normal loss curve"');
		expect(collapsed).toContain("[running] shard-1 (7.8s, ... tok)");
		expect(collapsed).toContain('[done] shard-2 (11.1s, 4.7k tok) -> "NaN at step 2103"');
		expect(collapsed).not.toContain("no anomaly found in this shard");

		component.setExpanded("shard-0", true);
		const expanded = await renderInVirtualTerminal(component);
		expect(expanded).toContain("assistant: no anomaly found in this shard");
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
		expect(output).toContain("ipython done 12ms");
		expect(output).toContain("print(55)");
		expect(output).toContain("55");
		expect(output).not.toContain('"code"');
	});
});
