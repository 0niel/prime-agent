import type { EditorTheme, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { PendingMessageNavigation } from "../src/modes/interactive/pending-message-navigation.js";

const passthrough = (text: string) => text;
const editorTheme: EditorTheme = {
	borderColor: passthrough,
	selectList: {
		selectedPrefix: passthrough,
		selectedText: passthrough,
		description: passthrough,
		scrollInfo: passthrough,
		noMatch: passthrough,
	},
};
const fakeTui = {
	requestRender: vi.fn(),
	showOverlay: vi.fn(
		() =>
			({
				hide: vi.fn(),
				setHidden: vi.fn(),
				isHidden: () => false,
				focus: vi.fn(),
				unfocus: vi.fn(),
				isFocused: () => false,
			}) satisfies OverlayHandle,
	),
	terminal: { rows: 24, columns: 80 },
} as unknown as TUI;

/** Real editor so reorder chords are asserted through actual key dispatch. */
const createEditor = () => new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());

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
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.clearAllMocks();
	});

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

	// xterm modifier parameter is 1-based: 1 + shift(1) + alt(2) + ctrl(4), so Ctrl+Alt is 7.
	it.each([
		["xterm CSI", "\x1b[1;7A", "\x1b[1;7B"],
		["Kitty CSI-u", "\x1b[57419;7u", "\x1b[57420;7u"],
		["legacy Option-as-Meta", "\x1b\x1b[1;5A", "\x1b\x1b[1;5B"],
	])("dispatches %s ctrl+alt arrows to the reorder actions", (_label, earlier, later) => {
		const editor = createEditor();
		const moveEarlier = vi.fn();
		const moveLater = vi.fn();
		editor.onAction("app.message.moveEarlier", moveEarlier);
		editor.onAction("app.message.moveLater", moveLater);

		editor.handleInput(earlier);
		editor.handleInput(later);

		expect([moveEarlier.mock.calls.length, moveLater.mock.calls.length]).toEqual([1, 1]);
		expect(editor.getText()).toBe("");
	});

	it("keeps plain and shifted arrows away from the reorder actions", () => {
		const editor = createEditor();
		const moveEarlier = vi.fn();
		const navigateOlder = vi.fn();
		editor.onAction("app.message.moveEarlier", moveEarlier);
		editor.onAction("app.message.navigateOlder", navigateOlder);

		editor.handleInput("\x1b[1;8A"); // shift+ctrl+alt+up must not alias onto ctrl+alt+up
		expect(moveEarlier).not.toHaveBeenCalled();

		editor.handleInput("\x1b[1;3A"); // alt+up browses instead of reordering
		expect([navigateOlder.mock.calls.length, moveEarlier.mock.calls.length]).toEqual([1, 0]);
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
