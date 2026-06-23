import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { IPythonCellComponent } from "../src/modes/interactive/components/ipython-cell.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function hasBackground(line: string): boolean {
	return /\x1b\[4[0-9]m|\x1b\[48[;:]/.test(line);
}

function renderCell(state: ConstructorParameters<typeof IPythonCellComponent>[0]): string {
	return stripAnsi(new IPythonCellComponent(state).render(80).join("\n"));
}

describe("IPythonCellComponent diff rendering", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a diff with absolute line numbers and suppresses the Edited confirmation", () => {
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

		// Header carries the path (no "edit" label) and the +/- line counts.
		expect(out).toContain("sample.py");
		expect(out).not.toMatch(/edit sample\.py/);
		expect(out).toMatch(/\+1\s+-1/);
		// Removed line keeps the old line number; added line the new one.
		expect(out).toMatch(/11 - .*gamma/);
		expect(out).toMatch(/11 \+ .*GAMMA/);
		expect(out).toMatch(/10 .*alpha/);
		// The redundant "Edited sample.py" confirmation must not render as its own line.
		expect(out.split("\n").some((line) => /^\s*'?Edited sample\.py'?\s*$/.test(line.trim()))).toBe(false);
	});

	it("renders diff rows as full-width colored blocks", () => {
		const width = 72;
		const lines = new IPythonCellComponent({
			code: "await edit(...)",
			details: {
				status: "ok",
				diffs: [{ path: "sample.py", oldStr: "alpha\ngamma\ndelta", newStr: "alpha\nGAMMA\ndelta", startLine: 1 }],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: true,
		}).render(width);
		const diffRows = lines.filter((line) => /alpha|gamma|GAMMA/.test(stripAnsi(line)));
		expect(diffRows.length).toBeGreaterThan(0);
		// Each changed row is a background block spanning the full width.
		expect(diffRows.every((line) => visibleWidth(line) === width)).toBe(true);
		expect(diffRows.some(hasBackground)).toBe(true);
	});

	it("prefixes the header with the cell's status marker and aligns it with the summary line", () => {
		const done = renderCell({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).split("\n");
		// Summary line and header share the same single-space indent.
		expect(done[0]).toMatch(/^ ✓ python/);
		expect(done.find((l) => l.includes("a.ts"))).toMatch(/^ ✓ a\.ts/);

		const failed = renderCell({
			code: "await edit(...)",
			details: { status: "error", diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
			isError: true,
		});
		expect(failed).toMatch(/✗ a\.ts/);
	});

	it("renders an edit path relative to the session cwd, or absolute when outside it", () => {
		const cwd = "/home/me/project";
		const inside = renderCell({
			code: "await edit(...)",
			cwd,
			details: { status: "ok", diffs: [{ path: `${cwd}/src/app.ts`, oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(inside).toContain("src/app.ts");
		expect(inside).not.toContain(`${cwd}/src/app.ts`);

		const outside = renderCell({
			code: "await edit(...)",
			cwd,
			details: { status: "ok", diffs: [{ path: "/etc/hosts", oldStr: "a", newStr: "b", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(outside).toContain("/etc/hosts");
	});

	it("wraps a long diff line across rows without truncating or overflowing the width", () => {
		const width = 92;
		const longLine = `const x = ${Array.from({ length: 30 }, (_, i) => `arg${i}`).join(", ")};`;
		const lines = new IPythonCellComponent({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "const x = 1;", newStr: longLine, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).render(width);

		// No rendered row may exceed the terminal width (the TUI throws if one does).
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		// The full content survives across the wrapped rows (nothing truncated away).
		const joined = lines.map(stripAnsi).join("");
		expect(joined).toContain("arg0");
		expect(joined).toContain("arg29");
		// The added line spilled onto at least one continuation row.
		expect(lines.filter((line) => /arg\d/.test(stripAnsi(line))).length).toBeGreaterThan(1);
	});

	it("truncates a long header path so it never overflows the width, keeping the counts", () => {
		const width = 40;
		const longPath = `src/${"very-long-directory-name/".repeat(8)}file.ts`;
		const lines = new IPythonCellComponent({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: longPath, oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		const header = lines.map(stripAnsi).find((line) => line.includes("…"));
		expect(header).toBeDefined();
		// The +/- counts survive truncation; only the path is shortened.
		expect(header).toMatch(/\+1 -1\s*$/);
	});

	it("renders a large diff without spreading the row array (no RangeError)", () => {
		const n = 5000;
		const oldStr = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
		const newStr = Array.from({ length: n }, (_, i) => `LINE ${i}`).join("\n");
		expect(() =>
			new IPythonCellComponent({
				code: "await edit(...)",
				details: { status: "ok", diffs: [{ path: "big.txt", oldStr, newStr, startLine: 1 }] },
				executionStarted: true,
				argsComplete: true,
				expanded: false,
			}).render(80),
		).not.toThrow();
	});

	it("repeats the +/- sign on wrapped continuation rows", () => {
		const longLine = `const x = ${Array.from({ length: 20 }, (_, i) => `arg${i}`).join(", ")};`;
		const out = renderCell({
			code: "await edit(...)",
			details: { status: "ok", diffs: [{ path: "a.ts", oldStr: "const x = 1;", newStr: longLine, startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).split("\n");
		// The added line wraps; every row carrying its content shows a "+" gutter.
		const addedRows = out.filter((line) => /arg\d/.test(line));
		expect(addedRows.length).toBeGreaterThan(1);
		expect(addedRows.every((line) => /^\s*\+ /.test(line) || /\d+ \+ /.test(line))).toBe(true);
	});

	it("separates the diff from the summary line with a blank line", () => {
		const out = renderCell({
			code: "await edit(...)",
			details: { status: "ok", durationMs: 4, diffs: [{ path: "a.ts", oldStr: "x", newStr: "X", startLine: 1 }] },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		}).split("\n");
		expect(out[0]).toContain("to expand");
		expect(out[1].trim()).toBe("");
		expect(out[2]).toContain("a.ts");
	});

	it("shows the full diff in the collapsed view so file changes never hide behind expand", () => {
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
		expect(collapsed).toContain("to expand");
		expect(collapsed).toContain("big.py");
		expect(collapsed).toContain("ROW");
		// Every changed row is present — the diff is never truncated when collapsed.
		expect((collapsed.match(/\+.*ROW \d+/g) ?? []).length).toBe(15);
	});

	it("renders multiple files' diffs in the collapsed view", () => {
		const collapsed = renderCell({
			code: "await edit(...); await edit(...)",
			details: {
				status: "ok",
				diffs: [
					{ path: "a.py", oldStr: "one", newStr: "ONE", startLine: 1 },
					{ path: "b.py", oldStr: "two", newStr: "TWO", startLine: 2 },
				],
			},
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		expect(collapsed).toContain("a.py");
		expect(collapsed).toContain("b.py");
		expect(collapsed).toContain("ONE");
		expect(collapsed).toContain("TWO");
	});

	it("keeps non-edit cells collapsed to a single summary line", () => {
		const collapsed = renderCell({
			code: "print('hello')",
			details: { status: "ok", durationMs: 3, stdout: "hello\nworld\nmore\noutput\nlines" },
			executionStarted: true,
			argsComplete: true,
			expanded: false,
		});
		// No diffs → the collapsed view stays a single line; output hides behind expand.
		expect(collapsed.split("\n")).toHaveLength(1);
		expect(collapsed).toContain("to expand");
		expect(collapsed).not.toContain("world");
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
		expect(out.split("\n").filter((l) => l.includes("app.py")).length).toBe(1);
		expect(out).toMatch(/app\.py\s+\+3\s+-3/);
		// Hunks are separated by the vertical-ellipsis marker.
		expect((out.match(/⋮/g) ?? []).length).toBe(2);
	});
});
