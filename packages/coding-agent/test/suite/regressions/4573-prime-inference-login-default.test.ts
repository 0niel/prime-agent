import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { findInitialModel, PRIME_INFERENCE_DEFAULT_MODEL_ID } from "../../../src/core/model-resolver.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../../../src/core/prime-inference-auth.js";
import { SettingsManager } from "../../../src/core/settings-manager.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4573 Prime Inference login default", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	test("persists GLM 5.2 so the next process starts with a valid model", async () => {
		const harness = await createHarness({
			provider: PRIME_INFERENCE_PROVIDER_ID,
			models: [{ id: PRIME_INFERENCE_DEFAULT_MODEL_ID, name: "GLM 5.2" }],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent");
		const settings = SettingsManager.create(harness.tempDir, agentDir);

		settings.setDefaultModelAndProvider(PRIME_INFERENCE_PROVIDER_ID, PRIME_INFERENCE_DEFAULT_MODEL_ID);
		await settings.flush();

		const restartedSettings = SettingsManager.create(harness.tempDir, agentDir);
		expect(restartedSettings.getDefaultProvider()).toBe(PRIME_INFERENCE_PROVIDER_ID);
		expect(restartedSettings.getDefaultModel()).toBe(PRIME_INFERENCE_DEFAULT_MODEL_ID);

		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: restartedSettings.getDefaultProvider(),
			defaultModelId: restartedSettings.getDefaultModel(),
			modelRegistry: harness.session.modelRegistry,
		});

		expect(initial.model?.provider).toBe(PRIME_INFERENCE_PROVIDER_ID);
		expect(initial.model?.id).toBe(PRIME_INFERENCE_DEFAULT_MODEL_ID);
	});
});
