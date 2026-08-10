import { type ChildProcess, spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSessionFileLockForTest,
	loadEntriesFromFile,
	SessionManager,
	setSessionLockIdentitylessClaimHookForTest,
	setSessionLockReclaimHookForTest,
	tryReclaimDeadSessionFileLockForTest,
} from "../../../src/core/session-manager.js";
import { createHarness, type Harness } from "../harness.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/session-tail-writer.ts");

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function waitForChild(child: ChildProcess): Promise<void> {
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`Session writer exited with code ${code} signal ${signal}`));
		});
	});
}

describe("regression #928: incomplete session tails", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		setSessionLockIdentitylessClaimHookForTest(undefined);
		setSessionLockReclaimHookForTest(undefined);
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSession(): Promise<{ harness: Harness; path: string; content: Buffer }> {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("before crash")]);
		await harness.session.prompt("persist this turn");
		const path = harness.sessionManager.getSessionFile();
		if (!path) throw new Error("Expected a persisted session path");
		return { harness, path, content: readFileSync(path) };
	}

	it.each([
		["mid-JSON", Buffer.from('{"type":"message","id":"torn"')],
		["mid-UTF-8", Buffer.from('{"type":"message","content":"\u{1F642}').subarray(0, -1)],
	])("truncates an incomplete %s tail before the next append", async (_name, tail) => {
		const { path, content } = await createSession();
		appendFileSync(path, tail);
		const tornContent = readFileSync(path);

		const resumed = SessionManager.open(path);
		expect(readFileSync(path)).toEqual(tornContent);
		resumed.appendSessionInfo("recovered");

		expect(resumed.getFileRecovery()).toEqual({
			action: "truncate",
			originalSize: tornContent.length,
			repairedSize: content.length,
			discardedBytes: tail.length,
		});
		expect(readFileSync(path).subarray(0, content.length)).toEqual(content);
		expect(SessionManager.open(path).getSessionName()).toBe("recovered");
	});

	it("adds a delimiter after a complete final record without a newline", async () => {
		const { path, content } = await createSession();
		const unterminated = content.subarray(0, -1);
		writeFileSync(path, unterminated);

		const resumed = SessionManager.open(path);
		expect(readFileSync(path)).toEqual(unterminated);
		resumed.appendSessionInfo("after complete record");

		expect(resumed.getFileRecovery()).toEqual({
			action: "append-newline",
			originalSize: unterminated.length,
			repairedSize: content.length,
			discardedBytes: 0,
		});
		expect(SessionManager.open(path).getSessionName()).toBe("after complete record");
	});

	it("preserves malformed middle rows byte-for-byte while repairing only the tail", async () => {
		const { path, content } = await createSession();
		const firstNewline = content.indexOf(0x0a);
		const malformedMiddle = Buffer.from("malformed middle row\n");
		const preserved = Buffer.concat([
			content.subarray(0, firstNewline + 1),
			malformedMiddle,
			content.subarray(firstNewline + 1),
		]);
		const tornTail = Buffer.from('{"type":"message","id":');
		writeFileSync(path, Buffer.concat([preserved, tornTail]));

		const resumed = SessionManager.open(path);
		resumed.appendSessionInfo("kept raw bytes");

		expect(readFileSync(path).subarray(0, preserved.length)).toEqual(preserved);
		expect(resumed.getFileRecovery()?.discardedBytes).toBe(tornTail.length);
		expect(SessionManager.open(path).getSessionName()).toBe("kept raw bytes");
	});

	it("does not mutate empty or torn files during read-only loading", () => {
		const directory = mkdtempSync(join(tmpdir(), "session-tail-readonly-"));
		const path = join(directory, "session.jsonl");
		const torn = Buffer.from('{"type":"session"');
		writeFileSync(path, torn);
		try {
			expect(loadEntriesFromFile(path)).toEqual([]);
			expect(readFileSync(path)).toEqual(torn);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("does not repeat recovery after a repaired file is reopened", async () => {
		const { path } = await createSession();
		appendFileSync(path, '{"type":"message"');
		const firstResume = SessionManager.open(path);
		firstResume.appendSessionInfo("first recovery");

		const secondResume = SessionManager.open(path);
		expect(secondResume.getFileRecovery()).toBeUndefined();
		secondResume.appendSessionInfo("second append");

		expect(SessionManager.open(path).getSessionName()).toBe("second append");
	});

	it("serializes delayed repair with a concurrent appender without losing either write", async () => {
		const { harness, path } = await createSession();
		appendFileSync(path, '{"type":"message","id":"torn"');
		const ready = join(harness.tempDir, "repair-ready");
		const go = join(harness.tempDir, "repair-go");
		const firstStarted = join(harness.tempDir, "first-started");
		const firstDone = join(harness.tempDir, "first-done");
		const secondStarted = join(harness.tempDir, "second-started");
		const secondDone = join(harness.tempDir, "second-done");
		const run = (name: string, started: string, done: string, pause = false) =>
			spawn(
				process.execPath,
				["--import", "tsx", fixturePath, path, name, started, done, ...(pause ? [ready, go] : [])],
				{ cwd: join(dirname(fixturePath), "../../.."), stdio: "pipe" },
			);

		const first = run("first repairer", firstStarted, firstDone, true);
		await waitForFile(ready);
		const staleTime = new Date(Date.now() - 10 * 60_000);
		utimesSync(`${realpathSync(path)}.lock`, staleTime, staleTime);
		const second = run("concurrent appender", secondStarted, secondDone);
		await waitForFile(secondStarted);
		expect(existsSync(secondDone)).toBe(false);
		writeFileSync(go, "go");
		await Promise.all([waitForChild(first), waitForChild(second)]);
		const recoveries = [JSON.parse(readFileSync(firstDone, "utf-8")), JSON.parse(readFileSync(secondDone, "utf-8"))];
		expect(recoveries.filter((recovery) => recovery?.action === "truncate")).toHaveLength(1);

		const names = loadEntriesFromFile(path)
			.filter((entry) => entry.type === "session_info")
			.map((entry) => entry.name);
		expect(names).toEqual(expect.arrayContaining(["first repairer", "concurrent appender"]));
		expect(
			readFileSync(path)
				.toString("utf8")
				.trim()
				.split("\n")
				.every((line) => JSON.parse(line)),
		).toBe(true);
	});

	it("serializes two managers opened on the same torn tail so exactly one repairs", async () => {
		const { harness, path } = await createSession();
		appendFileSync(path, '{"type":"message","id":"torn"');
		const marker = (name: string) => join(harness.tempDir, name);
		const first = {
			started: marker("first-started-2"),
			done: marker("first-done-2"),
			ready: marker("first-ready-2"),
			go: marker("first-go-2"),
			opened: marker("first-opened-2"),
			appendGo: marker("first-append-go-2"),
			attempt: marker("first-attempt-2"),
		};
		const second = {
			started: marker("second-started-2"),
			done: marker("second-done-2"),
			opened: marker("second-opened-2"),
			appendGo: marker("second-append-go-2"),
			attempt: marker("second-attempt-2"),
		};
		const launch = (name: string, paths: string[]) =>
			spawn(process.execPath, ["--import", "tsx", fixturePath, path, name, ...paths], {
				cwd: join(dirname(fixturePath), "../../.."),
				stdio: "pipe",
			});
		const firstChild = launch("first preopened repairer", [
			first.started,
			first.done,
			first.ready,
			first.go,
			first.opened,
			first.appendGo,
			first.attempt,
		]);
		const secondChild = launch("second preopened repairer", [
			second.started,
			second.done,
			"",
			"",
			second.opened,
			second.appendGo,
			second.attempt,
		]);
		await Promise.all([waitForFile(first.opened), waitForFile(second.opened)]);
		writeFileSync(first.appendGo, "go");
		await waitForFile(first.ready);
		writeFileSync(second.appendGo, "go");
		await waitForFile(second.attempt);
		expect(existsSync(second.done)).toBe(false);
		writeFileSync(first.go, "go");
		await Promise.all([waitForChild(firstChild), waitForChild(secondChild)]);

		const recoveries = [
			JSON.parse(readFileSync(first.done, "utf-8")),
			JSON.parse(readFileSync(second.done, "utf-8")),
		];
		expect(recoveries.filter((recovery) => recovery?.action === "truncate")).toHaveLength(1);
		const names = loadEntriesFromFile(path)
			.filter((entry) => entry.type === "session_info")
			.map((entry) => entry.name);
		expect(names).toEqual(expect.arrayContaining(["first preopened repairer", "second preopened repairer"]));
	});

	it.runIf(process.platform !== "win32")(
		"reclaims a crash-left session lock immediately after the owner is killed",
		async () => {
			const { harness, path } = await createSession();
			appendFileSync(path, '{"type":"message","id":"torn"');
			const ready = join(harness.tempDir, "killed-owner-ready");
			const go = join(harness.tempDir, "killed-owner-go");
			const child = spawn(
				process.execPath,
				[
					"--import",
					"tsx",
					fixturePath,
					path,
					"killed owner",
					join(harness.tempDir, "killed-owner-started"),
					join(harness.tempDir, "killed-owner-done"),
					ready,
					go,
				],
				{ cwd: join(dirname(fixturePath), "../../.."), stdio: "pipe" },
			);
			await waitForFile(ready);
			const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
			child.kill("SIGKILL");
			await exited;

			const startedAt = Date.now();
			const manager = SessionManager.open(path);
			manager.appendSessionInfo("after killed owner");
			expect(Date.now() - startedAt).toBeLessThan(2_000);
			const entries = loadEntriesFromFile(path);
			expect(entries.some((entry) => entry.type === "session_info" && entry.name === "after killed owner")).toBe(
				true,
			);
		},
	);

	it.runIf(process.platform !== "win32")("reclaims an owner whose PID start identity mismatches", async () => {
		const { harness, path } = await createSession();
		appendFileSync(path, '{"type":"message","id":"torn"');
		const ready = join(harness.tempDir, "reused-pid-ready");
		const child = spawn(
			process.execPath,
			[
				"--import",
				"tsx",
				fixturePath,
				path,
				"simulated old pid owner",
				join(harness.tempDir, "reused-pid-started"),
				join(harness.tempDir, "reused-pid-done"),
				ready,
				join(harness.tempDir, "reused-pid-go"),
			],
			{ cwd: join(dirname(fixturePath), "../../.."), stdio: "pipe" },
		);
		await waitForFile(ready);
		const lockDir = `${realpathSync(path)}.lock`;
		const ownerName = readdirSync(lockDir).find((name) => name.startsWith("owner-"));
		expect(ownerName).toBeDefined();
		const ownerPath = join(lockDir, ownerName!);
		const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
		writeFileSync(ownerPath, JSON.stringify({ ...owner, processStartId: "a different process incarnation" }));

		const manager = SessionManager.open(path);
		manager.appendSessionInfo("after simulated pid reuse");
		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
		expect(
			loadEntriesFromFile(path).some(
				(entry) => entry.type === "session_info" && entry.name === "after simulated pid reuse",
			),
		).toBe(true);
	});

	it("does not release a replacement lock generation", async () => {
		const { path } = await createSession();
		const targetPath = realpathSync(path);
		const lockDir = `${targetPath}.lock`;
		const savedLockDir = `${lockDir}.saved`;
		const release = acquireSessionFileLockForTest(targetPath);
		renameSync(lockDir, savedLockDir);
		mkdirSync(lockDir);
		const replacementOwner = join(lockDir, "owner-replacement.json");
		writeFileSync(
			replacementOwner,
			JSON.stringify({ generation: "replacement", pid: process.pid, createdAt: Date.now() }),
		);

		expect(release).toThrow(/generation was replaced/);
		expect(existsSync(replacementOwner)).toBe(true);
		rmSync(lockDir, { recursive: true, force: true });
		renameSync(savedLockDir, lockDir);
		release();
	});

	it("reclaims an identity-less lock only after the stale fallback", async () => {
		const { path } = await createSession();
		const targetPath = realpathSync(path);
		const lockDir = `${targetPath}.lock`;
		mkdirSync(lockDir);
		expect(tryReclaimDeadSessionFileLockForTest(targetPath)).toBe(false);
		const staleTime = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockDir, staleTime, staleTime);

		expect(tryReclaimDeadSessionFileLockForTest(targetPath)).toBe(true);
		expect(existsSync(lockDir)).toBe(false);
	});

	it("does not quarantine a replacement during identity-less stale claiming", async () => {
		const { path } = await createSession();
		const targetPath = realpathSync(path);
		const lockDir = `${targetPath}.lock`;
		mkdirSync(lockDir);
		const staleTime = new Date(Date.now() - 10 * 60_000);
		utimesSync(lockDir, staleTime, staleTime);
		const replacementMarker = join(lockDir, "replacement-owner");
		setSessionLockIdentitylessClaimHookForTest(() => {
			rmSync(lockDir, { recursive: true, force: true });
			mkdirSync(lockDir);
			writeFileSync(replacementMarker, "live replacement");
		});

		expect(tryReclaimDeadSessionFileLockForTest(targetPath)).toBe(false);
		expect(readFileSync(replacementMarker, "utf8")).toBe("live replacement");
		expect(existsSync(lockDir)).toBe(true);
	});

	it("does not reclaim a lock whose recorded owner is still live", async () => {
		const { path } = await createSession();
		const targetPath = realpathSync(path);
		const lockDir = `${targetPath}.lock`;
		mkdirSync(lockDir);
		const generation = "live-generation";
		const ownerPath = join(lockDir, `owner-${generation}.json`);
		writeFileSync(ownerPath, JSON.stringify({ generation, pid: process.pid, createdAt: Date.now() }));

		expect(tryReclaimDeadSessionFileLockForTest(targetPath)).toBe(false);
		expect(existsSync(ownerPath)).toBe(true);
	});

	it("does not reclaim a replacement generation after observing a dead owner", async () => {
		const { path } = await createSession();
		const targetPath = realpathSync(path);
		const lockDir = `${targetPath}.lock`;
		mkdirSync(lockDir);
		const oldGeneration = "old-generation";
		const oldOwnerPath = join(lockDir, `owner-${oldGeneration}.json`);
		writeFileSync(
			oldOwnerPath,
			JSON.stringify({ generation: oldGeneration, pid: 2_147_483_647, createdAt: Date.now() }),
		);
		const newGeneration = "replacement-generation";
		const newOwnerPath = join(lockDir, `owner-${newGeneration}.json`);
		setSessionLockReclaimHookForTest(({ ownerPath, generation }) => {
			expect(generation).toBe(oldGeneration);
			unlinkSync(ownerPath);
			writeFileSync(
				newOwnerPath,
				JSON.stringify({ generation: newGeneration, pid: process.pid, createdAt: Date.now() }),
			);
		});

		expect(tryReclaimDeadSessionFileLockForTest(targetPath)).toBe(false);
		expect(existsSync(newOwnerPath)).toBe(true);
		expect(existsSync(lockDir)).toBe(true);
	});

	it("fails closed instead of allocating or truncating an oversized unterminated record", async () => {
		const { path } = await createSession();
		appendFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 2, 0x78));
		const before = statSync(path).size;

		const resumed = SessionManager.open(path);
		expect(resumed.getFileRecovery()).toMatchObject({ action: "manual-recovery", originalSize: before });
		expect(() => resumed.appendSessionInfo("must not append")).toThrow(/manual session recovery is required/);
		expect(statSync(path).size).toBe(before);
	});

	it("does not let open-time migration rewrite an oversized manual-recovery tail", async () => {
		const { path, content } = await createSession();
		const legacy = Buffer.from(content.toString("utf8").replace('"version":3', '"version":2'));
		const oversized = Buffer.concat([legacy, Buffer.alloc(8 * 1024 * 1024 + 2, 0x78)]);
		writeFileSync(path, oversized);

		expect(() => SessionManager.open(path)).toThrow(/manual session recovery is required/);
		expect(readFileSync(path)).toEqual(oversized);
	});

	it.runIf(process.platform !== "win32")("creates new session files with private permissions", async () => {
		const previousUmask = process.umask(0);
		try {
			const { path } = await createSession();
			expect(statSync(path).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(previousUmask);
		}
	});
});
