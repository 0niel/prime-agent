import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function renderCell(state: ConstructorParameters<typeof IPythonCellComponent>[0]): string {
	return stripAnsi(new IPythonCellComponent(state).render(80).join("\n"));
}

describe("IPythonCellComponent diff rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a streamed diff with absolute line numbers and suppresses the Edited confirmation", () => {
		const out = renderCell({
			code: 'await edit(path="sample.py", old_str="gamma", new_str="GAMMA")',
			details: {
				status: "ok",
				durationMs: 12,
				// IPython reprs the returned string, so the confirmation arrives quoted.
				result: "'Edited sample.py'",
				diffs: [{ path: "sample.py", oldStr: "alpha\ngamma\ndelta", newStr: "alpha\nGAMMA\ndelta", startLine: 10 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});

		// Header carries the path and the +/- line counts.
		expect(out).toContain("edit sample.py");
		expect(out).toMatch(/\+1\s+-1/);
		// Removed line keeps the old line number + content; added line the new one.
		expect(out).toMatch(/11 -.*gamma/);
		expect(out).toMatch(/11 \+.*GAMMA/);
		expect(out).toMatch(/10 .*alpha/);
		// The redundant "Edited sample.py" confirmation must not render as its own line.
		expect(out.split("\n").some((line) => /^\s*'?Edited sample\.py'?\s*$/.test(line.trim()))).toBe(false);
	});

	it("pads every diff row to the full content width on a single background block", () => {
		const out = new IPythonCellComponent({
			code: "await edit(...)",
			details: {
				status: "ok",
				diffs: [{ path: "sample.py", oldStr: "alpha\ngamma\ndelta", newStr: "alpha\nGAMMA\ndelta", startLine: 1 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(72);
		// Every rendered line is exactly the panel width (no ragged backgrounds).
		expect(out.every((line) => stripAnsi(line).length === 72)).toBe(true);
	});

	it("keeps full width when a wide character straddles the truncation boundary", () => {
		// CJK chars are 2 cells wide; a narrow render forces truncation mid-character.
		const wide = "値".repeat(60);
		const out = new IPythonCellComponent({
			code: "await edit(...)",
			details: {
				status: "ok",
				diffs: [{ path: "a.py", oldStr: "x = 1", newStr: `x = "${wide}"`, startLine: 1 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(40);
		// Measure display cells, not code units (CJK chars are 2 cells wide).
		expect(out.every((line) => visibleWidth(line) === 40)).toBe(true);
	});

	it("collapses a long diff and shows an expand hint", () => {
		const oldStr = Array.from({ length: 30 }, (_, i) => `row ${i}`).join("\n");
		const newStr = oldStr
			.split("\n")
			.map((line, i) => (i % 2 === 0 ? line.toUpperCase() : line))
			.join("\n");

		const collapsed = renderCell({
			code: "await edit(...)",
			details: { status: "ok", durationMs: 9, diffs: [{ path: "big.py", oldStr, newStr, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		// Collapsed is a single line: the diff itself is hidden behind the expand hint.
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("ROW");

		const expanded = renderCell({
			code: "await edit(...)",
			details: { status: "ok", durationMs: 9, diffs: [{ path: "big.py", oldStr, newStr, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		expect(expanded).toContain("ROW");
	});

	it("renders multiple diffs from a single cell", () => {
		const out = renderCell({
			code: "await edit(...); await edit(...)",
			details: {
				status: "ok",
				durationMs: 5,
				diffs: [
					{ path: "a.py", oldStr: "one", newStr: "ONE", startLine: 1 },
					{ path: "b.py", oldStr: "two", newStr: "TWO", startLine: 2 },
				],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		});
		expect(out).toContain("edit a.py");
		expect(out).toContain("edit b.py");
	});

	it("coalesces multiple edits to one file into a single block with hunk separators", () => {
		const out = renderCell({
			code: "await edit(...); await edit(...); await edit(...)",
			expanded: true,
			details: {
				status: "ok",
				diffs: [
					{ path: "app.py", oldStr: "a = 1", newStr: "a = 2", startLine: 1 },
					{ path: "app.py", oldStr: "b = 1", newStr: "b = 2", startLine: 50 },
					{ path: "app.py", oldStr: "c = 1", newStr: "c = 2", startLine: 90 },
				],
			},
			executionStarted: true,
			argsComplete: true,
		});
		// One consolidated header for the file, with summed counts.
		expect(out.split("\n").filter((l) => l.includes("edit app.py")).length).toBe(1);
		expect(out).toMatch(/edit app\.py\s+\+3\s+-3/);
		// Non-adjacent hunks are separated by the vertical-ellipsis marker.
		expect(out).toContain("⋮");
		expect((out.match(/⋮/g) ?? []).length).toBe(2);
	});
});
