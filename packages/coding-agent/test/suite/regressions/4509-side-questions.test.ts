import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { type SideQuestionEvent, startSideQuestion } from "../../../src/core/side-question.js";
import { AgentDaemon } from "../../../src/modes/daemon/daemon-mode.js";
import { SideQuestionComponent } from "../../../src/modes/interactive/components/side-question.js";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText } from "../harness.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("ENG-4509 side questions", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("uses the current context without tools or session persistence", async () => {
		const harness = await createHarness({ systemPrompt: "Remember relevant project context." });
		try {
			harness.setResponses([fauxAssistantMessage("The codename is kestrel.")]);
			await harness.session.prompt("The project codename is kestrel.");
			harness.session.agent.sessionId = "cache-session";
			const systemPromptBefore = harness.session.agent.state.systemPrompt;
			const messagesBefore = structuredClone(harness.session.messages);
			const entriesBefore = structuredClone(harness.sessionManager.getEntries());
			const events: SideQuestionEvent[] = [];
			let observedTransport: string | undefined;
			let observedSessionId: string | undefined;

			harness.setResponses([
				(context, options) => {
					expect(context.systemPrompt).toBe(systemPromptBefore);
					expect(context.tools).toEqual([]);
					expect(context.messages.map(getMessageText)).toEqual([
						"The project codename is kestrel.",
						"The codename is kestrel.",
						expect.stringContaining("What is the project codename?"),
					]);
					observedTransport = options?.transport;
					observedSessionId = options?.sessionId;
					return fauxAssistantMessage("kestrel");
				},
			]);

			const run = startSideQuestion(
				harness.session.agent,
				"question-1",
				"What is the project codename?",
				(event) => {
					events.push(event);
				},
			);
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "kestrel" });
			expect(observedTransport).toBe("sse");
			expect(observedSessionId).toBe("cache-session");
			expect(harness.session.messages).toEqual(messagesBefore);
			expect(harness.sessionManager.getEntries()).toEqual(entriesBefore);
		} finally {
			harness.cleanup();
		}
	});

	it("can finish while the main agent is still working", async () => {
		const harness = await createHarness();
		const mainStarted = deferred();
		const releaseMain = deferred();
		try {
			harness.setResponses([
				async () => {
					mainStarted.resolve();
					await releaseMain.promise;
					return fauxAssistantMessage("main complete");
				},
				(context) => {
					expect(context.tools).toEqual([]);
					expect(context.messages.map(getMessageText)).toEqual([
						"Run the main task.",
						expect.stringContaining("Can I ask this concurrently?"),
					]);
					return fauxAssistantMessage("yes");
				},
			]);

			const mainRun = harness.session.prompt("Run the main task.");
			await mainStarted.promise;
			const events: SideQuestionEvent[] = [];
			const sideRun = startSideQuestion(
				harness.session.agent,
				"question-2",
				"Can I ask this concurrently?",
				(event) => {
					events.push(event);
				},
			);
			await sideRun.done;

			expect(harness.session.isStreaming).toBe(true);
			expect(events.at(-1)).toMatchObject({ status: "complete", answer: "yes" });
			releaseMain.resolve();
			await mainRun;
		} finally {
			releaseMain.resolve();
			await harness.session.agent.waitForIdle();
			harness.cleanup();
		}
	});

	it("cancels independently of the main agent", async () => {
		const harness = await createHarness();
		const sideStarted = deferred();
		try {
			harness.setResponses([
				async (_context, options) => {
					sideStarted.resolve();
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					return fauxAssistantMessage("");
				},
			]);
			const events: SideQuestionEvent[] = [];
			const run = startSideQuestion(harness.session.agent, "question-3", "Wait here", (event) => {
				events.push(event);
			});
			await sideStarted.promise;
			run.abort();
			await run.done;

			expect(events.at(-1)).toMatchObject({ status: "cancelled" });
			expect(harness.session.isStreaming).toBe(false);
		} finally {
			harness.cleanup();
		}
	});

	it("emits a terminal event after a transient event delivery failure", async () => {
		const harness = await createHarness();
		try {
			const events: SideQuestionEvent[] = [];
			let shouldFail = true;
			const run = startSideQuestion(harness.session.agent, "question-4", "Can this recover?", (event) => {
				if (shouldFail) {
					shouldFail = false;
					throw new Error("event delivery failed");
				}
				events.push(event);
			});

			await run.done;

			expect(events).toEqual([expect.objectContaining({ status: "error", errorMessage: "event delivery failed" })]);
		} finally {
			harness.cleanup();
		}
	});

	it("aborts daemon side questions when the session runtime is replaced", () => {
		const clients = [{ id: "client-1" }, { id: "client-2" }];
		const sessionState = {
			activeSessionId: "session-1",
			clients: new Set(clients),
			summaryState: undefined,
			runtime: {
				metadata: { kind: "primary" },
				session: { setCurrentRecap: vi.fn() },
			},
		};
		const abortSideQuestionsFor = vi.fn();
		const fakeThis = Object.assign(Object.create(AgentDaemon.prototype), {
			abortSideQuestionsFor,
			summarizer: { forget: vi.fn(), seed: vi.fn() },
			rebindCronJobsToState: vi.fn(),
		});
		const refreshReplacedSessionState = (
			AgentDaemon.prototype as unknown as {
				refreshReplacedSessionState(this: typeof fakeThis, state: typeof sessionState): void;
			}
		).refreshReplacedSessionState;

		refreshReplacedSessionState.call(fakeThis, sessionState);

		expect(abortSideQuestionsFor).toHaveBeenCalledTimes(2);
		expect(abortSideQuestionsFor).toHaveBeenNthCalledWith(1, clients[0], "session-1");
		expect(abortSideQuestionsFor).toHaveBeenNthCalledWith(2, clients[1], "session-1");
	});

	it("limits daemon side questions to one run per client and session", () => {
		const client = { id: "client-1" };
		const otherClient = { id: "client-2" };
		const fakeThis = Object.assign(Object.create(AgentDaemon.prototype), {
			sideQuestionRuns: new Map([
				["question-1", { client, activeSessionId: "session-1", run: { abort: vi.fn(), done: Promise.resolve() } }],
			]),
		});
		const hasActiveSideQuestionFor = (
			AgentDaemon.prototype as unknown as {
				hasActiveSideQuestionFor(this: typeof fakeThis, candidate: typeof client, activeSessionId: string): boolean;
			}
		).hasActiveSideQuestionFor;

		expect(hasActiveSideQuestionFor.call(fakeThis, client, "session-1")).toBe(true);
		expect(hasActiveSideQuestionFor.call(fakeThis, client, "session-2")).toBe(false);
		expect(hasActiveSideQuestionFor.call(fakeThis, otherClient, "session-1")).toBe(false);
	});

	it("renders a bounded one-turn panel above the prompt", () => {
		const component = new SideQuestionComponent(
			{
				id: "question-4",
				question: "What changed?",
				answer: "First line\n\nSecond line\n\nThird line\n\nFourth line",
				status: "complete",
			},
			() => 8,
		);
		const lines = component.render(40);
		const rendered = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(8);
		expect(lines.every((line) => line.includes("\x1b[48"))).toBe(true);
		expect(rendered).toContain("  /btw  What changed?");
		expect(rendered).not.toContain("  answer");
		expect(rendered).toContain("First line");
		expect(rendered).toContain("…");
	});

	it("aligns the thinking placeholder with the streamed response", () => {
		const running = new SideQuestionComponent(
			{ id: "question-5", question: "Still running?", answer: "", status: "running" },
			() => 8,
			4,
		);
		const complete = new SideQuestionComponent(
			{ id: "question-5", question: "Still running?", answer: "Aligned response", status: "complete" },
			() => 8,
			4,
		);
		const runningLines = running.render(40).map(stripAnsi);
		const completeLines = complete.render(40).map(stripAnsi);
		const thinkingLine = runningLines.find((line) => line.includes("Thinking…"));
		const responseLine = completeLines.find((line) => line.includes("Aligned response"));
		const rawThinkingLine = running.render(40).find((line) => line.includes("Thinking…"));

		expect(thinkingLine?.indexOf("Thinking…")).toBe(responseLine?.indexOf("Aligned response"));
		expect(rawThinkingLine).toContain("\x1b[39mThinking…");
	});

	it("uses the user-message foreground for pane content", () => {
		const component = new SideQuestionComponent(
			{ id: "question-5", question: "Readable question", answer: "Readable response", status: "complete" },
			() => 8,
		);
		const rendered = component.render(40).join("\n");

		expect(rendered).toContain("\x1b[39mReadable question\x1b[39m");
		expect(rendered).toContain("\x1b[39mReadable response");
	});

	it("keeps streamed text when a side question is cancelled", () => {
		const component = new SideQuestionComponent(
			{ id: "question-5", question: "Partial?", answer: "Useful partial response", status: "cancelled" },
			() => 8,
		);
		const rendered = stripAnsi(component.render(40).join("\n"));

		expect(rendered).toContain("Useful partial response");
		expect(rendered).not.toContain("Cancelled");
	});

	it("closes and cancels a running pane before handling other Escape actions", () => {
		const abortSideQuestion = vi.fn(async () => true);
		const takeEscapeRepeatAction = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			activeSideQuestionId: "question-5",
			sideQuestionEvent: {
				id: "question-5",
				question: "Still running?",
				answer: "",
				status: "running",
			},
			sideQuestionComponent: {},
			sideQuestionContainer: new Container(),
			agentConnection: { abortSideQuestion },
			isInitialized: false,
			clearCtrlCExitHint: vi.fn(),
			clearEscapeRepeat: vi.fn(),
			takeEscapeRepeatAction,
			armEscapeRepeat: vi.fn(),
			interruptOrClearInput: vi.fn(),
		});
		const handleEscape = (InteractiveMode.prototype as unknown as { handleEscape(this: typeof fakeThis): void })
			.handleEscape;

		handleEscape.call(fakeThis);

		expect(abortSideQuestion).toHaveBeenCalledWith("question-5");
		expect(fakeThis.sideQuestionEvent).toBeUndefined();
		expect(fakeThis.activeSideQuestionId).toBe("question-5");
		expect(takeEscapeRepeatAction).not.toHaveBeenCalled();
	});

	it("waits for a cancelled run to settle before starting another side question", async () => {
		const showWarning = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			activeSideQuestionId: "question-5",
			showWarning,
		});
		const handleSideQuestion = (
			InteractiveMode.prototype as unknown as {
				handleSideQuestion(this: typeof fakeThis, question: string): Promise<void>;
			}
		).handleSideQuestion;

		await handleSideQuestion.call(fakeThis, "Can this overlap?");

		expect(showWarning).toHaveBeenCalledWith("Wait for the current side question to finish or cancel it first.");
	});

	it("reports side-question abort failures without rejecting the interrupt path", async () => {
		const showError = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			activeSideQuestionId: "question-6",
			sideQuestionEvent: {
				id: "question-6",
				question: "Still running?",
				answer: "",
				status: "running",
			},
			agentConnection: { abortSideQuestion: vi.fn(async () => Promise.reject(new Error("daemon unavailable"))) },
			showError,
			getRetryAttempt: () => 0,
			isAgentCompacting: () => false,
			isBashRunning: () => false,
			isAgentStreaming: () => false,
		});
		const interruptOrClearInput = (
			InteractiveMode.prototype as unknown as { interruptOrClearInput(this: typeof fakeThis): void }
		).interruptOrClearInput;

		interruptOrClearInput.call(fakeThis);

		await vi.waitFor(() => expect(showError).toHaveBeenCalledWith("daemon unavailable"));
	});

	it("dismisses the side-question pane after successful tree navigation", async () => {
		const clearSideQuestion = vi.fn();
		const setText = vi.fn();
		const fakeThis = Object.assign(Object.create(InteractiveMode.prototype), {
			clearSideQuestion,
			chatContainer: new Container(),
			renderInitialMessages: vi.fn(async () => undefined),
			editor: { getText: () => "", setText },
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn(async () => undefined),
		});
		const renderTreeNavigation = (
			InteractiveMode.prototype as unknown as {
				renderTreeNavigation(this: typeof fakeThis, result: { editorText?: string }): Promise<void>;
			}
		).renderTreeNavigation;

		await renderTreeNavigation.call(fakeThis, { editorText: "restored draft" });

		expect(clearSideQuestion).toHaveBeenCalledWith({ abort: true });
		expect(setText).toHaveBeenCalledWith("restored draft");
	});
});
