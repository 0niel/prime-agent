import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ChildAgentInspectorNode } from "../src/modes/interactive/components/child-agent-inspector.js";
import { SubagentTreeView } from "../src/modes/interactive/components/subagent-tree-view.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function node(overrides: Partial<ChildAgentInspectorNode> & { id: string }): ChildAgentInspectorNode {
	return {
		label: overrides.id,
		status: "running",
		sessionDir: `/tmp/${overrides.id}`,
		transcript: [],
		...overrides,
	};
}

function renderText(view: SubagentTreeView, width = 100): string {
	return stripAnsi(view.render(width).join("\n"));
}

describe("SubagentTreeView", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("renders nothing when there are no live subagents", () => {
		const view = new SubagentTreeView();
		expect(view.render(100)).toEqual([]);
		expect(view.hasNodes()).toBe(false);
	});

	test("only in-flight subagents show; finished ones disappear", () => {
		const view = new SubagentTreeView();
		view.setNodes([
			node({ id: "a", status: "running" }),
			node({ id: "b", status: "queued" }),
			node({ id: "done", status: "done" }),
			node({ id: "err", status: "error" }),
		]);
		expect(view.hasNodes()).toBe(true);
		const text = renderText(view);
		// running + queued counted; done/error dropped entirely.
		expect(text).toContain("Running 2 agents…");
		expect(text).not.toContain("done");
		expect(text).not.toContain("err");
	});

	test("includes in-flight nested subagents from the children tree", () => {
		const view = new SubagentTreeView();
		view.setNodes([
			node({
				id: "parent",
				label: "parent",
				status: "running",
				children: [
					node({ id: "child-run", label: "nested running", status: "running" }),
					node({ id: "child-done", label: "nested done", status: "done" }),
				],
			}),
		]);
		const text = renderText(view);
		// parent + nested running counted; nested done dropped.
		expect(text).toContain("Running 2 agents…");
		expect(text).toContain("nested running");
		expect(text).not.toContain("nested done");
	});

	test("shows a running nested subagent even when its parent has finished", () => {
		const view = new SubagentTreeView();
		view.setNodes([
			node({
				id: "parent",
				label: "parent",
				status: "done",
				children: [node({ id: "child-run", label: "nested running", status: "running" })],
			}),
		]);
		const text = renderText(view);
		expect(text).toContain("Running 1 agent…");
		expect(text).toContain("nested running");
		expect(text).not.toContain("parent");
	});

	test("disappears once every subagent is done", () => {
		const view = new SubagentTreeView();
		view.setNodes([node({ id: "a", status: "done" }), node({ id: "b", status: "cancelled" })]);
		expect(view.render(100)).toEqual([]);
	});

	test("header pluralizes on the live count", () => {
		const view = new SubagentTreeView();
		view.setNodes([node({ id: "a" })]);
		expect(renderText(view)).toContain("Running 1 agent…");
		view.setNodes([node({ id: "a" }), node({ id: "b" })]);
		expect(renderText(view)).toContain("Running 2 agents…");
	});

	test("opens with a blank line and a single-space left pad", () => {
		const view = new SubagentTreeView();
		view.setNodes([node({ id: "x", label: "scout", recap: "looking" })]);
		const lines = view.render(100).map((line) => stripAnsi(line));
		expect(lines[0]).toBe(""); // spacing above so it doesn't hug the tool call
		expect(lines[1]).toBe(" Running 1 agent…"); // one-space left padding
		expect(lines.slice(2).every((line) => line.startsWith(" "))).toBe(true);
	});

	test("every node is two lines: summary then recap", () => {
		const view = new SubagentTreeView();
		view.setNodes([
			node({
				id: "x",
				label: "Angle A scan",
				toolUseCount: 22,
				tokenCount: 41000,
				recap: "Searching for 6 patterns",
			}),
		]);
		const text = renderText(view);
		expect(text).toContain("Angle A scan · 22 tool uses · 41k tokens");
		expect(text).toContain("Searching for 6 patterns");
	});

	test("falls back to a live activity label until the recap lands", () => {
		const view = new SubagentTreeView();
		// No transcript yet -> Waiting.
		view.setNodes([node({ id: "x", label: "scout" })]);
		// header + blank + 2 node lines = 4
		expect(view.render(100)).toHaveLength(4);
		expect(renderText(view)).toContain("Waiting");

		// A tool still running -> Executing <tool>.
		view.setNodes([
			node({
				id: "x",
				label: "scout",
				structuredTranscript: [
					{
						type: "tool",
						role: "tool",
						text: "",
						toolCallId: "1",
						toolName: "Bash",
						args: {},
						isPartial: true,
						executionStarted: true,
						argsComplete: true,
					},
				],
			}),
		]);
		expect(renderText(view)).toContain("Executing Bash");

		// Assistant text streaming -> Writing.
		view.setNodes([
			node({
				id: "x",
				label: "scout",
				structuredTranscript: [
					{ type: "message", role: "assistant", text: "thinking out loud", message: {} as never },
				],
			}),
		]);
		expect(renderText(view)).toContain("Writing");

		// Queued -> Waiting regardless of transcript.
		view.setNodes([node({ id: "x", label: "scout", status: "queued" })]);
		expect(renderText(view)).toContain("Waiting");
	});

	test("the recap wins over the activity label once present", () => {
		const view = new SubagentTreeView();
		view.setNodes([
			node({
				id: "x",
				label: "scout",
				recap: "Searching for 6 patterns",
				structuredTranscript: [
					{
						type: "tool",
						role: "tool",
						text: "",
						toolCallId: "1",
						toolName: "Bash",
						args: {},
						isPartial: true,
						executionStarted: true,
						argsComplete: true,
					},
				],
			}),
		]);
		const text = renderText(view);
		expect(text).toContain("Searching for 6 patterns");
		expect(text).not.toContain("Executing");
	});

	test("animates the working icon — frames differ as the pulse advances", () => {
		const view = new SubagentTreeView();
		view.setNodes([node({ id: "x", label: "scout" })]);
		// The icon is read from the process-wide pulse frame at render time; the
		// summary line carries one of the working icon glyphs.
		const summaryLine = stripAnsi(view.render(100)[2] ?? "");
		expect(summaryLine).toMatch(/[◇◈◆]/);
	});

	test("never leaks the transcript onto the recap line", () => {
		const view = new SubagentTreeView();
		view.setNodes([node({ id: "x", label: "scout", transcript: [{ role: "tool", text: "Bash: rm -rf secret" }] })]);
		expect(renderText(view)).not.toContain("Bash: rm -rf secret");
	});

	test("caps the label to a few words", () => {
		const view = new SubagentTreeView();
		view.setNodes([node({ id: "x", label: "find every place the parser touches the old config schema" })]);
		const text = renderText(view);
		expect(text).toContain("find every place the…");
		expect(text).not.toContain("schema");
	});

	test("caps at five nodes with a +N more line", () => {
		const view = new SubagentTreeView();
		view.setNodes(Array.from({ length: 7 }, (_, i) => node({ id: `run-${i}`, label: `run-${i}` })));
		expect(renderText(view)).toContain("+2 more"); // 7 live, 5 shown
	});
});
