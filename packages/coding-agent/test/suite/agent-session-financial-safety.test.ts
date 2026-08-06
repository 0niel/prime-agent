import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, type Harness } from "./harness.js";

type SessionInternals = {
	_processAgentEvent: (event: AgentEvent) => Promise<void>;
	_activeRlmChildRuns: Map<string, unknown>;
};

function providerFailure(kind: string, errorMessage: string, requestId = "req_test"): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind, status: 429, requestId },
			},
		],
	};
}

function activeRun(id: string, session?: AgentSession) {
	return {
		id,
		prompt: `task ${id}`,
		sessionName: id,
		sessionDir: `/tmp/${id}`,
		status: "running",
		settled: false,
		abort: vi.fn(() => session?.requestAbort()),
		publication: {
			promise: Promise.resolve(),
			resolve: vi.fn(),
			reject: vi.fn(),
		},
		session,
		emitUpdate: vi.fn(),
	};
}

describe("AgentSession financial safety", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("fails closed on quota exhaustion and requires an explicit user prompt to reset", async () => {
		const harness = await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 });
		harnesses.push(harness);
		harness.setResponses([
			providerFailure("quota", "Provider usage quota exhausted", "req_quota"),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("trigger quota").catch(() => undefined);

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("auto_retry_start")).toEqual([]);
		expect(harness.session.isProviderQuotaCircuitOpen).toBe(true);
		await expect(harness.session.prompt("scheduled work", { source: "rpc", automatic: true })).rejects.toThrow(
			/quota exhausted.*request_id: req_quota/i,
		);
		await expect(harness.session.runRlmChild("background child")).rejects.toThrow(/quota exhausted/i);
		expect(harness.faux.state.callCount).toBe(1);

		await harness.session.prompt("retry after fixing quota");

		expect(harness.session.isProviderQuotaCircuitOpen).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("keeps transient rate limits on the bounded agent-level retry path", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			providerFailure("rate_limit", "Provider rate limit exceeded"),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("retry transient failure");

		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("auto_retry_start")).toHaveLength(1);
		expect(harness.session.isProviderQuotaCircuitOpen).toBe(false);
	});

	it("persists the quota latch and its explicit reset across session reloads", async () => {
		const original = await createHarness({ persistSession: true });
		harnesses.push(original);
		await (original.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_persisted"),
		} as AgentEvent);
		original.sessionManager.flushNow();
		const sessionFile = original.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();

		const restored = await createHarness({ sessionManager: SessionManager.open(sessionFile!) });
		harnesses.push(restored);
		expect(restored.session.isProviderQuotaCircuitOpen).toBe(true);
		await expect(restored.session.prompt("scheduled work", { source: "rpc", automatic: true })).rejects.toThrow(
			/req_persisted/,
		);
		expect(restored.faux.state.callCount).toBe(0);

		restored.setResponses([fauxAssistantMessage("recovered")]);
		await restored.session.prompt("explicit retry");
		expect(restored.session.isProviderQuotaCircuitOpen).toBe(false);
		restored.sessionManager.flushNow();

		const resetReload = await createHarness({ sessionManager: SessionManager.open(sessionFile!) });
		harnesses.push(resetReload);
		expect(resetReload.session.isProviderQuotaCircuitOpen).toBe(false);
	});

	it("cascades a child quota failure to the parent and every sibling", async () => {
		const parent = await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 });
		const child = await createHarness({ rlmDepth: 1, rlmParentSession: parent.session });
		const sibling = await createHarness({ rlmDepth: 1, rlmParentSession: parent.session });
		harnesses.push(parent, child, sibling);
		const parentAbort = vi.spyOn(parent.session, "requestAbort");
		const childAbort = vi.spyOn(child.session, "requestAbort");
		const siblingAbort = vi.spyOn(sibling.session, "requestAbort");
		const childRun = activeRun("child", child.session);
		const siblingRun = activeRun("sibling", sibling.session);
		const parentInternals = parent.session as unknown as SessionInternals;
		parentInternals._activeRlmChildRuns.set("child", childRun);
		parentInternals._activeRlmChildRuns.set("sibling", siblingRun);

		await (child.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_child"),
		} as AgentEvent);

		expect(parent.session.isProviderQuotaCircuitOpen).toBe(true);
		expect(parentAbort).toHaveBeenCalled();
		expect(childAbort).toHaveBeenCalled();
		expect(siblingAbort).toHaveBeenCalled();
		expect(childRun.status).toBe("cancelled");
		expect(siblingRun.status).toBe("cancelled");
		expect((siblingRun as typeof siblingRun & { error?: string }).error).toContain("req_child");
	});

	it("shares the quota circuit through the inline subagent runtime", async () => {
		const harness = await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 });
		harnesses.push(harness);
		harness.setResponses([providerFailure("quota", "premium request quota exceeded", "req_inline_child")]);

		const spawned = await harness.session.runRlmChild("trigger quota in inline child");
		await vi.waitFor(() => expect(harness.session.isProviderQuotaCircuitOpen).toBe(true));

		const terminalUpdate = harness
			.eventsOfType("rlm_child_update")
			.reverse()
			.find((event) => event.child.id === spawned.rlm_child_id && event.child.status === "cancelled");
		expect(terminalUpdate?.child.error).toContain("req_inline_child");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps explicit abort cascading to active children", async () => {
		const harness = await createHarness({ rlmDepth: 0, rlmMaxDepth: 1 });
		harnesses.push(harness);
		const run = activeRun("child");
		(harness.session as unknown as SessionInternals)._activeRlmChildRuns.set("child", run);

		await harness.session.abort();

		expect(run.status).toBe("cancelled");
		expect(run.abort).toHaveBeenCalledOnce();
	});
});
