import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

/**
 * Covers the wiring around autonomous events rather than their payloads: every bug
 * in this area was an ordering or lifecycle fault, not a wrong field.
 */
let harness: Harness | undefined;

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
});

function eventTypes(current: Harness): string[] {
	return current.events.map((event) => event.type);
}

describe("autonomous event lifecycle", () => {
	it("emits gate and continuation events before the turn they cause", async () => {
		harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2, gates: { commands: ["exit 3"], maxRetries: 5 } },
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("go");
		await harness.session.agent.waitForIdle();

		const types = eventTypes(harness);
		expect(types).toContain("autonomous_gate_start");
		expect(types).toContain("autonomous_gate_end");
		expect(types).toContain("autonomous_continuation");

		// The frames must precede the continuation turn, not trail it.
		const continuationAt = types.indexOf("autonomous_continuation");
		const lastTurnStart = types.lastIndexOf("turn_start");
		expect(lastTurnStart).toBeGreaterThan(-1);
		expect(continuationAt).toBeLessThan(lastTurnStart);
	});

	it("reports a gate failure with its command and attempt", async () => {
		harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1, gates: { commands: ["exit 3"], maxRetries: 5 } },
		});
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("go");
		await harness.session.agent.waitForIdle();

		const failure = harness.eventsOfType("autonomous_gate_end").find((event) => !event.passed);
		expect(failure).toMatchObject({ command: "exit 3", passed: false, maxRetries: 5 });
		expect(failure?.attempt).toBeGreaterThanOrEqual(1);
	});

	it("never reports the same limit twice", async () => {
		harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1, gates: { commands: ["exit 3"], maxRetries: 5 } },
		});
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);

		await harness.session.prompt("go");
		await harness.session.agent.waitForIdle();

		const limits = harness.eventsOfType("autonomous_limit_reached");
		expect(limits.length).toBeLessThanOrEqual(1);
		const reasons = new Set(limits.map((event) => event.reason));
		expect(reasons.size).toBe(limits.length);
	});

	it("emits nothing autonomous when the mode is off", async () => {
		harness = await createHarness();
		harness.setResponses([fauxAssistantMessage("done")]);

		await harness.session.prompt("go");
		await harness.session.agent.waitForIdle();

		expect(eventTypes(harness).filter((type) => type.startsWith("autonomous_"))).toEqual([]);
	});
});
