import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import type { AuthStatus } from "../src/core/auth-storage.js";
import { PRIME_INFERENCE_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import {
	type OnboardingStartupState,
	shouldRunOnboarding,
	shouldRunPrimeCliOnboardingSplash,
} from "../src/modes/interactive/onboarding.js";

function makeModel(provider: string): Model<Api> {
	return { id: "test-model", provider } as Model<Api>;
}

function makeState(overrides: {
	onboardingCompleted: boolean;
	model: Model<Api> | undefined;
	modelHasAuth?: boolean;
	primeAuthSource?: AuthStatus["source"];
}): OnboardingStartupState {
	return {
		settingsManager: {
			getOnboardingCompleted: () => overrides.onboardingCompleted,
		},
		modelRegistry: {
			refresh: () => {},
			hasConfiguredAuth: () => overrides.modelHasAuth ?? false,
			getProviderAuthStatus: () => ({
				configured: overrides.primeAuthSource !== undefined,
				source: overrides.primeAuthSource,
			}),
		},
		model: overrides.model,
	};
}

describe("startup onboarding decision", () => {
	test("runs onboarding on first launch with Prime CLI auth", () => {
		const state = makeState({
			onboardingCompleted: false,
			model: makeModel(PRIME_INFERENCE_PROVIDER_ID),
			modelHasAuth: true,
			primeAuthSource: "prime_cli",
		});
		expect(shouldRunPrimeCliOnboardingSplash(state)).toBe(true);
		expect(shouldRunOnboarding(state)).toBe(true);
	});

	test("runs onboarding when no model is available", () => {
		expect(shouldRunOnboarding(makeState({ onboardingCompleted: true, model: undefined }))).toBe(true);
	});

	test("runs onboarding when the current model has no configured auth", () => {
		expect(
			shouldRunOnboarding(
				makeState({ onboardingCompleted: true, model: makeModel("anthropic"), modelHasAuth: false }),
			),
		).toBe(true);
	});

	test("skips onboarding once completed with a ready model", () => {
		const state = makeState({
			onboardingCompleted: true,
			model: makeModel(PRIME_INFERENCE_PROVIDER_ID),
			modelHasAuth: true,
			primeAuthSource: "prime_cli",
		});
		expect(shouldRunPrimeCliOnboardingSplash(state)).toBe(false);
		expect(shouldRunOnboarding(state)).toBe(false);
	});

	test("skips the Prime CLI splash for non-Prime providers with ready auth", () => {
		const state = makeState({
			onboardingCompleted: false,
			model: makeModel("anthropic"),
			modelHasAuth: true,
			primeAuthSource: "stored",
		});
		expect(shouldRunPrimeCliOnboardingSplash(state)).toBe(false);
		expect(shouldRunOnboarding(state)).toBe(false);
	});
});
