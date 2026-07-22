import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	ChildAgentDetailComponent,
	type ChildAgentInspectorNode,
	ChildAgentSummaryComponent,
} from "../src/modes/interactive/components/child-agent-inspector.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
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
		setKeybindings(new KeybindingsManager());
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

	it("keeps the active agents visible when a previously selected agent finishes", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([node("a"), node("b"), node("c"), node("d"), node("e"), node("f")]);
		summary.selectNode("a");
		summary.setNodes([node("a", "done"), node("b"), node("c"), node("d"), node("e"), node("f")]);
		const out = summary.render(80).map(stripAnsi).join("\n");
		expect(out).toContain("b");
		expect(out).toContain("f");
		expect(out).not.toContain(" a ");
	});

	it("shows cancellation instead of stale activity in summary and detail", () => {
		const cancelled = {
			...node("cancelled task", "cancelled"),
			recap: "Executing a stale task",
			hasActiveHeartbeat: true,
		};
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([cancelled]);
		const detail = new ChildAgentDetailComponent();
		detail.setNode(cancelled);

		const output = stripAnsi([...summary.render(80), ...detail.render(80)].join("\n"));
		expect(output).toContain("Cancelled");
		expect(output).not.toContain("Executing a stale task");
	});

	it("shows the model and token usage without a tool column", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([{ ...node("a"), model: "openai/gpt-5.4", toolUseCount: 3, tokenCount: 41_000 }]);
		const out = stripAnsi(summary.render(80).join("\n"));
		expect(out).toContain("GPT-5.4");
		expect(out).not.toContain("openai/gpt-5.4");
		expect(out).toContain("41k tok");
		expect(out).not.toContain("tools");
	});

	it("preserves nested model ids when the label is truncated", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([{ ...node("a"), model: "prime-inference/internal/glm-5.2-fast" }]);
		const out = stripAnsi(summary.render(80).join("\n"));
		expect(out).toContain("intern…/glm-5.2-fast");
		expect(out).not.toContain("prime-inference");
	});

	it("shows recaps in a fixed column and falls back to activity", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([
			{ ...node("short"), recap: "Inspecting the scheduler queue" },
			{ ...node("a much longer starting prompt"), activity: { kind: "executing", toolName: "ipython" } },
		]);
		const lines = summary.render(100).map(stripAnsi);
		expect(lines.join("\n")).toContain("Inspecting the scheduler queue");
		expect(lines.join("\n")).toContain("Executing ipython");
		expect(lines[0]?.indexOf("Inspecting")).toBe(lines[1]?.indexOf("Executing"));
		expect(lines.join("\n")).not.toContain("│");
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

	it("shows heartbeating completed subagents as active with heartbeat icons", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([{ ...node("done", "done") }, { ...node("heartbeat", "done"), hasActiveHeartbeat: true }]);
		const lines = summary.render(80).map(stripAnsi);

		expect(lines[0]).toContain("♥");
		expect(lines[0]).toContain("heartbeat");
		expect(lines[0]).toContain("Heartbeat active");
		expect(lines[1]).toContain("✓");
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

	it("uses compact fixed-width S-number labels", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([node("first task"), node("second task")]);
		const out = stripAnsi(summary.render(80).join("\n"));
		expect(out).toContain("S1");
		expect(out).toContain("S2");
		expect(out).not.toContain("Subagent");
		expect(out).not.toContain("↳");
	});

	it("aligns the row icon and label with the agents-view tray hint", () => {
		const summary = new ChildAgentSummaryComponent(() => "← agents view");
		summary.setNodes([node("task", "done")]);
		const [infoLine = "", row = ""] = summary.render(80).map(stripAnsi);
		expect(row.indexOf("✓")).toBe(infoLine.indexOf("←"));
		expect(row.indexOf("S1")).toBe(infoLine.indexOf("agents"));
	});

	it("keeps truncation ellipses in the prompt color", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([{ ...node("a"), label: "A starting prompt that is much too long for its fixed column" }]);
		const out = summary.render(80).join("\n");
		const ellipsisIndex = out.indexOf("…");
		const beforeEllipsis = out.slice(0, ellipsisIndex);
		const dimStart = theme.fg("dim", "").replace("\x1b[39m", "");
		expect(ellipsisIndex).toBeGreaterThan(0);
		expect(beforeEllipsis.lastIndexOf(dimStart)).toBeGreaterThan(beforeEllipsis.lastIndexOf("\x1b[39m"));
		expect(out[ellipsisIndex - 1]).not.toBe(" ");
	});

	it("prefers stable session names over spawn prompts in the summary row", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([
			{
				...node("a"),
				sessionName: "anticheat-review",
				label: "You are doing a manual trajectory review for anti-cheat evidence",
				recap: "Extracting and analyzing test results",
			},
		]);
		const out = stripAnsi(summary.render(120).join("\n"));
		expect(out).toContain("anticheat-review");
		expect(out).not.toContain("manual trajectory");
		expect(out).toContain("Extracting and analyzing test results");
	});

	it("keeps the selected background active across the entire row", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.focused = true;
		summary.setNodes([
			{
				...node("a"),
				label: "A starting prompt that is much too long for its fixed column",
				recap: "A recap that is also much too long for its fixed column and must be truncated",
				toolUseCount: 3,
				tokenCount: 41_000,
				durationMs: 5_000,
			},
		]);
		const [line] = summary.render(80);
		const backgroundStart = theme.bg("selectedBg", "").replace("\x1b[49m", "");
		expect(line?.startsWith(backgroundStart)).toBe(true);
		expect(line?.endsWith("\x1b[49m")).toBe(true);
		expect(line).not.toContain("\x1b[0m");
	});

	it("adds extra space between token count and duration", () => {
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([{ ...node("a"), tokenCount: 41_000, durationMs: 5_000 }]);
		const out = stripAnsi(summary.render(80).join("\n"));
		expect(out).toMatch(/41k tok\s{3}5s/);
	});

	it("shows the model to the right of the back action in detail view", () => {
		const detail = new ChildAgentDetailComponent();
		detail.setNode({ ...node("a"), model: "anthropic/claude-opus-4-7" });
		const hint = stripAnsi(detail.render(100).at(-1) ?? "");
		expect(hint).toContain("back to chat");
		expect(hint).toContain("Claude Opus 4.7");
		expect(hint).not.toContain("anthropic/claude-opus-4-7");
		expect(hint.indexOf("Claude Opus 4.7")).toBeGreaterThan(hint.indexOf("back to chat"));
	});

	it("truncates long models before hiding detail actions", () => {
		const detail = new ChildAgentDetailComponent();
		detail.setNode({
			...node("a"),
			model: "provider-with-a-long-name/model-with-an-even-longer-name",
		});
		const hint = stripAnsi(detail.render(60).at(-1) ?? "");
		expect(hint).toContain("back to chat");
		expect(hint).toContain("model-wit…");
		expect(hint).not.toContain("provider-with-a-long-name");
		expect(hint).toContain("to expand");
		expect(hint).toContain("stop");
	});

	it("keeps the starting prompt compact so the recap gets more room", () => {
		const summary = new ChildAgentSummaryComponent();
		const prompt = "Investigate every scheduler dispatch path and identify all possible starvation conditions";
		summary.setNodes([{ ...node("a"), label: prompt, recap: "Found an unfair queue rotation" }]);
		const out = stripAnsi(summary.render(100).join("\n"));
		expect(out).not.toContain(prompt);
		expect(out).toContain("Investigate every");
		expect(out).toContain("Found an unfair queue rotation");
	});

	it("never exceeds the row width with wide (CJK) characters", () => {
		const wide = "実行するタスクは非常に長い説明を含んでいてこれは折り返しのテストです".repeat(3);
		const summary = new ChildAgentSummaryComponent();
		summary.setNodes([{ ...node("a"), label: wide, recap: wide, toolUseCount: 12, tokenCount: 912_000 }]);
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
		expect(out).toContain("exactly 30");
		expect(out).toContain("exactly 120");
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
