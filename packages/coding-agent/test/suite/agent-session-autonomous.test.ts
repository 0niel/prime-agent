import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	addAutonomousUsage,
	createAutonomousRuntimeState,
	DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT,
	nextAutonomousContinuation,
	shouldAutonomouslyContinue,
} from "../../src/core/autonomous.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";

describe("AgentSession autonomous mode", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("injects a host-side continuation when the assistant asks the user for help", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
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

	it("continues through a claimed external blocker instead of trusting prose", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Blocked: this requires an API key credential from the user."),
			fauxAssistantMessage(
				"I will inspect the environment and verify whether the credential is actually unavailable.",
			),
		]);

		await harness.session.prompt("run the private eval");

		expect(getUserTexts(harness)).toEqual(["run the private eval", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus()).toMatchObject({
			enabled: true,
			continuationsUsed: 1,
			turnsUsed: 2,
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

	it("continues when the assistant tries to finish without terminal evidence", async () => {
		const harness = await createHarness({
			autonomous: { enabled: true, maxContinuations: 1 },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("I will collect concrete evidence.")]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change", DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("continues after a git worktree change instead of letting the agent self-terminate", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		execFileSync("git", ["init"], { cwd: harness.tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: harness.tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: harness.tempDir });
		const path = join(harness.tempDir, "file.txt");
		writeFileSync(path, "before\n");
		execFileSync("git", ["add", "file.txt"], { cwd: harness.tempDir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: harness.tempDir,
			stdio: "ignore",
		});
		await harness.session.prompt("/autonomous on");
		writeFileSync(path, "after\n");
		harness.setResponses([
			fauxAssistantMessage("Done."),
			fauxAssistantMessage("Continuing until the evaluator stops me."),
		]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)[0]).toBe("make the change");
		expect(getUserTexts(harness).slice(1)).toContain(DEFAULT_AUTONOMOUS_CONTINUATION_PROMPT);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBeGreaterThan(0);
	});

	it("lets passing autonomous gates complete the run under verifier control", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				gates: { commands: [`${process.execPath} -e "process.exit(0)"`] },
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done.")]);

		await harness.session.prompt("make the change");

		expect(getUserTexts(harness)).toEqual(["make the change"]);
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(0);
	});

	it("feeds failing autonomous gate output back into the session", async () => {
		const harness = await createHarness({
			autonomous: {
				enabled: true,
				maxContinuations: 1,
				gates: {
					commands: [`${process.execPath} -e "console.error('gate failed'); process.exit(1)"`],
					maxRetries: 2,
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("I will fix the gate failure.")]);

		await harness.session.prompt("make the change");

		const users = getUserTexts(harness);
		expect(users[1]).toContain("Autonomous quality gate failed");
		expect(users[1]).toContain("gate failed");
		expect(harness.session.getAutonomousStatus().continuationsUsed).toBe(1);
	});

	it("advances retry budget without rerunning a failed autonomous gate until the workspace changes", () => {
		const tempDir = join(process.cwd(), `.tmp-autonomous-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		execFileSync("mkdir", ["-p", join(tempDir, "verification")]);
		execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
		execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir });
		execFileSync("git", ["config", "user.name", "Test User"], { cwd: tempDir });
		writeFileSync(join(tempDir, "src.rs"), "initial\n");
		execFileSync("git", ["add", "src.rs"], { cwd: tempDir });
		execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "--no-gpg-sign", "-m", "initial"], {
			cwd: tempDir,
			stdio: "ignore",
		});
		try {
			const counter = join(tempDir, "verification", "public_feedback_scores.jsonl");
			const gate = `${process.execPath} -e "const fs=require('fs'); const p='${counter}'; const n=fs.existsSync(p)?fs.readFileSync(p,'utf8').trim().split(/\\n/).filter(Boolean).length:0; fs.appendFileSync(p,JSON.stringify({run:n+1,score:0})+'\\n'); process.exit(1);"`;
			const state = createAutonomousRuntimeState(
				{ enabled: true, maxContinuations: 3, gates: { commands: [gate], maxRetries: 3 } },
				{ cwd: tempDir },
			);

			const first = nextAutonomousContinuation(state, fauxAssistantMessage("Done."), { cwd: tempDir });
			writeFileSync(join(tempDir, "Cargo.lock"), "generated lockfile\n");
			const second = nextAutonomousContinuation(state, fauxAssistantMessage("Still done."), { cwd: tempDir });

			expect(first).toBeDefined();
			expect(second).toBeDefined();
			expect(getMessageText(second)).toContain("workspace has not changed");
			expect(getMessageText(second)).toContain("Edit source files");
			expect(readFileSync(counter, "utf8").trim().split(/\n/)).toHaveLength(1);
			expect(state.gateAttempts[gate]).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not count cache-read tokens against the autonomous token budget", () => {
		const state = createAutonomousRuntimeState({ enabled: true, maxTokens: 10 });

		addAutonomousUsage(state, {
			input: 2,
			output: 3,
			cacheRead: 1_000,
			cacheWrite: 4,
			totalTokens: 1_009,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		});

		expect(state.tokensUsed).toBe(9);
		expect(shouldAutonomouslyContinue(state, fauxAssistantMessage("Done."))).toMatchObject({
			shouldContinue: true,
		});
	});

	it("does not use assistant prose as terminal blocker evidence", () => {
		const state = createAutonomousRuntimeState({ enabled: true });

		expect(
			shouldAutonomouslyContinue(state, fauxAssistantMessage("I'm blocked. What should I try next?")),
		).toMatchObject({
			shouldContinue: true,
			reason: "missing_terminal_evidence",
		});
		expect(
			shouldAutonomouslyContinue(state, fauxAssistantMessage("Blocked: this requires OAuth login from the user.")),
		).toMatchObject({
			shouldContinue: true,
			reason: "missing_terminal_evidence",
		});
	});
});
