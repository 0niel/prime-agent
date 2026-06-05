import { clearDefaultTerminalColors, setDefaultTerminalColors } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEditorTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

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

	it("uses theme colors for editor chrome when the terminal background is unknown", () => {
		const editorTheme = getEditorTheme();

		expect(editorTheme.backgroundColor?.("x")).toBe(theme.bg("userMessageBg", "x"));
		expect(editorTheme.borderColor("x")).toBe(theme.fg("borderMuted", "x"));
	});

	it("keeps theme editor chrome on dark terminal backgrounds", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 0, g: 0, b: 0 },
		});

		const editorTheme = getEditorTheme();

		expect(editorTheme.backgroundColor?.("x")).toBe(theme.bg("userMessageBg", "x"));
		expect(editorTheme.borderColor("x")).toBe(theme.fg("borderMuted", "x"));
	});

	it("nudges the editor surface when it matches the terminal background", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 26, g: 26, b: 31 },
		});

		const editorTheme = getEditorTheme();

		expect(editorTheme.backgroundColor?.("x")).not.toBe(theme.bg("userMessageBg", "x"));
		expect(editorTheme.backgroundColor?.("x")).toMatch(/\x1b\[48;2;\d+;\d+;\d+mx\x1b\[49m/);
		expect(editorTheme.borderColor("x")).toBe(theme.fg("borderMuted", "x"));
	});

	it("keeps theme editor chrome on light terminal backgrounds", () => {
		setDefaultTerminalColors({
			foreground: { r: 0, g: 0, b: 0 },
			background: { r: 255, g: 255, b: 255 },
		});

		const editorTheme = getEditorTheme();

		expect(editorTheme.backgroundColor?.("x")).toBe(theme.bg("userMessageBg", "x"));
		expect(editorTheme.borderColor("x")).toBe(theme.fg("borderMuted", "x"));
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
