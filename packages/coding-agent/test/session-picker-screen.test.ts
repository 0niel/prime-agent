import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	SessionPickerScreen,
	sessionPickerListMaxVisible,
} from "../src/modes/interactive/components/session-picker-screen.js";
import type { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";

describe("SessionPickerScreen", () => {
	it("uses a centered full-terminal surface and sizes the session list to the viewport", () => {
		const ui = { terminal: { rows: 24 } } as unknown as TUI;
		const header = {
			invalidate: vi.fn(),
			render: vi.fn(() => ["Resume Session"]),
		} as Component;
		const selector = {
			focused: false,
			handleInput: vi.fn(),
			invalidate: vi.fn(),
			render: vi.fn(() => ["Saved session"]),
			setListMaxVisible: vi.fn(),
		} as unknown as SessionSelectorComponent;

		const screen = new SessionPickerScreen(ui, header, selector);
		screen.focused = true;
		screen.handleInput("x");
		const lines = screen.render(120);

		expect(selector.focused).toBe(true);
		expect(selector.handleInput).toHaveBeenCalledWith("x");
		expect(sessionPickerListMaxVisible(24, 1)).toBe(13);
		expect(header.render).toHaveBeenCalledWith(120);
		expect(selector.setListMaxVisible).toHaveBeenCalledWith(13);
		expect(selector.render).toHaveBeenCalledWith(120);
		expect(lines).toHaveLength(24);
		expect(lines[0]!.trim()).toBe("Resume Session");
		expect(lines[1]!.trim()).toBe("Saved session");
		expect(lines.every((line) => visibleWidth(line) === 120)).toBe(true);
	});
});
