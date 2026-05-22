import { clearDefaultTerminalColors, setDefaultTerminalColors } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const BOLD_CYAN = "\x1b[36m\x1b[1mx\x1b[22m\x1b[39m";
const BOLD_DARK_CYAN_TRUECOLOR = "\x1b[38;2;0;95;135m\x1b[1mx\x1b[22m\x1b[39m";

describe("adaptive TUI theme colors", () => {
	let previousColorTerm: string | undefined;
	let previousColorFgBg: string | undefined;

	beforeEach(() => {
		previousColorTerm = process.env.COLORTERM;
		previousColorFgBg = process.env.COLORFGBG;
		process.env.COLORTERM = "truecolor";
		delete process.env.COLORFGBG;
		clearDefaultTerminalColors();
		initTheme("prime");
	});

	afterEach(() => {
		clearDefaultTerminalColors();
		if (previousColorTerm === undefined) {
			delete process.env.COLORTERM;
		} else {
			process.env.COLORTERM = previousColorTerm;
		}
		if (previousColorFgBg === undefined) {
			delete process.env.COLORFGBG;
		} else {
			process.env.COLORFGBG = previousColorFgBg;
		}
	});

	it("uses no editor background fill when the terminal background is unknown", () => {
		const editorTheme = getEditorTheme();

		expect(editorTheme.backgroundColor).toBeUndefined();
		expect(editorTheme.borderColor("x")).toBe(BOLD_CYAN);
	});

	it("lightens dark terminal backgrounds for the editor input surface", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 0, g: 0, b: 0 },
		});

		const editorTheme = getEditorTheme();

		expect(editorTheme.backgroundColor?.("x")).toBe("\x1b[48;2;15;15;15mx\x1b[49m");
		expect(editorTheme.borderColor("x")).toBe(BOLD_CYAN);
	});

	it("darkens light terminal backgrounds and uses a darker cyan accent", () => {
		setDefaultTerminalColors({
			foreground: { r: 0, g: 0, b: 0 },
			background: { r: 255, g: 255, b: 255 },
		});

		const editorTheme = getEditorTheme();

		expect(editorTheme.backgroundColor?.("x")).toBe("\x1b[48;2;245;245;245mx\x1b[49m");
		expect(editorTheme.borderColor("x")).toBe(BOLD_DARK_CYAN_TRUECOLOR);
	});

	it("uses COLORFGBG for automatic default theme selection when OSC colors are unavailable", () => {
		process.env.COLORFGBG = "0;15";
		clearDefaultTerminalColors();
		initTheme(undefined);

		expect(theme.name).toBe("light");

		process.env.COLORFGBG = "15;0";
		clearDefaultTerminalColors();
		initTheme(undefined);

		expect(theme.name).toBe("prime");
	});
});
