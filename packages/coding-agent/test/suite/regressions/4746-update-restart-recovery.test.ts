import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDaemonUpdateRestartManifestCandidates,
	getPendingDaemonUpdateRestartRecoveryKind,
	hasPendingDaemonUpdateRestartManifest,
	manifestForFailedDaemonUpdateRestores,
	mergeDaemonUpdateRestartManifests,
	writePreparedDaemonUpdateRestartManifest,
} from "../../../src/cli/daemon-update-manifest.js";
import { getLegacyDaemonUpdateRestartManifestPath } from "../../../src/config.js";
import type {
	DaemonUpdateRestartManifest,
	DaemonUpdateRestartSession,
} from "../../../src/modes/daemon/daemon-protocol.js";
import { defaultDaemonSocketPath } from "../../../src/modes/daemon/daemon-socket.js";

function updateSession(
	activeSessionId: string,
	sessionFile: string,
	parentActiveSessionId?: string,
): DaemonUpdateRestartSession {
	return {
		activeSessionId,
		sessionId: `session-${activeSessionId}`,
		sessionFile,
		cwd: "/workspace",
		config: { cwd: "/workspace", agentDir: "/agent" },
		...(parentActiveSessionId
			? { runtimeMetadata: { kind: "subagent", createdAt: 1, parentActiveSessionId } }
			: { runtimeMetadata: { kind: "top-level", createdAt: 1 } }),
		queue: { steering: [], followUp: [], nextTurn: [] },
		shouldResume: false,
		wasStreaming: false,
		wasCompacting: false,
		wasBashRunning: false,
		hadRunningRlmChildren: false,
		wasRetrying: false,
		hadAcceptedPromptInFlight: false,
	};
}

function manifest(createdAt: string, sessions: DaemonUpdateRestartSession[]): DaemonUpdateRestartManifest {
	return { createdAt, sessions };
}

describe("ENG-4746 interrupted update recovery", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		for (const path of tempDirs.splice(0)) {
			rmSync(path, { recursive: true, force: true });
		}
	});

	it("merges orphaned sessions with newer daemon state without replaying duplicate sessions", () => {
		const pendingParent = updateSession("old-parent", "/sessions/parent.jsonl");
		pendingParent.shouldResume = true;
		pendingParent.wasStreaming = true;
		const pendingChild = updateSession("old-child", "/sessions/child.jsonl", "old-parent");
		const currentParent = updateSession("new-parent", "/sessions/parent.jsonl");
		const currentOnly = updateSession("current-only", "/sessions/current.jsonl");

		const merged = mergeDaemonUpdateRestartManifests(
			manifest("2026-07-20T23:14:05.579Z", [pendingChild, pendingParent]),
			manifest("2026-07-20T23:14:19.444Z", [currentOnly, currentParent]),
		);

		expect(merged.createdAt).toBe("2026-07-20T23:14:19.444Z");
		expect(merged.sessions.map((session) => session.activeSessionId)).toEqual([
			"new-parent",
			"old-child",
			"current-only",
		]);
		expect(merged.sessions[0]).toBe(currentParent);
		expect(merged.sessions[0]?.shouldResume).toBe(false);
		expect(merged.sessions[1]?.runtimeMetadata?.parentActiveSessionId).toBe("new-parent");
	});

	it("detects socket-scoped recovery state and scopes legacy manifests to the default daemon", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "eng-4746-manifest-"));
		tempDirs.push(agentDir);
		const customSocket = join(agentDir, "custom.sock");
		const defaultSocket = defaultDaemonSocketPath();
		const legacyPath = getLegacyDaemonUpdateRestartManifestPath(agentDir);

		expect(getDaemonUpdateRestartManifestCandidates(customSocket, agentDir)).not.toContain(legacyPath);
		expect(getDaemonUpdateRestartManifestCandidates(defaultSocket, agentDir)).toContain(legacyPath);
		writePreparedDaemonUpdateRestartManifest(
			customSocket,
			agentDir,
			manifest("2026-07-20T23:14:05.579Z", [updateSession("pending", "/sessions/pending.jsonl")]),
		);
		expect(hasPendingDaemonUpdateRestartManifest(customSocket, agentDir)).toBe(true);
		expect(getPendingDaemonUpdateRestartRecoveryKind(customSocket, agentDir)).toBe("restart");
		const retryManifest = manifestForFailedDaemonUpdateRestores(
			manifest("2026-07-20T23:15:05.579Z", [updateSession("failed", "/sessions/failed.jsonl")]),
			["/sessions/failed.jsonl"],
		);
		if (!retryManifest) {
			throw new Error("Expected a retry manifest");
		}
		writePreparedDaemonUpdateRestartManifest(customSocket, agentDir, retryManifest);
		expect(getPendingDaemonUpdateRestartRecoveryKind(customSocket, agentDir)).toBe("retry");
	});

	it("removes legacy recovery state when persisting canonical default-daemon state", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "eng-4746-manifest-"));
		tempDirs.push(agentDir);
		const defaultSocket = defaultDaemonSocketPath();
		const legacyPath = getLegacyDaemonUpdateRestartManifestPath(agentDir);
		writeFileSync(
			legacyPath,
			`${JSON.stringify(manifest("old", [updateSession("restored", "/sessions/restored.jsonl")]))}\n`,
		);

		writePreparedDaemonUpdateRestartManifest(
			defaultSocket,
			agentDir,
			manifest("new", [updateSession("failed", "/sessions/failed.jsonl")]),
		);

		expect(existsSync(legacyPath)).toBe(false);
	});

	it("retains only sessions whose restore failed", () => {
		const restored = updateSession("restored", "/sessions/restored.jsonl");
		const failed = updateSession("failed", "/sessions/failed.jsonl");
		const remainder = manifestForFailedDaemonUpdateRestores(
			manifest("2026-07-20T23:14:05.579Z", [restored, failed]),
			["/sessions/failed.jsonl"],
		);

		expect(remainder?.sessions).toEqual([failed]);
		expect(remainder?.retryOnly).toBe(true);
		expect(manifestForFailedDaemonUpdateRestores(manifest("now", [restored]), [])).toBeUndefined();
	});

	it("retains parent context needed to retry a failed subagent restore", () => {
		const parent = updateSession("parent", "/sessions/parent.jsonl");
		parent.queue = {
			steering: [{ message: "steer again" }],
			followUp: [{ message: "follow up again" }],
			nextTurn: [
				{
					role: "custom",
					customType: "test.next-turn",
					content: "next turn again",
					display: true,
					timestamp: 1,
				},
			],
			acceptedPrompt: { message: "accepted again", nextTurn: [] },
		};
		parent.shouldResume = true;
		parent.wasStreaming = true;
		parent.wasCompacting = true;
		parent.wasBashRunning = true;
		parent.hadRunningRlmChildren = true;
		parent.wasRetrying = true;
		parent.hadAcceptedPromptInFlight = true;
		const failedChild = updateSession("child", "/sessions/child.jsonl", "parent");
		failedChild.shouldResume = true;
		failedChild.wasStreaming = true;
		const remainder = manifestForFailedDaemonUpdateRestores(
			manifest("2026-07-20T23:14:05.579Z", [parent, failedChild]),
			[failedChild.sessionFile],
		);

		expect(remainder?.sessions).toEqual([
			{
				...parent,
				queue: { steering: [], followUp: [], nextTurn: [] },
				shouldResume: false,
				wasStreaming: false,
				wasCompacting: false,
				wasBashRunning: false,
				hadRunningRlmChildren: false,
				wasRetrying: false,
				hadAcceptedPromptInFlight: false,
			},
			failedChild,
		]);
	});
});
