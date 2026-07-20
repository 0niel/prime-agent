import { describe, expect, it } from "vitest";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("CompactionSummaryMessageComponent", () => {
	it("shows token reduction without repeating visible command instructions", () => {
		initTheme("dark");
		const component = new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary: "Summary body",
			tokensBefore: 42_123,
			tokensAfter: 8_406,
			customInstructions: "focus on queues",
			commandVisible: true,
			timestamp: Date.now(),
		});

		component.setExpanded(true);
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("Compacted 42,123 → 8,406 tokens");
		expect(rendered).toContain("Summary body");
		expect(rendered).not.toContain("Focus:");
	});
});
