import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAutonomousRuntimeState,
	DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
	shouldAutonomouslyContinue,
} from "../../src/core/autonomous.js";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "./harness.js";

describe("AgentSession autonomous mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("injects a host-side continuation when the assistant asks the user for help", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Which package manager should I use?"),
			fauxAssistantMessage("I inspected the repo and used npm."),
		]);

		await harness.session.prompt("fix the project");

		expect(getAssistantTexts(harness)).toEqual([
			"Which package manager should I use?",
			"I inspected the repo and used npm.",
		]);
		expect(getUserTexts(harness)).toEqual(["fix the project", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
		});
	});

	it("does not continue through a concrete external blocker", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 2 },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Blocked: this requires an API key credential from the user.")]);

		await harness.session.prompt("run the private eval");

		expect(getUserTexts(harness)).toEqual(["run the private eval"]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 0,
			turnsUsed: 1,
		});
	});

	it("stops after the configured autonomous continuation limit", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Can you confirm the test command?"),
			fauxAssistantMessage("Can you confirm whether to run lint too?"),
		]);

		await harness.session.prompt("make the change");

		expect(getAssistantTexts(harness)).toEqual([
			"Can you confirm the test command?",
			"Can you confirm whether to run lint too?",
		]);
		expect(getUserTexts(harness)).toEqual(["make the change", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("supports /autonomous on and off without calling the model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/autonomous on");
		await harness.session.prompt("/autonomous off");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		const statusMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "autonomous_status",
		);
		expect(statusMessages).toHaveLength(2);
	});

	it("classifies soft blockers separately from real external blockers", () => {
		const state = createAutonomousRuntimeState({ enabled: true });

		expect(
			shouldAutonomouslyContinue(state, fauxAssistantMessage("I'm blocked. What should I try next?")),
		).toMatchObject({
			shouldContinue: true,
			reason: "asks_user",
		});
		expect(
			shouldAutonomouslyContinue(state, fauxAssistantMessage("Blocked: this requires OAuth login from the user.")),
		).toMatchObject({
			shouldContinue: false,
			reason: "real_blocker",
		});
	});
});
