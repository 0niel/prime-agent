import { beforeAll, describe, expect, test } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import {
	formatPackageUpdateNotice,
	formatTmuxWarningNotice,
	formatUpdateAvailableNotice,
} from "../src/modes/shared/startup-notices.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

describe("startup notice formatters", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("update notice mentions the version and prime-agent update command", () => {
		const output = stripAnsi(formatUpdateAvailableNotice("1.2.3"));
		expect(output).toBe("Update available: v1.2.3. Run prime-agent update");
		expect(output).not.toContain("pi update");
	});

	test("package update notice lists packages and the extensions command", () => {
		const output = stripAnsi(formatPackageUpdateNotice(["npm:@foo/bar", "npm:@baz/qux"]));
		expect(output).toBe("Package updates available: npm:@foo/bar, npm:@baz/qux. Run prime-agent update --extensions");
	});

	test("tmux warning notice is prefixed with the warning glyph", () => {
		const output = stripAnsi(formatTmuxWarningNotice("tmux extended-keys is off."));
		expect(output).toBe("⚠ tmux extended-keys is off.");
	});
});
