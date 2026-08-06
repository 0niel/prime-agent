import { describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PendingMessageNavigation } from "../src/modes/interactive/pending-message-navigation.js";

const queue = {
	steering: ["s1", "s2"],
	followUp: ["f1", "f2", "f3"],
	items: [
		{ id: "s1", lane: "steering" as const, index: 0, text: "s1" },
		{ id: "s2", lane: "steering" as const, index: 1, text: "s2" },
		{ id: "f1", lane: "followUp" as const, index: 0, text: "f1" },
		{ id: "f2", lane: "followUp" as const, index: 1, text: "f2" },
		{ id: "f3", lane: "followUp" as const, index: 2, text: "f3" },
	],
};

describe("PendingMessageNavigation", () => {
	it("browses distinct items with per-item edits and restores the draft", () => {
		const state = new PendingMessageNavigation();
		expect(state.browse(queue, "draft", -1)).toBe("f3");
		expect(state.browse(queue, "f3 edit", -1)).toBe("f2");
		expect(state.browse(queue, "f2 edit", 1)).toBe("f3 edit");
		expect(state.browse(queue, "f3 edit 2", 1)).toBe("draft");
	});

	it("checkpoints the draft while browsing queued items", () => {
		const state = new PendingMessageNavigation();
		expect(state.browse(queue, "draft", -1)).toBe("f3");
		expect(state.selected).toEqual({ id: "f3", lane: "followUp", index: 2 });
		expect(state.checkpoint().draft).toBe("draft");
	});

	it.each([
		["delete", ""],
		["steer", "edited"],
		["followUp", "edited"],
	] as const)("applies %s to the browsed item", (kind, text) => {
		const state = new PendingMessageNavigation();
		state.browse(queue, "draft", -1);
		const changed = state.change(kind, text);
		expect(changed?.draft).toBe("draft");
		expect(state.selected).toBeUndefined();
	});

	it("reorders within a lane, keeps the edit selected, and no-ops at boundaries", () => {
		const state = new PendingMessageNavigation();
		state.browse(queue, "draft", -1);
		state.browse(queue, "f3", -1);
		expect(state.change("earlier", "edited")).toMatchObject({
			selected: { id: "f2", lane: "followUp", index: 0 },
			draft: "draft",
		});
		expect(state.selected).toEqual({ id: "f2", lane: "followUp", index: 0 });
		expect(state.change("earlier", "edited")).toBeUndefined();
	});

	it("preserves other per-item edits and the original draft across reorder", () => {
		const state = new PendingMessageNavigation();
		state.browse(queue, "draft", -1); // f3
		state.browse(queue, "f3 edited", -1); // f2
		state.change("earlier", "f2 edited");
		expect(state.checkpoint().draft).toBe("draft");
		const reordered = state.checkpoint().queue!;
		expect(state.browse(reordered, "f2 edited", 1)).toBe("f1");
		expect(state.browse(reordered, "f1", 1)).toBe("f3 edited");
	});

	it("refreshes revisions and reanchors stable selection without dropping edits", () => {
		const state = new PendingMessageNavigation();
		state.browse({ ...queue, revision: 1 }, "draft", -1);
		state.capture("f3 edited");
		const changed = {
			...queue,
			revision: 2,
			followUp: ["inserted", ...queue.followUp],
			items: [
				...queue.items.filter((item) => item.lane === "steering"),
				{ id: "new", lane: "followUp" as const, index: 0, text: "inserted" },
				...queue.items
					.filter((item) => item.lane === "followUp")
					.map((item) => ({ ...item, index: item.index + 1 })),
			],
		};
		expect(state.sync(changed)).toBeUndefined();
		expect(state.selected).toEqual({ id: "f3", lane: "followUp", index: 3 });
		expect(state.browse(changed, "f3 edited", 1)).toBe("draft");

		// Same content still refreshes the cached CAS revision.
		state.browse({ ...queue, revision: 3 }, "draft", -1);
		expect(state.sync({ ...queue, revision: 4 })).toBeUndefined();
		expect(state.checkpoint().queue?.revision).toBe(4);
	});

	it("resets when the authoritative queue changes", () => {
		const state = new PendingMessageNavigation();
		state.browse(queue, "draft", -1);
		expect(state.sync({ steering: ["new"], followUp: [] })).toBe("draft");
		expect(state.selected).toBeUndefined();

		state.browse(queue, "", -1);
		expect(state.sync({ steering: [], followUp: [] })).toBe("");
	});

	it("uses configurable conflict-free defaults", () => {
		const keys = new KeybindingsManager();
		expect([
			keys.getKeys("app.message.navigateOlder"),
			keys.getKeys("app.message.navigateNewer"),
			keys.getKeys("app.message.moveEarlier"),
			keys.getKeys("app.message.moveLater"),
		]).toEqual([["alt+up"], ["alt+down"], ["ctrl+alt+up"], ["ctrl+alt+down"]]);
		expect(keys.getConflicts()).toEqual([]);
		const custom = new KeybindingsManager({ "app.message.moveEarlier": "ctrl+p" });
		expect(custom.getKeys("app.message.moveEarlier")).toEqual(["ctrl+p"]);
	});
});
