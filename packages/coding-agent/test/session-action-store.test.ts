import type { UserMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ActionLifecycle,
	ActionStore,
	canSelectSessionAction,
	type DeliveryPolicy,
	type RuntimeActivity,
	type SessionAction,
	transitionSessionAction,
} from "../src/core/session-action-store.js";

let nextId = 0;

function turn(text: string, delivery: DeliveryPolicy = "when_run_idle"): SessionAction {
	const id = `action-${nextId++}`;
	const message: UserMessage = { role: "user", content: text, timestamp: nextId };
	return {
		id,
		source: "internal",
		delivery,
		wake: "external_resume",
		payload: {
			kind: "turn",
			text,
			records: [{ id: `record-${id}`, role: "primary", message, started: false, durable: false, ownerActionId: id }],
		},
		lifecycle: { state: "queued" },
	};
}

function command(text: string, delivery: DeliveryPolicy = "when_run_idle"): SessionAction {
	return {
		id: `action-${nextId++}`,
		source: "internal",
		delivery,
		wake: "immediate",
		payload: {
			kind: "session_command",
			text,
			command: { name: "compact", args: "", text },
		},
		lifecycle: { state: "queued" },
	};
}

function selectBatch(store: ActionStore, mode: "one-at-a-time" | "all"): SessionAction[] {
	const first = store.selectFirst();
	if (!first) return [];
	if (first.payload.kind === "session_command" || mode === "one-at-a-time") return [first];
	const batch = [first];
	while (store.queuedActions(first.delivery)[0]?.payload.kind === "turn") {
		const next = store.selectFirst();
		if (!next) break;
		batch.push(next);
	}
	return batch;
}

function activity(overrides: Partial<RuntimeActivity> = {}): RuntimeActivity {
	return {
		lowerAgentRun: false,
		compaction: false,
		retry: false,
		bash: false,
		refinementApply: false,
		branchMutation: false,
		schedulerPauseCount: 0,
		disposing: false,
		mandatoryCheckpointsComplete: true,
		...overrides,
	};
}

describe("ActionStore selection", () => {
	it("uses structural policy priority and FIFO order within each policy", () => {
		const store = new ActionStore();
		const followUpOne = turn("f1");
		const steerOne = turn("s1", "next_turn_boundary");
		const followUpTwo = turn("f2");
		const steerTwo = turn("s2", "next_turn_boundary");
		for (const action of [followUpOne, steerOne, followUpTwo, steerTwo]) store.enqueue(action);

		expect(store.selectFirst()).toBe(steerOne);
		expect(store.selectFirst()).toBe(steerTwo);
		expect(store.selectFirst()).toBe(followUpOne);
		expect(store.selectFirst()).toBe(followUpTwo);
	});

	it("reads one/all mode at selection time and never batches across a command barrier or policy", () => {
		const store = new ActionStore();
		const first = turn("p1", "next_turn_boundary");
		const second = turn("p2", "next_turn_boundary");
		const barrier = command("/compact", "next_turn_boundary");
		const afterBarrier = turn("p3", "next_turn_boundary");
		const followUp = turn("f1");
		for (const action of [first, second, barrier, afterBarrier, followUp]) store.enqueue(action);

		const mode: "one-at-a-time" | "all" = "all";
		expect(selectBatch(store, mode)).toEqual([first, second]);
		expect(selectBatch(store, mode)).toEqual([barrier]);
		expect(selectBatch(store, "one-at-a-time")).toEqual([afterBarrier]);
		expect(selectBatch(store, mode)).toEqual([followUp]);
	});

	it("does not let an executing /compact see itself as a queued successor", () => {
		const store = new ActionStore();
		const compact = command("/compact");
		store.enqueue(compact);
		expect(store.selectFirst()).toBe(compact);
		transitionSessionAction(compact, { state: "running", execution: "session_command" });

		expect(store.queuedActions()).toEqual([]);
		expect(store.activeActions()).toEqual([compact]);
	});

	it("supports front insertion without changing rollback-at-original-position", () => {
		const store = new ActionStore();
		const selected = turn("selected");
		const tail = turn("tail");
		store.enqueue(selected);
		store.enqueue(tail);
		expect(store.selectFirst()).toBe(selected);
		const front = turn("goal context");
		store.enqueueFront(front);

		store.rollback(selected);
		expect(store.queuedActions()).toEqual([selected, front, tail]);
	});
});

