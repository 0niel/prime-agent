import { clearDefaultTerminalColors, setDefaultTerminalColors } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	afterEach(() => {
		clearDefaultTerminalColors();
	});

	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 0, g: 0, b: 0 },
		});
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("uses the themed message background when terminal background is unknown", () => {
		clearDefaultTerminalColors();
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});
});
