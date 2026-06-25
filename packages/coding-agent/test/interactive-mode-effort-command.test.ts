import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type EffortCommandContext = {
	connectionState?: {
		thinkingLevel: ThinkingLevel;
		availableThinkingLevels: ThinkingLevel[];
	};
	agentConnection: { setThinkingLevel: (level: ThinkingLevel) => Promise<void> };
	footer: { invalidate: () => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	patchConnectionState: (patch: Record<string, unknown>) => void;
	updateEditorBorderColor: () => void;
	getAvailableThinkingLevels: () => ThinkingLevel[];
	applyThinkingLevel: (level: ThinkingLevel) => void;
};

type InteractiveModePrototype = {
	getAvailableThinkingLevels(this: EffortCommandContext): ThinkingLevel[];
	getThinkingLevelCompletions(this: EffortCommandContext, prefix: string): AutocompleteItem[] | null;
	handleEffortCommand(this: EffortCommandContext, arg: string): void;
	applyThinkingLevel(this: EffortCommandContext, level: ThinkingLevel): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function makeContext(overrides: Partial<EffortCommandContext> = {}): EffortCommandContext {
	const context: EffortCommandContext = {
		connectionState: {
			thinkingLevel: "medium",
			availableThinkingLevels: ["off", "low", "medium", "high"],
		},
		agentConnection: { setThinkingLevel: vi.fn(async () => {}) },
		footer: { invalidate: vi.fn() },
		showStatus: vi.fn(),
		showError: vi.fn(),
		patchConnectionState: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		getAvailableThinkingLevels: () => interactiveModePrototype.getAvailableThinkingLevels.call(context),
		applyThinkingLevel: (level) => interactiveModePrototype.applyThinkingLevel.call(context, level),
		...overrides,
	};
	return context;
}

describe("InteractiveMode /effort", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	describe("argument autocomplete", () => {
		it("lists every supported level for an empty prefix and marks the current one", () => {
			const context = makeContext();

			const items = interactiveModePrototype.getThinkingLevelCompletions.call(context, "");

			expect(items?.map((item) => item.value)).toEqual(["off", "low", "medium", "high"]);
			expect(items?.find((item) => item.value === "medium")?.description).toContain("(current)");
		});

		it("filters by the typed prefix", () => {
			const context = makeContext();

			const items = interactiveModePrototype.getThinkingLevelCompletions.call(context, "h");

			expect(items?.map((item) => item.value)).toEqual(["high"]);
		});

		it("offers no completions when the model does not support thinking", () => {
			const context = makeContext({
				connectionState: { thinkingLevel: "off", availableThinkingLevels: ["off"] },
			});

			expect(interactiveModePrototype.getThinkingLevelCompletions.call(context, "")).toBeNull();
		});
	});

	describe("command handling", () => {
		it("applies a valid level through the connection and reports it", async () => {
			const setThinkingLevel = vi.fn(async () => {});
			const context = makeContext({ agentConnection: { setThinkingLevel } });

			interactiveModePrototype.handleEffortCommand.call(context, "high");
			await vi.waitFor(() => expect(context.showStatus).toHaveBeenCalledWith("Thinking level: high"));

			expect(setThinkingLevel).toHaveBeenCalledWith("high");
			expect(context.patchConnectionState).toHaveBeenCalledWith({ thinkingLevel: "high" });
			expect(context.footer.invalidate).toHaveBeenCalledWith();
			expect(context.updateEditorBorderColor).toHaveBeenCalledWith();
			expect(context.showError).not.toHaveBeenCalled();
		});

		it("rejects an unknown level without touching the connection", () => {
			const setThinkingLevel = vi.fn(async () => {});
			const context = makeContext({ agentConnection: { setThinkingLevel } });

			interactiveModePrototype.handleEffortCommand.call(context, "bogus");

			expect(setThinkingLevel).not.toHaveBeenCalled();
			expect(context.showError).toHaveBeenCalledWith(
				"Unknown thinking level 'bogus'. Available: off, low, medium, high",
			);
		});

		it("shows the current level and choices when called without an argument", () => {
			const context = makeContext();

			interactiveModePrototype.handleEffortCommand.call(context, "");

			expect(context.agentConnection.setThinkingLevel).not.toHaveBeenCalled();
			expect(context.showStatus).toHaveBeenCalledWith(
				"Thinking level: medium (type a level: off, low, medium, high)",
			);
		});

		it("reports when the model does not support thinking", () => {
			const context = makeContext({
				connectionState: { thinkingLevel: "off", availableThinkingLevels: ["off"] },
			});

			interactiveModePrototype.handleEffortCommand.call(context, "high");

			expect(context.agentConnection.setThinkingLevel).not.toHaveBeenCalled();
			expect(context.showStatus).toHaveBeenCalledWith("Current model does not support thinking");
		});

		it("surfaces an error when applying a level fails", async () => {
			const setThinkingLevel = vi.fn(async () => {
				throw new Error("nope");
			});
			const context = makeContext({ agentConnection: { setThinkingLevel } });

			interactiveModePrototype.handleEffortCommand.call(context, "high");
			await vi.waitFor(() => expect(context.showError).toHaveBeenCalledWith("nope"));

			expect(context.patchConnectionState).not.toHaveBeenCalled();
		});
	});

	describe("model switch refresh", () => {
		it("refreshes availableThinkingLevels from the newly selected model", async () => {
			type ModelContext = {
				agentConnection: { setModel: (provider: string, id: string) => Promise<void> };
				settingsManager: { setDefaultModelAndProvider: (provider: string, id: string) => void };
				patchConnectionState: (patch: Record<string, unknown>) => void;
				footer: { invalidate: () => void };
				updateEditorBorderColor: () => void;
				setupAutocompleteProvider: () => void;
			};
			const applySelectedModel = (
				InteractiveMode.prototype as unknown as {
					applySelectedModel(this: ModelContext, model: unknown): Promise<void>;
				}
			).applySelectedModel;
			const patchConnectionState = vi.fn();
			const setupAutocompleteProvider = vi.fn();
			const context: ModelContext = {
				agentConnection: { setModel: vi.fn(async () => {}) },
				settingsManager: { setDefaultModelAndProvider: vi.fn() },
				patchConnectionState,
				footer: { invalidate: vi.fn() },
				updateEditorBorderColor: vi.fn(),
				setupAutocompleteProvider,
			};
			const model = { provider: "anthropic", id: "claude-opus", reasoning: true };

			await applySelectedModel.call(context, model);

			const patch = patchConnectionState.mock.calls[0][0];
			expect(patch.model).toBe(model);
			expect(patch.availableThinkingLevels).toContain("high");
			expect(patch.availableThinkingLevels.length).toBeGreaterThan(1);
			// Provider rebuild keeps the /effort argument hint in sync with the model.
			expect(setupAutocompleteProvider).toHaveBeenCalledTimes(1);
		});
	});
});