describe("session action lifecycle", () => {
	it("guards legal transitions and rejects post-dispatch rollback without non-delivery proof", () => {
		const action = turn("hello");
		transitionSessionAction(action, { state: "selected" });
		transitionSessionAction(action, { state: "preparing" });
		transitionSessionAction(action, { state: "committing" });

		expect(() => transitionSessionAction(action, { state: "queued" })).toThrow(/transcript proof/);
		const primary = action.payload.kind === "turn" ? action.payload.records[0] : undefined;
		if (!primary) throw new Error("missing primary record");
		expect(() =>
			transitionSessionAction(
				action,
				{ state: "queued" },
				{ rollbackProof: { dispatchSettled: true, transcript: [primary.message] } },
			),
		).toThrow(/durable/);
		transitionSessionAction(
			action,
			{ state: "queued" },
			{ rollbackProof: { dispatchSettled: true, transcript: [] } },
		);
		expect(action.lifecycle.state).toBe("queued");
	});

	it("enforces the complete legal-transition table", () => {
		const states: ActionLifecycle["state"][] = [
			"queued",
			"selected",
			"preparing",
			"committing",
			"running",
			"completed",
			"failed",
			"cancelled",
		];
		const legal: Record<ActionLifecycle["state"], readonly ActionLifecycle["state"][]> = {
			queued: ["selected", "failed", "cancelled"],
			selected: ["queued", "preparing", "running", "failed", "cancelled"],
			preparing: ["queued", "committing", "failed", "cancelled"],
			committing: ["queued", "running", "failed", "cancelled"],
			running: ["completed", "failed", "cancelled"],
			completed: [],
			failed: [],
			cancelled: [],
		};
		const lifecycle = (state: ActionLifecycle["state"]): ActionLifecycle => {
			if (state === "running") return { state, execution: "agent_turn" };
			if (state === "failed") return { state, error: new Error("failed") };
			return { state };
		};

		for (const from of states) {
			for (const to of states) {
				const action = turn(`${from}-${to}`);
				action.lifecycle = lifecycle(from);
				const transition = () =>
					transitionSessionAction(action, lifecycle(to), {
						rollbackProof:
							from === "committing" && to === "queued" ? { dispatchSettled: true, transcript: [] } : undefined,
					});
				if (legal[from].includes(to)) expect(transition).not.toThrow();
				else expect(transition).toThrow(/Illegal/);
			}
		}
	});

	it("settles each ticket leg at most once", async () => {
		const store = new ActionStore();
		const action = turn("hello");
		store.enqueue(action);
		const controller = store.ticketFor(action);
		expect(controller.settleAccepted({ status: "accepted", actionId: action.id, disposition: "queued" })).toBe(true);
		expect(controller.settleAccepted({ status: "coalesced", existingActionId: action.id })).toBe(false);
		expect(controller.settleDelivered({ status: "delivered" })).toBe(true);
		expect(controller.settleDelivered({ status: "not_applicable" })).toBe(false);
		expect(controller.settleCompleted()).toBe(true);
		expect(controller.settleCompleted(new Error("late"))).toBe(false);

		await expect(controller.ticket.accepted).resolves.toMatchObject({ status: "accepted" });
		await expect(controller.ticket.delivered).resolves.toEqual({ status: "delivered" });
		await expect(controller.ticket.completed).resolves.toBeUndefined();
	});
});

describe("scheduler capabilities", () => {
	it("blocks selection for each overlapping runtime owner", () => {
		expect(canSelectSessionAction(activity())).toBe(true);
		for (const blocked of [
			{ lowerAgentRun: true },
			{ compaction: true },
			{ retry: true },
			{ bash: true },
			{ refinementApply: true },
			{ branchMutation: true },
			{ schedulerPauseCount: 1 },
			{ disposing: true },
		]) {
			expect(canSelectSessionAction(activity(blocked))).toBe(false);
		}
	});
});
