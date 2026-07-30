import { describe, expect, it, vi } from "vitest";
import { AgentsViewMode } from "../src/modes/agents-view/agents-view-mode.js";

describe("AgentsViewMode search selection", () => {
	it("keeps the selection chosen by row rebuilding when the query changes", () => {
		const self = {
			editor: { getText: () => "matching query" },
			persistentState: { query: "" },
			selectedIndex: 4,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		(AgentsViewMode.prototype as unknown as { queryChanged(this: typeof self): void }).queryChanged.call(self);

		expect(self.persistentState.query).toBe("matching query");
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(self.selectedIndex).toBe(4);
	});
});
