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

	it("renders a header line and blank spacer inside the top of the editor box", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const withoutHeader = editor.render(40);

		editor.getHeaderLine = () => "6h last agent response";
		const lines = editor.render(40);

		expect(lines.length).toBe(withoutHeader.length + 2);
		expect(lines[0]).toBe(withoutHeader[0]);
		expect(lines[1]).toContain("6h last agent response");
		expect(lines[2]!.trim()).toBe("");
		expect(lines.slice(3)).toEqual(withoutHeader.slice(1));
	});

	it("truncates the header line to the editor width", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		editor.getHeaderLine = () => "x".repeat(100);
		const lines = editor.render(40);

		expect(lines[1]).toContain("x".repeat(37));
		expect(lines[1]).not.toContain("x".repeat(38));
		expect(lines[1]).toContain("...");
	});

	it("keeps the surface background across truncation resets in the header line", () => {
		const backgroundColor = (text: string) => `<bg>${text}</bg>`;
		const editor = new CustomEditor(fakeTui, { ...editorTheme, backgroundColor }, new KeybindingsManager());
		editor.getHeaderLine = () => "x".repeat(100);
		const lines = editor.render(40);

		const segments = lines[1]!.split("\x1b[0m");
		expect(segments.length).toBeGreaterThan(1);
		for (const segment of segments) {
			expect(segment.startsWith("<bg>")).toBe(true);
			expect(segment.endsWith("</bg>")).toBe(true);
		}
	});

	it("renders no header when the callback returns undefined", () => {
		const editor = new CustomEditor(fakeTui, editorTheme, new KeybindingsManager());
		const withoutCallback = editor.render(40);

		editor.getHeaderLine = () => undefined;

		expect(editor.render(40)).toEqual(withoutCallback);
	});
});
