import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type ChildAgentInspectorNode,
	ChildAgentSummaryComponent,
} from "../src/modes/interactive/components/child-agent-inspector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { setWorkingPulseFrame, workingIconFrame } from "../src/modes/interactive/theme/working-icon.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function node(id: string, status: ChildAgentInspectorNode["status"] = "running"): ChildAgentInspectorNode {
	return { id, label: id, status, sessionDir: `/tmp/${id}` };
}

describe("ChildAgentSummaryComponent inline list", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders one row per subagent when within the cap", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([node("alpha"), node("beta")]);
		const out = stripAnsi(summary.render(80).join("\n"));
		expect(out).toContain("alpha");
		expect(out).toContain("beta");
		expect(out).not.toMatch(/more (above|below)/);
	});

	it("caps the list at five rows and shows a scroll indicator", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([node("a"), node("b"), node("c"), node("d"), node("e"), node("f"), node("g")]);
		const lines = summary.render(80).map(stripAnsi);
		// Row lines carry a status glyph; the scroll-hint line does not.
		const rowLines = lines.filter((line) => /[◇◈◆✓✗]/.test(line));
		expect(rowLines.length).toBe(5);
		expect(lines.join("\n")).toContain("2 below");
	});

	it("scrolls the window and updates the indicator as selection moves down", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.focused = true;
		summary.setNodes([node("a"), node("b"), node("c"), node("d"), node("e"), node("f"), node("g")]);
		// Drive selection past the initial window via the down key.
		for (let i = 0; i < 6; i++) {
			summary.handleInput("\x1b[B");
		}
		const out = summary.render(80).map(stripAnsi).join("\n");
		expect(out).toContain("g");
		expect(out).toContain("above");
	});

	it("animates the running row glyph across pulse frames", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([node("a", "running")]);
		setWorkingPulseFrame(0);
		const frame0 = stripAnsi(summary.render(80).join("\n"));
		setWorkingPulseFrame(1);
		const frame1 = stripAnsi(summary.render(80).join("\n"));
		expect(frame0).toContain(workingIconFrame(0));
		expect(frame1).toContain(workingIconFrame(1));
		expect(frame0).not.toBe(frame1);
	});

	it("can reselect a node by id when returning from its detail view", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.focused = true;
		summary.setNodes([node("a"), node("b"), node("c")]);
		summary.selectNode("c");
		let opened: string | undefined;
		summary.onOpenDetail = (id) => {
			opened = id;
		};
		summary.handleInput("\r");
		expect(opened).toBe("c");
	});

	it("prefixes rows with a fixed-width Subagent N column", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([node("first task"), node("second task")]);
		const out = stripAnsi(summary.render(80).join("\n"));
		expect(out).toContain("Subagent 1");
		expect(out).toContain("Subagent 2");
	});

	it("never exceeds the row width with wide (CJK) characters", () => {
		const wide = "実行するタスクは非常に長い説明を含んでいてこれは折り返しのテストです".repeat(3);
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([{ ...node("a"), label: wide }]);
		for (const width of [40, 60, 80]) {
			for (const line of summary.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("elides a shared prompt prefix so rows surface where they differ", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([
			{ ...node("a"), label: "Refactor the authentication module for tokens" },
			{ ...node("b"), label: "Refactor the authentication module for refresh" },
		]);
		const out = stripAnsi(summary.render(120).join("\n"));
		// The shared prefix is replaced by an ellipsis; the differing tail survives.
		expect(out).toContain("…");
		expect(out).not.toContain("Refactor the authentication module for tokens");
	});

	it("surfaces the divergence even when the shared prefix is very long", () => {
		const prefix = "You are a sleeper subagent in a parallel batch. Please sleep for exactly ";
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([
			{ ...node("a"), label: `${prefix}30 seconds then report done` },
			{ ...node("b"), label: `${prefix}120 seconds then report done` },
		]);
		const out = stripAnsi(summary.render(130).join("\n"));
		expect(out).toContain("30 seconds");
		expect(out).toContain("120 seconds");
	});

	it("windows tightly around the diff when prompts share a head and tail", () => {
		const head =
			"Hello there. You are a subagent and we give subagents different tasks. Your task is to sleep since you are subagent ";
		const tail = " and therefore you were assigned to sleep ten minutes total today";
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([
			{ ...node("a"), label: `${head}#1${tail}` },
			{ ...node("b"), label: `${head}#2${tail}` },
		]);
		const out = stripAnsi(summary.render(120).join("\n"));
		expect(out).toContain("#1");
		expect(out).toContain("#2");
		// The shared tail is dropped behind a trailing ellipsis, not shown in full.
		expect(out).not.toContain("assigned to sleep ten minutes total today");
	});

	it("forwards unhandled keys to the chat action callback", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.focused = true;
		summary.setNodes([node("a")]);
		let forwarded: string | undefined;
		summary.onChatAction = (data) => {
			forwarded = data;
		};
		// Ctrl+O isn't a list key, so it should bubble to the chat action handler.
		summary.handleInput("\x0f");
		expect(forwarded).toBe("\x0f");
	});

	it("opens the selected subagent's detail on confirm", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.focused = true;
		summary.setNodes([node("a"), node("b")]);
		let opened: string | undefined;
		summary.onOpenDetail = (id) => {
			opened = id;
		};
		summary.handleInput("\r");
		expect(opened).toBe("a");
	});

	it("falls back to onOpen when confirm is pressed with no selection", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.focused = true;
		summary.setNodes([]); // list emptied while focused: no selection
		let fellBack = false;
		summary.onOpen = () => {
			fellBack = true;
		};
		summary.handleInput("\r");
		expect(fellBack).toBe(true);
	});
});
