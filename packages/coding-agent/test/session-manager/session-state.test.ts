import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEntriesFromFile, SessionManager, type SessionStateEntry } from "../../src/core/session-manager.js";
import { assistantMsg, userMsg } from "../utilities.js";

describe("SessionManager session state", () => {
	it("persists lifecycle state and exposes it through list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			session.appendSessionState({ status: "crash" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const stateEntries = loadEntriesFromFile(sessionFile!).filter(
				(entry): entry is SessionStateEntry => entry.type === "session_state",
			);
			expect(stateEntries).toHaveLength(1);
			expect(stateEntries[0]!.state).toEqual({ status: "crash" });
			expect(session.getSessionState()).toEqual({ status: "crash" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "crash" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("flushes lifecycle state for sessions without assistant messages", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-empty-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionInfo("empty");
			session.appendSessionState({ status: "sleep" });

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				name: "empty",
				messageCount: 0,
				state: { status: "sleep" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("coerces legacy hidden lifecycle state to sleep on read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-hidden-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hide me"));
			session.appendSessionState({ status: "sleep" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "hidden" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "sleep" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions).toHaveLength(1);
			expect(sessions[0]).toMatchObject({
				id: session.getSessionId(),
				state: { status: "sleep" },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the last valid status when the newest entry is unrecognized", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-bad-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hi"));
			session.appendSessionState({ status: "active" });
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			appendFileSync(sessionFile!, `${JSON.stringify({ type: "session_state", state: { status: "bogus" } })}\n`);

			expect(SessionManager.open(sessionFile!, sessionDir).getSessionState()).toEqual({ status: "active" });

			const sessions = await SessionManager.list(cwd, sessionDir);
			expect(sessions[0]).toMatchObject({ id: session.getSessionId(), state: { status: "active" } });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate entries when lifecycle state is followed by a normal turn", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-turn-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendSessionState({ status: "sleep" });
			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));

			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("recreates the session directory when lifecycle state is the first persisted entry", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-dir-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();

			rmSync(sessionDir, { recursive: true, force: true });
			session.appendSessionState({ status: "sleep" });

			expect(existsSync(sessionFile!)).toBe(true);
			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rewrites the full session if the session file disappears after flushing", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "session-state-missing-file-"));
		try {
			const cwd = join(tempDir, "project");
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(cwd, sessionDir);

			session.appendMessage(userMsg("hello"));
			session.appendMessage(assistantMsg("hi"));
			const sessionFile = session.getSessionFile();
			expect(sessionFile).toBeDefined();
			expect(existsSync(sessionFile!)).toBe(true);

			rmSync(sessionFile!, { force: true });
			session.appendSessionState({ status: "sleep" });

			const entries = loadEntriesFromFile(sessionFile!);
			expect(entries[0]).toMatchObject({ type: "session", id: session.getSessionId() });
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(2);
			expect(entries.filter((entry) => entry.type === "session_state")).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
