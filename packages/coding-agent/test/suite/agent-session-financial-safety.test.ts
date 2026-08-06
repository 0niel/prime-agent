import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getUserTexts, type Harness } from "./harness.js";
import { createDeferred, withStreaming } from "./scheduling.js";

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
		await expect(harness.session.prompt("/compact")).rejects.toThrow(/quota exhausted.*request_id: req_quota/i);
		expect(harness.faux.state.callCount).toBe(1);
		await harness.session.prompt("/goal");
		expect(harness.session.isProviderQuotaCircuitOpen).toBe(true);
		expect(harness.faux.state.callCount).toBe(1);

		await harness.session.prompt("retry after fixing quota");

		expect(harness.session.isProviderQuotaCircuitOpen).toBe(false);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("does not let an inbound agent message reset the quota circuit", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await (harness.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_agent_message"),
		} as AgentEvent);
		harness.setResponses([fauxAssistantMessage("must not run")]);

		await expect(harness.session.acceptAgentMessagePrompt("child cancellation notice")).rejects.toThrow(
			/quota exhausted.*req_agent_message/i,
		);

		expect(harness.session.isProviderQuotaCircuitOpen).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("allows inference-free refinement rollback while the quota circuit is open", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		await (harness.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_refine_rollback"),
		} as AgentEvent);

		await expect(harness.session.refine({ rollbackId: "missing_refinement" })).rejects.toThrow(
			"Refinement missing_refinement not found",
		);
		await harness.session.prompt("/refine rollback missing_refinement");

		expect(harness.session.isProviderQuotaCircuitOpen).toBe(true);
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("rejects recovered provider turns atomically while the quota circuit is open", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		withStreaming(source, true);
		await source.session.followUp("recover this queued turn");
		const snapshot = source.session.getSessionActionRecoverySnapshot();
		expect(snapshot.actions).toHaveLength(1);

		await (target.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_restore"),
		} as AgentEvent);

		await expect(target.session.restoreSessionActions(snapshot)).rejects.toThrow(/quota exhausted.*req_restore/i);
		expect(target.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
		expect(target.session.queuedActionCount).toBe(0);
		expect(target.faux.state.callCount).toBe(0);
	});

	it("rejects a restored provider-backed session command while the quota circuit is open", async () => {
		const source = await createHarness();
		const target = await createHarness();
		harnesses.push(source, target);
		withStreaming(source, true);
		await source.session.prompt("/compact", { streamingBehavior: "followUp" });
		const snapshot = source.session.getSessionActionRecoverySnapshot();
		expect(snapshot.actions).toEqual([
			expect.objectContaining({ payload: expect.objectContaining({ kind: "session_command" }) }),
		]);

		await (target.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_restore_command"),
		} as AgentEvent);

		await expect(target.session.restoreSessionActions(snapshot)).rejects.toThrow(
			/quota exhausted.*req_restore_command/i,
		);
		expect(target.session.getSessionActionRecoverySnapshot().actions).toEqual([]);
		expect(target.session.queuedActionCount).toBe(0);
		expect(target.faux.state.callCount).toBe(0);
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

	it("clears the live quota latch when persisting an explicit reset fails", async () => {
		const original = await createHarness({ persistSession: true });
		harnesses.push(original);
		await (original.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_reset_write"),
		} as AgentEvent);
		original.sessionManager.flushNow();
		const sessionFile = original.sessionManager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		vi.spyOn(original.sessionManager, "appendCustomEntryWithRollback").mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		original.setResponses([fauxAssistantMessage("recovered")]);

		await original.session.prompt("explicit retry despite reset persistence failure");

		expect(original.session.isProviderQuotaCircuitOpen).toBe(false);
		expect(original.faux.state.callCount).toBe(1);
		original.sessionManager.flushNow();

		const resetReload = await createHarness({ sessionManager: SessionManager.open(sessionFile!) });
		harnesses.push(resetReload);
		expect(resetReload.session.isProviderQuotaCircuitOpen).toBe(true);
	});

	it("rolls back a quota notice that fails after mutating the session tree", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const appendCustomMessage = harness.sessionManager.appendCustomMessageEntry.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendCustomMessageEntry").mockImplementationOnce(
			(customType, content, display, details) => {
				appendCustomMessage(customType, content, display, details);
				throw new Error("disk full");
			},
		);

		await (harness.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_notice_rollback"),
		} as AgentEvent);

		const branch = harness.sessionManager.getBranch();
		const circuitEntry = branch.find(
			(entry) => entry.type === "custom" && entry.customType === "prime-agent.provider-quota-circuit",
		);
		expect(circuitEntry).toBeDefined();
		expect(
			branch.some((entry) => entry.type === "custom_message" && entry.customType === "provider_quota_exhausted"),
		).toBe(false);

		const laterEntryId = harness.sessionManager.appendCustomEntryWithRollback("post-quota-test");
		expect(harness.sessionManager.getEntry(laterEntryId)?.parentId).toBe(circuitEntry?.id);
	});

	it("purges queued provider work at both session and agent layers before an explicit reset", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		withStreaming(harness, true);
		const compact = vi.spyOn(harness.session, "compact");
		await harness.session.steer("stale session steering");
		await harness.session.prompt("/compact", { streamingBehavior: "followUp" });
		harness.session.agent.steer({
			role: "user",
			content: [{ type: "text", text: "stale agent steering" }],
			timestamp: Date.now(),
		});
		harness.session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "stale agent follow-up" }],
			timestamp: Date.now(),
		});
		expect(harness.session.queuedActionCount).toBe(2);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		await (harness.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_queued"),
		} as AgentEvent);

		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.agent.hasQueuedMessages()).toBe(false);
		withStreaming(harness, false);
		harness.setResponses([fauxAssistantMessage("recovered")]);
		await harness.session.prompt("explicit retry");

		expect(harness.faux.state.callCount).toBe(1);
		expect(compact).not.toHaveBeenCalled();
		expect(getUserTexts(harness)).toEqual(["explicit retry"]);
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

	it("blocks a child when quota trips during its final name-availability check", async () => {
		const availabilityReached = createDeferred();
		const releaseAvailability = createDeferred();
		const parent = await createHarness({
			rlmDepth: 0,
			rlmMaxDepth: 1,
			agentMessageController: {
				assertSessionNameAvailable: async () => {
					availabilityReached.resolve();
					await releaseAvailability.promise;
				},
				listAgents: () => ({ agents: [] }),
				sendAgentMessage: async () => {
					throw new Error("Unexpected agent message");
				},
			},
		});
		const sibling = await createHarness({ rlmDepth: 1, rlmParentSession: parent.session });
		harnesses.push(parent, sibling);

		const spawn = parent.session.runRlmChild("race quota with child admission");
		await availabilityReached.promise;
		await (sibling.session as unknown as SessionInternals)._processAgentEvent({
			type: "message_end",
			message: providerFailure("quota", "premium request quota exceeded", "req_admission_race"),
		} as AgentEvent);
		releaseAvailability.resolve();

		await expect(spawn).rejects.toThrow(/quota exhausted.*req_admission_race/i);
		expect(parent.eventsOfType("rlm_child_update")).toEqual([]);
		expect(parent.faux.state.callCount).toBe(0);
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
