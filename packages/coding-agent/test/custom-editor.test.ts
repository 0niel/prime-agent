import type { AutocompleteProvider, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";

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
	terminal: { rows: 24, columns: 80 },
} as unknown as TUI;

const autocompleteProvider: AutocompleteProvider = {
	async getSuggestions() {
		return {
			prefix: "/",
			items: [
				{ value: "/help", label: "/help" },
				{ value: "/hotkeys", label: "/hotkeys" },
			],
		};
	},
	applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
		const line = lines[cursorLine] ?? "";
		const before = line.slice(0, cursorCol - prefix.length);
		const after = line.slice(cursorCol);
		const nextLines = [...lines];
		nextLines[cursorLine] = before + item.value + after;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: before.length + item.value.length,
		};
	},
};

describe("CustomEditor", () => {
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.clearAllMocks();
	});

	it("cancels autocomplete before handling app.clear", async () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const handler = vi.fn();

		editor.setAutocompleteProvider(autocompleteProvider);
		editor.onAction("app.clear", handler);
		editor.handleInput("/");
		await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));

		editor.handleInput("\x03");

		expect(editor.isShowingAutocomplete()).toBe(false);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("/");
	});
});
