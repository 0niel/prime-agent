import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("ExtensionSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a multiline prompt with compact option rows", () => {
		const selector = new ExtensionSelectorComponent(
			[
				"Interrupted IPython cell is still running",
				"Ctrl+C sent an interrupt, but the previous cell has not stopped yet.",
				"Waiting preserves the current kernel state. Killing restarts IPython and loses in-memory variables.",
			].join("\n"),
			["Wait and preserve state", "Kill kernel and restart"],
			vi.fn(),
			vi.fn(),
			{ getRows: () => 24 },
		);

		const lines = selector.render(88);
		const outputLines = lines.map((line) => stripAnsi(line));
		const output = outputLines.join("\n");
		const waitIndex = outputLines.findIndex((line) => line.includes("Wait and preserve state"));
		const killIndex = outputLines.findIndex((line) => line.includes("Kill kernel and restart"));

		expect(output).toContain("Interrupted IPython cell is still running");
		expect(output).toContain("Ctrl+C sent an interrupt");
		expect(output).toContain("Waiting preserves the current kernel state");
		expect(waitIndex).toBeGreaterThan(-1);
		expect(killIndex).toBe(waitIndex + 1);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(88);
		}
	});
});
