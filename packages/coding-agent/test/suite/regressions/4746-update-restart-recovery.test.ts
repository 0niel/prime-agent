import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getDaemonUpdateRestartManifestCandidates,
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
	});

	it("retains only sessions whose restore failed", () => {
		const restored = updateSession("restored", "/sessions/restored.jsonl");
		const failed = updateSession("failed", "/sessions/failed.jsonl");
		const remainder = manifestForFailedDaemonUpdateRestores(
			manifest("2026-07-20T23:14:05.579Z", [restored, failed]),
			["/sessions/failed.jsonl"],
		);

		expect(remainder?.sessions).toEqual([failed]);
		expect(manifestForFailedDaemonUpdateRestores(manifest("now", [restored]), [])).toBeUndefined();
	});

	it("retains parent context needed to retry a failed subagent restore", () => {
		const parent = updateSession("parent", "/sessions/parent.jsonl");
		const failedChild = updateSession("child", "/sessions/child.jsonl", "parent");
		const remainder = manifestForFailedDaemonUpdateRestores(
			manifest("2026-07-20T23:14:05.579Z", [parent, failedChild]),
			[failedChild.sessionFile],
		);

		expect(remainder?.sessions).toEqual([parent, failedChild]);
	});
});
