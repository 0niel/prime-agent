import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { HostRequestHandlers } from "../../../src/core/kernel/index.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createHarness } from "../harness.js";

const provider = "faux-eng-4649";

function openAICodexToken(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64url");
	return `header.${payload}.signature`;
}

describe("ENG-4649 subagent model selection", () => {
	it("searches a bounded authenticated catalog without advertising it", async () => {
		const harness = await createHarness({
			provider,
			models: Array.from({ length: 320 }, (_, index) => ({ id: `model-${index}` })),
		});
		try {
			const prompt = harness.session.agent.state.systemPrompt;
			expect(prompt).not.toContain(`${provider}/model-319`);
			const handlers = (
				harness.session as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
			)._createKernelHostHandlers();
			const findModels = handlers["rlm.find_models"];
			if (!findModels) throw new Error("Missing rlm.find_models host handler");
			await expect(findModels({ query: "model 319", limit: 5 })).resolves.toEqual({
				models: [
					{
						provider,
						id: "model-319",
						name: "model-319",
						selector: `${provider}/model-319`,
					},
				],
			});
			await expect(findModels({ query: "model", limit: 21 })).rejects.toThrow("integer from 1 to 20");
			harness.setResponses([fauxAssistantMessage("resolved child answer")]);

			const result = await harness.session.runRlmChild("use the requested model", {
				model: `${provider}/model-319`,
			});

			const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
			const child = harness.session.getRlmChildSession(childEntry!.rlm_child_id);
			expect(child?.model?.id).toBe("model-319");
			expect(result.model).toBe(`${provider}/model-319`);
			expect(result.warning).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("omits providers whose credentials are marked expired", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }, { id: "child-model" }] });
		try {
			expect((await harness.session.findRlmModels("child", 8)).models).toHaveLength(1);
			expect(harness.session.modelRegistry.markProviderAuthStale(provider)).toBe(true);
			expect(harness.session.modelRegistry.markProviderAuthStale(provider)).toBe(true);
			expect(harness.session.modelRegistry.getProviderAuthStatus(provider)).toMatchObject({
				source: "stale",
				label: "expired",
			});
			await expect(harness.session.findRlmModels("", 8)).resolves.toEqual({ models: [] });
		} finally {
			harness.cleanup();
		}
	});

	it("limits ChatGPT discovery and execution to the account model catalog", async () => {
		const codexProvider = "openai-codex";
		const harness = await createHarness({
			provider: codexProvider,
			models: [{ id: "parent-model" }, { id: "unsupported-model" }],
		});
		const fetchModels = vi.fn(
			async () =>
				new Response(JSON.stringify({ models: [{ slug: "parent-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			const discovered = await harness.session.findRlmModels("", 20);
			expect(discovered.models.map((model) => model.selector)).toEqual([`${codexProvider}/parent-model`]);
			expect(fetchModels).toHaveBeenCalledWith(
				expect.stringMatching(/\/codex\/models\?client_version=/),
				expect.objectContaining({
					headers: expect.objectContaining({ "chatgpt-account-id": "account-1" }),
				}),
			);

			harness.setResponses([fauxAssistantMessage("parent fallback answer")]);
			const result = await harness.session.runRlmChild("reject unsupported account model", {
				model: `${codexProvider}/unsupported-model`,
			});
			expect(result.model).toBe(`${codexProvider}/parent-model`);
			expect(result.warning).toContain(`not "${codexProvider}/unsupported-model"`);
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});

	it("includes private Prime models authorized for the selected team", async () => {
		const harness = await createHarness({ provider, models: [{ id: "parent-model" }] });
		const fetchModels = vi.fn(
			async () =>
				new Response(JSON.stringify({ data: [{ id: "internal/glm-5.2-fast" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.set("prime-inference", {
				type: "api_key",
				key: "prime-key",
				primeTeam: { teamId: "engineering-team", name: "Prime Engineering" },
			});

			const discovered = await harness.session.findRlmModels("glm 5.2", 8);
			expect(discovered.models.map((model) => model.selector)).toContain("prime-inference/internal/glm-5.2-fast");
			expect(fetchModels).toHaveBeenCalledOnce();
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});

	it("does not reuse an expired ChatGPT model catalog after a refresh failure", async () => {
		const codexProvider = "openai-codex";
		const harness = await createHarness({ provider: codexProvider, models: [{ id: "parent-model" }] });
		const fetchModels = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ models: [{ slug: "parent-model" }] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockRejectedValueOnce(new Error("offline"));
		vi.stubGlobal("fetch", fetchModels);
		let now = Date.now();
		const dateNow = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			await expect(harness.session.findRlmModels("parent", 8)).resolves.toMatchObject({
				models: [{ selector: `${codexProvider}/parent-model` }],
			});

			now += 300_001;
			await expect(harness.session.findRlmModels("parent", 8)).resolves.toEqual({ models: [] });
			expect(fetchModels).toHaveBeenCalledTimes(2);
		} finally {
			dateNow.mockRestore();
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});

	it("does not warn when an unavailable selector is already the parent model", async () => {
		const codexProvider = "openai-codex";
		const harness = await createHarness({ provider: codexProvider, models: [{ id: "parent-model" }] });
		const fetchModels = vi.fn().mockRejectedValue(new Error("offline"));
		vi.stubGlobal("fetch", fetchModels);
		try {
			harness.authStorage.setRuntimeApiKey(codexProvider, openAICodexToken("account-1"));
			await expect(harness.session.findRlmModels("parent", 8)).resolves.toEqual({ models: [] });
			harness.setResponses([fauxAssistantMessage("same parent answer")]);

			const result = await harness.session.runRlmChild("keep the parent model", {
				model: `${codexProvider}/parent-model`,
			});
			expect(result).toMatchObject({
				answer: "same parent answer",
				model: `${codexProvider}/parent-model`,
			});
			expect(result.warning).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
			harness.cleanup();
		}
	});

	it("does not start a child after its parent is disposed during preflight", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		let releasePreflight!: () => void;
		const preflightGate = new Promise<void>((resolve) => {
			releasePreflight = resolve;
		});
		let providerCalls = 0;
		try {
			harness.setResponses([
				() => {
					providerCalls++;
					return fauxAssistantMessage("late child ran");
				},
			]);
			const authPreflight = vi
				.spyOn(harness.session.modelRegistry, "getApiKeyAndHeaders")
				.mockImplementationOnce(async () => {
					await preflightGate;
					return { ok: true, apiKey: "faux-key" };
				});
			const run = harness.session.runRlmChild("do not run after disposal", {
				model: `${provider}/child-model`,
			});
			await vi.waitFor(() => expect(authPreflight).toHaveBeenCalledOnce());
			harness.session.dispose();
			releasePreflight();

			await expect(run).rejects.toThrow("parent session has been disposed");
			expect(providerCalls).toBe(0);
			expect((await harness.session.listRlmSubagents()).subagents).toEqual([]);
		} finally {
			releasePreflight();
			harness.cleanup();
		}
	});

	it("reserves an explicit child name while model validation is pending", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }],
		});
		try {
			harness.setResponses([fauxAssistantMessage("first child answer")]);

			const first = harness.session.runRlmChild("first task", { name: "shared-reviewer" });
			await expect(harness.session.runRlmChild("second task", { name: "shared-reviewer" })).rejects.toThrow(
				'RLM subagent session name "shared-reviewer" is already in use',
			);
			await expect(first).resolves.toMatchObject({ answer: "first child answer" });
		} finally {
			harness.cleanup();
		}
	});

	it("runs and retains a child on an explicitly selected model", async () => {
		const harness = await createHarness({
			provider,
			models: [
				{ id: "parent-model", reasoning: true },
				{ id: "child-model", name: "Child Model", reasoning: false },
				{ id: "later-parent-model", reasoning: true },
			],
			persistSession: true,
		});
		try {
			harness.session.setThinkingLevel("high");
			const seenModels: string[] = [];
			harness.setResponses([
				(_context, _options, _state, model) => {
					seenModels.push(model.id);
					return fauxAssistantMessage("initial child answer");
				},
				(_context, _options, _state, model) => {
					seenModels.push(model.id);
					return fauxAssistantMessage("follow-up child answer");
				},
			]);

			const result = await harness.session.runRlmChild("inspect the API", {
				name: "api-reviewer",
				model: `${provider}/child-model`,
			});
			const childEntry = (await harness.session.listRlmSubagents()).subagents[0];
			expect(childEntry?.status).toBe("completed");
			const child = harness.session.getRlmChildSession(childEntry!.rlm_child_id);
			expect(child?.model?.id).toBe("child-model");
			expect(child?.thinkingLevel).toBe("off");

			await harness.session.setModel(harness.getModel("later-parent-model")!);
			await child!.prompt("check the follow-up", { expandPromptTemplates: false, source: "extension" });
			await child!.agent.waitForIdle();

			expect(result.answer).toBe("initial child answer");
			expect(seenModels).toEqual(["child-model", "child-model"]);
			expect(child?.model?.id).toBe("child-model");
			expect(result.session_dir).not.toBeNull();
			const childSessions = await SessionManager.list(harness.tempDir, result.session_dir!);
			const persisted = SessionManager.open(childSessions[0]!.path, result.session_dir!);
			expect(persisted.buildSessionContext().model).toEqual({
				provider,
				modelId: "child-model",
			});
		} finally {
			harness.cleanup();
		}
	});

	it("inherits the parent model when no override is supplied", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		try {
			let seenModel: string | undefined;
			harness.setResponses([
				(_context, _options, _state, model) => {
					seenModel = model.id;
					return fauxAssistantMessage("inherited child answer");
				},
			]);

			await harness.session.runRlmChild("inherit the model");
			expect(seenModel).toBe("parent-model");
		} finally {
			harness.cleanup();
		}
	});

	it("accepts a selected model authenticated by headers", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		try {
			harness.setResponses([fauxAssistantMessage("header-auth child answer")]);
			const authPreflight = vi
				.spyOn(harness.session.modelRegistry, "getApiKeyAndHeaders")
				.mockResolvedValueOnce({ ok: true, headers: { Authorization: "Bearer header-token" } });

			const result = await harness.session.runRlmChild("use header auth", {
				model: `${provider}/child-model`,
			});
			authPreflight.mockRestore();

			expect(result.model).toBe(`${provider}/child-model`);
			expect(result.warning).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to the parent model and returns a user-facing warning", async () => {
		const harness = await createHarness({
			provider,
			models: [{ id: "parent-model" }, { id: "child-model" }],
		});
		try {
			await expect(harness.session.runRlmChild("bad type", { model: 42 })).rejects.toThrow(
				"rlm.run model must be a string",
			);
			harness.setResponses([
				fauxAssistantMessage("unknown fallback"),
				fauxAssistantMessage("unauthenticated fallback"),
				fauxAssistantMessage("unavailable fallback"),
				fauxAssistantMessage("preflight fallback"),
			]);

			const unknown = await harness.session.runRlmChild("unknown model", {
				model: `${provider}/missing-model`,
			});
			expect(unknown.model).toBe(`${provider}/parent-model`);
			expect(unknown.warning).toContain(`not "${provider}/missing-model"`);
			expect(unknown.warning).toContain("Tell the user");

			const unauthenticated = await harness.session.runRlmChild("unauthenticated provider", {
				model: "not-authed/missing-model",
			});
			expect(unauthenticated.model).toBe(`${provider}/parent-model`);
			expect(unauthenticated.warning).toContain("unauthenticated");

			const availability = vi
				.spyOn(harness.session.modelRegistry, "getAvailable")
				.mockReturnValue([harness.getModel("parent-model")!]);
			const unavailable = await harness.session.runRlmChild("unavailable model", {
				model: `${provider}/child-model`,
			});
			availability.mockRestore();

			expect(unavailable.model).toBe(`${provider}/parent-model`);
			expect(unavailable.warning).toContain(`not "${provider}/child-model"`);

			const authPreflight = vi
				.spyOn(harness.session.modelRegistry, "getApiKeyAndHeaders")
				.mockResolvedValueOnce({ ok: false, error: "token expired" });
			const failedPreflight = await harness.session.runRlmChild("failed auth preflight", {
				model: `${provider}/child-model`,
			});
			authPreflight.mockRestore();
			expect(failedPreflight.model).toBe(`${provider}/parent-model`);
			expect(failedPreflight.warning).toContain("failed authentication preflight");

			expect((await harness.session.listRlmSubagents()).subagents).toHaveLength(4);
			for (const child of (await harness.session.listRlmSubagents()).subagents) {
				expect(harness.session.getRlmChildSession(child.rlm_child_id)?.model?.id).toBe("parent-model");
			}
		} finally {
			harness.cleanup();
		}
	});
});
