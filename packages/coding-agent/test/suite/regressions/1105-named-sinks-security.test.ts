import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../../../src/core/export-html/index.js";
import {
	appendGlobalRefinement,
	getHarnessStatePath,
	getRefinementHistoryPath,
	loadHarnessState,
	saveHarnessState,
} from "../../../src/core/refinement/refinement.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createPrivateTempFile } from "../../../src/utils/private-files.js";

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("issue #1105 named sink security", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "prime-1105-named-sinks-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("creates unpredictable private editor/share temp files", () => {
		const first = createPrivateTempFile("prime-agent-security-test-", ".html", "secret");
		const second = createPrivateTempFile("prime-agent-security-test-", ".html", "secret");
		try {
			expect(first.path).not.toBe(second.path);
			expect(lstatSync(first.path).isSymbolicLink()).toBe(false);
			expect(statSync(first.directory).mode & 0o777).toBe(0o700);
			expect(statSync(first.path).mode & 0o777).toBe(0o600);
			expect(readFileSync(first.path, "utf8")).toBe("secret");
		} finally {
			rmSync(first.directory, { recursive: true, force: true });
			rmSync(second.directory, { recursive: true, force: true });
		}
	});

	it("writes HTML exports privately and refuses a symlink destination", async () => {
		const manager = SessionManager.create(tempRoot, join(tempRoot, "sessions"));
		manager.appendMessage({ role: "user", content: "secret export", timestamp: Date.now() });
		manager.flushNow();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Missing test session file");
		const output = join(tempRoot, "exports", "session.html");

		await exportFromFile(sessionFile, output);
		expect(statSync(output).mode & 0o777).toBe(0o600);
		expect(readFileSync(output, "utf8")).toContain('<script id="session-data"');

		const target = join(tempRoot, "outside.html");
		writeFileSync(target, "sentinel");
		unlinkSync(output);
		symlinkSync(target, output);
		await expect(exportFromFile(sessionFile, output)).rejects.toThrow("non-regular private file");
		expect(readFileSync(target, "utf8")).toBe("sentinel");
	});

	it("repairs harness modes and refuses state/history symlinks", () => {
		const harnessDir = join(tempRoot, "harness");
		mkdirSync(harnessDir, { mode: 0o777 });
		const state = loadHarnessState(harnessDir);
		const statePath = saveHarnessState(harnessDir, state);
		expect(statSync(harnessDir).mode & 0o777).toBe(0o700);
		expect(statSync(statePath).mode & 0o777).toBe(0o600);

		const outside = join(tempRoot, "outside.json");
		writeFileSync(outside, "sentinel");
		unlinkSync(getHarnessStatePath(harnessDir));
		symlinkSync(outside, getHarnessStatePath(harnessDir));
		expect(() => saveHarnessState(harnessDir, state)).toThrow("non-regular private file");
		expect(readFileSync(outside, "utf8")).toBe("sentinel");

		const historyPath = getRefinementHistoryPath(harnessDir);
		symlinkSync(outside, historyPath);
		expect(() =>
			appendGlobalRefinement(harnessDir, {
				id: "refine-test",
				summary: "summary",
				rationale: "rationale",
				expectedOutcome: "outcome",
				appliedEdits: [],
				harnessStatePath: getHarnessStatePath(harnessDir),
			}),
		).toThrow("non-regular private file");
		expect(readFileSync(outside, "utf8")).toBe("sentinel");
	});
});
