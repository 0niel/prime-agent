import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { BashResult } from "../../src/core/bash-executor.js";
import type { PromptTemplate } from "../../src/core/prompt-templates.js";
import { createSyntheticSourceInfo } from "../../src/core/source-info.js";
import { createTestResourceLoader } from "../utilities.js";
import { createHarness, getAssistantTexts, getMessageText, getUserTexts, type Harness } from "./harness.js";

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		while (tempDirs.length > 0) {
			const tempDir = tempDirs.pop();
			if (tempDir) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("prompts while idle and records a single text response", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("hi");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("handles a tool call turn and waits for the follow-up LLM response", async () => {
		const toolRuns: string[] = [];
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				toolRuns.push(text);
				return {
					content: [{ type: "text", text: `echo:${text}` }],
					details: { text },
				};
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("echo", { text: "hello" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");

		expect(toolRuns).toEqual(["hello"]);
		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(harness.session.messages[2]?.role).toBe("toolResult");
		expect(harness.session.messages[3]?.role).toBe("assistant");
	});

	it("executes multiple tool calls from one response and continues with a single follow-up response", async () => {
		const toolRuns: string[] = [];
		const makeTool = (name: string, delayMs: number): AgentTool => ({
			name,
			label: name,
			description: `${name} tool`,
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId, params) => {
				const value =
					typeof params === "object" && params !== null && "value" in params ? String(params.value) : "";
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				toolRuns.push(`${name}:${value}`);
				return {
					content: [{ type: "text", text: `${name}:${value}` }],
					details: { value },
				};
			},
		});
		const harness = await createHarness({ tools: [makeTool("slow", 25), makeTool("fast", 0)] });
		harnesses.push(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("slow", { value: "a" }), fauxToolCall("fast", { value: "b" })], {
				stopReason: "toolUse",
			}),
			(context) => {
				const toolResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage(`tool results: ${toolResults.length}`);
			},
		]);

		await harness.session.prompt("run tools");

		expect(toolRuns.sort()).toEqual(["fast:b", "slow:a"]);
		expect(harness.session.messages.filter((message) => message.role === "toolResult")).toHaveLength(2);
		expect(harness.session.messages[harness.session.messages.length - 1]?.role).toBe("assistant");
	});

	it("preserves image attachments in the provider context", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		let sawImage = false;

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				sawImage =
					user?.role === "user" &&
					typeof user.content !== "string" &&
					user.content.some((part) => part.type === "image");
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("describe", {
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: "ZmFrZQ==",
				},
			],
		});

		expect(sawImage).toBe(true);
	});

	it("expands skill commands before sending the prompt", async () => {
		const tempDir = join(tmpdir(), `pi-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		tempDirs.push(tempDir);
		const skillPath = join(tempDir, "test-skill.md");
		writeFileSync(skillPath, "# Test Skill\n\nUse the skill body.");

		const resourceLoader = {
			...createTestResourceLoader(),
			getSkills: () => ({
				skills: [
					{
						name: "test",
						description: "Test skill",
						filePath: skillPath,
						disableModelInvocation: false,
						kind: "markdown" as const,
						baseDir: tempDir,
						sourceInfo: createSyntheticSourceInfo(skillPath, {
							source: "local",
							scope: "project",
							origin: "top-level",
							baseDir: tempDir,
						}),
					},
				],
				diagnostics: [],
			}),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/skill:test explain this");

		expect(expandedPrompt).toContain('<skill name="test" location="');
		expect(expandedPrompt).toContain("Use the skill body.");
		expect(expandedPrompt).toContain("explain this");
	});

	it("expands prompt templates before sending the prompt", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "Review this code: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const harness = await createHarness({ resourceLoader });
		harnesses.push(harness);
		let expandedPrompt = "";

		harness.setResponses([
			(context) => {
				const user = context.messages.find((message) => message.role === "user");
				expandedPrompt = user ? getMessageText(user) : "";
				return fauxAssistantMessage("ok");
			},
		]);

		await harness.session.prompt("/review src/index.ts");

		expect(expandedPrompt).toBe("Review this code: src/index.ts");
	});

	it("dispatches extension commands without consuming a provider response", async () => {
		const commandRuns: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should stay queued")]);

		await harness.session.prompt("/testcmd hello world");

		expect(commandRuns).toEqual(["hello world"]);
		expect(harness.session.messages).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("sendUserMessage while idle triggers a turn", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		harness.setResponses([fauxAssistantMessage("response")]);

		await harness.session.sendUserMessage("from extension");

		expect(harness.session.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getMessageText(harness.session.messages[0]!)).toBe("from extension");
	});

	it("throws when prompted during streaming without a streamingBehavior", async () => {
		let releaseToolExecution: (() => void) | undefined;
		const toolRelease = new Promise<void>((resolve) => {
			releaseToolExecution = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return {
					content: [{ type: "text", text: "released" }],
					details: {},
				};
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const sawToolStart = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("start");
		await sawToolStart;

		await expect(harness.session.prompt("second")).rejects.toThrow(
			"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
		);

		releaseToolExecution?.();
		await promptPromise;
	});

	it("resets stale extension system prompt for accepted agent messages", async () => {
		const harness = await createHarness({
			systemPrompt: "base prompt",
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (event) => ({
						systemPrompt: `${event.systemPrompt}

stale extension instructions`,
					}));
				},
			],
		});
		harnesses.push(harness);
		const baseSystemPrompt = harness.session.systemPrompt;
		const providerSystemPrompts: string[] = [];
		harness.setResponses([
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("first");
			},
			(context) => {
				providerSystemPrompts.push(context.systemPrompt ?? "");
				return fauxAssistantMessage("second");
			},
		]);

		await harness.session.prompt("normal prompt");
		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false });
		await harness.session.agent.waitForIdle();

		expect(providerSystemPrompts[0]).toContain("stale extension instructions");
		expect(providerSystemPrompts[1]).toBe(baseSystemPrompt);
		expect(providerSystemPrompts[1]).not.toContain("stale extension instructions");
	});

	it("queues accepted agent messages while compacting", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_compactionAbortController?: AbortController;
		};
		sessionInternals._compactionAbortController = new AbortController();

		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload", {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});

		expect(harness.session.getFollowUpMessages()).toEqual(["agent-to-agent payload"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps pending nextTurn context separate from accepted agent messages queued while busy", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_next_turn_queued\n\nagent text";
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "queued context", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const sessionInternals = harness.session as unknown as {
			_compactionAbortController?: AbortController;
		};
		sessionInternals._compactionAbortController = new AbortController();

		await harness.session.acceptAgentMessagePrompt(agentPrompt, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});
		expect(harness.session.getFollowUpMessages()).toEqual([agentPrompt]);

		sessionInternals._compactionAbortController = undefined;
		let queuedTurnSawSeparateNextTurnContext = false;
		harness.setResponses([
			fauxAssistantMessage("first turn"),
			(context) => {
				const queuedContext = context.messages.find(
					(message) => message.role === "user" && getMessageText(message) === "queued context",
				);
				const queuedUser = context.messages.find(
					(message) => message.role === "user" && getMessageText(message).includes("agentmsg_next_turn_queued"),
				);
				queuedTurnSawSeparateNextTurnContext =
					queuedContext !== undefined &&
					queuedUser !== undefined &&
					!getMessageText(queuedUser).includes("queued context");
				return fauxAssistantMessage("queued turn");
			},
		]);

		await harness.session.prompt("normal prompt");

		expect(queuedTurnSawSeparateNextTurnContext).toBe(true);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("queues accepted agent messages if the session becomes busy before handoff", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_handoff_busy\n\nqueue at handoff";
		let releaseRefine: (() => void) | undefined;
		const refineGate = new Promise<void>((resolve) => {
			releaseRefine = resolve;
		});
		const sessionInternals = harness.session as unknown as {
			_refineInFlight?: Promise<void>;
			_userBashRunning?: boolean;
		};
		sessionInternals._refineInFlight = refineGate;

		const accepted = harness.session.acceptAgentMessagePrompt(agentPrompt, {
			expandPromptTemplates: false,
			streamingBehavior: "followUp",
			queueIfBusy: true,
		});
		await Promise.resolve();
		sessionInternals._userBashRunning = true;
		sessionInternals._refineInFlight = undefined;
		releaseRefine?.();

		await accepted;
		sessionInternals._userBashRunning = false;

		expect(harness.session.getFollowUpMessages()).toEqual([agentPrompt]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("restores nextTurn context when handoff busy rejection cannot queue", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "restore after handoff failure", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		let releaseRefine: (() => void) | undefined;
		const refineGate = new Promise<void>((resolve) => {
			releaseRefine = resolve;
		});
		const sessionInternals = harness.session as unknown as {
			_refineInFlight?: Promise<void>;
			_userBashRunning?: boolean;
		};
		sessionInternals._refineInFlight = refineGate;

		const accepted = harness.session.acceptAgentMessagePrompt(
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_handoff_reject\n\nagent text",
			{ expandPromptTemplates: false, queueIfBusy: true },
		);
		await Promise.resolve();
		sessionInternals._userBashRunning = true;
		sessionInternals._refineInFlight = undefined;
		releaseRefine?.();

		await expect(accepted).rejects.toThrow("Agent became busy before prompt delivery");
		sessionInternals._userBashRunning = false;

		let sawRestoredContext = false;
		harness.setResponses([
			(context) => {
				sawRestoredContext = context.messages.some(
					(message) =>
						message.role === "user" && getMessageText(message).includes("restore after handoff failure"),
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("normal prompt");

		expect(sawRestoredContext).toBe(true);
	});

	it("accepted agent messages return after delivery starts, before completion", async () => {
		const harness = await createHarness({ models: [{ id: "slow-faux" }] });
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_after_preflight\n\nagent text";
		let releaseResponse: (() => void) | undefined;
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		harness.setResponses([
			async () => {
				await responseGate;
				return fauxAssistantMessage("delivered");
			},
		]);

		await harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false });
		expect(getUserTexts(harness)).toEqual([agentPrompt]);
		expect(getAssistantTexts(harness)).toEqual([]);
		expect(harness.session.clearQueuedAgentMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [],
			followUp: [],
		});
		releaseResponse?.();
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([agentPrompt]);
		expect(getAssistantTexts(harness)).toEqual(["delivered"]);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
	});

	it("allows normal prompts while an accepted agent message is idle between retry attempts", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const acceptedMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "accepted agent message" }],
			timestamp: Date.now(),
		};
		const sessionInternals = harness.session as unknown as {
			_acceptedAgentMessagePrompt?: {
				text: string;
				agentMessageId: string;
				message: typeof acceptedMessage;
				messages: Set<typeof acceptedMessage>;
				pendingNextTurnMessages: unknown[];
				accepted: Promise<void>;
				resolveAccepted: () => void;
				rejectAccepted: (error: Error) => void;
				turnStarted: boolean;
				cleared: boolean;
			};
		};
		harness.setResponses([fauxAssistantMessage("ordinary response")]);

		sessionInternals._acceptedAgentMessagePrompt = {
			text: "accepted agent message",
			agentMessageId: "agentmsg_in_flight",
			message: acceptedMessage,
			messages: new Set([acceptedMessage]),
			pendingNextTurnMessages: [],
			accepted: Promise.resolve(),
			resolveAccepted: () => {},
			rejectAccepted: () => {},
			turnStarted: true,
			cleared: false,
		};
		await expect(harness.session.prompt("ordinary prompt")).resolves.toBeUndefined();
		sessionInternals._acceptedAgentMessagePrompt = undefined;
		expect(getUserTexts(harness)).toContain("ordinary prompt");
	});

	it("flushes pending bash messages before accepted agent messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			recordBashResult(command: string, result: BashResult): void;
			_flushPendingBashMessages(): void;
		};
		const contextRoles: string[][] = [];
		const contextTexts: string[][] = [];
		harness.setResponses([
			fauxAssistantMessage("busy done"),
			(context) => {
				contextRoles.push(context.messages.map((message) => message.role));
				contextTexts.push(context.messages.map((message) => getMessageText(message)));
				return fauxAssistantMessage("agent message response");
			},
		]);

		const busyPrompt = harness.session.agent.prompt("busy");
		sessionInternals.recordBashResult("echo hi", {
			output: "hi",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		await busyPrompt;
		await harness.session.acceptAgentMessagePrompt("agent-to-agent payload", { expandPromptTemplates: false });
		await harness.session.agent.waitForIdle();

		expect(contextRoles).toEqual([["user", "assistant", "user", "user"]]);
		expect(contextTexts[0]?.[2]).toContain("Ran `echo hi`");
		expect(contextTexts[0]?.[3]).toBe("agent-to-agent payload");
		expect(harness.session.hasPendingBashMessages).toBe(false);
		expect(typeof sessionInternals._flushPendingBashMessages).toBe("function");
	});

	it("does not clear accepted agent messages after delivery starts", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async () => {
						await new Promise((resolve) => setTimeout(resolve, 0));
					});
				},
			],
		});
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_after_assistant\n\nagent text";
		harness.setResponses([fauxAssistantMessage("delivered assistant response")]);

		await harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false });
		await Promise.resolve();
		expect(harness.session.clearQueuedAgentMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [],
			followUp: [],
		});
		await harness.session.agent.waitForIdle();

		expect(getUserTexts(harness)).toEqual([agentPrompt]);
		expect(getAssistantTexts(harness)).toEqual(["delivered assistant response"]);
	});

	it("cleared accepted agent message cleanup does not remove messages from a newer prompt", async () => {
		let gateAgentStart = false;
		let releaseGate = () => {};
		const gate = new Promise<void>((resolve) => {
			releaseGate = resolve;
		});
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_start", async () => {
						if (gateAgentStart) {
							await gate;
						}
					});
				},
			],
		});
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_stale_cleanup\n\nagent text";
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed");

		harness.setResponses([fauxAssistantMessage("never delivered"), fauxAssistantMessage("after clear response")]);
		gateAgentStart = true;
		const accepted = harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false });
		expect(harness.session.clearQueuedAgentMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [],
			followUp: [agentPrompt],
		});
		await expect(accepted).rejects.toThrow("cleared before delivery");
		await harness.session.agent.waitForIdle();

		// The cleared run's events are still stalled in the session event queue;
		// run a newer prompt so its messages land in state before the stale cleanup.
		harness.setResponses([fauxAssistantMessage("after clear response")]);
		gateAgentStart = false;
		await harness.session.prompt("after clear");
		releaseGate();
		await (harness.session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

		expect(getUserTexts(harness)).toEqual(["seed", "after clear"]);
		expect(getAssistantTexts(harness)).toEqual(["seed response", "after clear response"]);
	});

	it("restores drained nextTurn messages when an accepted agent message is cleared", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_next_turn\n\nagent text";
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "carry this", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		harness.setResponses([fauxAssistantMessage("never delivered")]);

		const accepted = harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false });
		expect(harness.session.clearQueuedAgentMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [],
			followUp: [agentPrompt],
		});
		await expect(accepted).rejects.toThrow("cleared before delivery");
		await harness.session.agent.waitForIdle();
		await (harness.session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

		let sawCustomMessage = false;
		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "carry this"),
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
		expect(harness.session.messages.map((message) => message.role)).toEqual(["custom", "user", "assistant"]);
	});

	it("restores drained nextTurn messages when direct agent message acceptance fails before delivery", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		await harness.session.sendCustomMessage(
			{ customType: "next-turn", content: "retry me", display: true, details: {} },
			{ deliverAs: "nextTurn" },
		);
		const agent = harness.session.agent as unknown as { prompt(messages: unknown): Promise<void> };
		const originalPrompt = agent.prompt;
		agent.prompt = async () => {
			throw new Error("prompt failed before delivery");
		};

		await expect(
			harness.session.acceptAgentMessagePrompt(
				"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_context_fail\n\nagent text",
				{ expandPromptTemplates: false },
			),
		).rejects.toThrow("prompt failed before delivery");
		agent.prompt = originalPrompt;

		let sawCustomMessage = false;
		harness.setResponses([
			(context) => {
				sawCustomMessage = context.messages.some(
					(message) =>
						message.role === "user" &&
						typeof message.content !== "string" &&
						message.content.some((part) => part.type === "text" && part.text === "retry me"),
				);
				return fauxAssistantMessage("done");
			},
		]);
		await harness.session.prompt("normal prompt");

		expect(sawCustomMessage).toBe(true);
	});

	it("cleans up the aborted run's late events after clearing an accepted agent message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const agentPrompt =
			"Agent-to-agent message received.\nSource: agent_message\nTo: Target, active target, session session-target\nMessage id: agentmsg_late_events\n\nagent text";
		harness.setResponses([fauxAssistantMessage("seed response")]);
		await harness.session.prompt("seed");
		harness.setResponses([fauxAssistantMessage("never delivered")]);

		const delivery = harness.session.waitForAgentMessagePromptDelivery("agentmsg_late_events");
		const accepted = harness.session.acceptAgentMessagePrompt(agentPrompt, { expandPromptTemplates: false });
		expect(harness.session.clearQueuedAgentMessagesMatching((text) => text.includes("agentmsg_"))).toEqual({
			steering: [],
			followUp: [agentPrompt],
		});
		await expect(accepted).rejects.toThrow("cleared before delivery");
		await expect(delivery).rejects.toThrow("cleared before delivery");
		await harness.session.agent.waitForIdle();
		await (harness.session as unknown as { _agentEventQueue: Promise<void> })._agentEventQueue;

		await expect(harness.session.waitForAgentMessagePromptDelivery("agentmsg_late_events")).rejects.toThrow(
			"cleared before delivery",
		);
		// The aborted run's late message events must not re-persist the cleared message.
		const persistedRoles = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message.role);
		expect(persistedRoles).toEqual(["user", "assistant"]);
		expect(getUserTexts(harness)).toEqual(["seed"]);
		expect(getAssistantTexts(harness)).toEqual(["seed response"]);
		expect(harness.session.agent.state.errorMessage).toBeUndefined();
		expect(
			(harness.session as unknown as { _acceptedAgentMessagePrompt?: unknown })._acceptedAgentMessagePrompt,
		).toBeUndefined();
	});

	it("handles autonomous slash commands when template expansion is disabled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/autonomous on", { expandPromptTemplates: false });

		expect(harness.session.getAutonomousStatus().enabled).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(harness.session.messages.some((message) => message.role === "custom")).toBe(true);
	});

	it("handles goal slash commands when template expansion is disabled", async () => {
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("/goal status", { expandPromptTemplates: false });

		expect(harness.eventsOfType("goal_update")).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getAssistantTexts(harness)).toEqual([]);
	});

	it("does not run built-in slash commands immediately while queueIfBusy backpressure is active", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as {
			_compactionAbortController?: AbortController;
		};
		sessionInternals._compactionAbortController = new AbortController();

		await expect(
			harness.session.prompt("/autonomous on", {
				queueIfBusy: true,
				streamingBehavior: "followUp",
			}),
		).rejects.toThrow("Agent has queued work");
		sessionInternals._compactionAbortController = undefined;

		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(harness.session.getFollowUpMessages()).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("keeps built-in slash commands literal for accepted agent messages", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("literal")]);

		await harness.session.acceptAgentMessagePrompt("/autonomous on", { expandPromptTemplates: false });
		await harness.session.agent.waitForIdle();

		expect(harness.session.getAutonomousStatus().enabled).toBe(false);
		expect(getUserTexts(harness)).toEqual(["/autonomous on"]);
		expect(getAssistantTexts(harness)).toEqual(["literal"]);
	});

	it("queues accepted agent messages without expanding slash commands or prompt templates", async () => {
		const template: PromptTemplate = {
			name: "review",
			description: "Review template",
			content: "expanded template: $1",
			filePath: "/virtual/review.md",
			sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
				source: "local",
				scope: "temporary",
				origin: "top-level",
			}),
		};
		const resourceLoader = {
			...createTestResourceLoader(),
			getPrompts: () => ({ prompts: [template], diagnostics: [] }),
		};
		const commandRuns: string[] = [];
		const harness = await createHarness({
			resourceLoader,
			extensionFactories: [
				(pi) => {
					pi.registerCommand("testcmd", {
						description: "Test command",
						handler: async (args) => {
							commandRuns.push(args);
						},
					});
				},
			],
		});
		harnesses.push(harness);

		await expect(harness.session.queueAgentMessagePrompt("/review keep literal", "followUp")).resolves.toBe(true);
		await expect(harness.session.queueAgentMessagePrompt("/testcmd keep literal", "followUp")).resolves.toBe(true);

		expect(harness.session.getFollowUpMessages()).toEqual(["/review keep literal", "/testcmd keep literal"]);
		expect(commandRuns).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("throws when prompting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.session.agent.state.model = undefined as unknown as Model<any>;

		await expect(harness.session.prompt("hi")).rejects.toThrow("No model selected.");
	});

	it("throws when prompting without configured auth", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);

		await expect(harness.session.prompt("hi")).rejects.toThrow(
			`No API key found for ${harness.getModel().provider}.`,
		);
	});
});
