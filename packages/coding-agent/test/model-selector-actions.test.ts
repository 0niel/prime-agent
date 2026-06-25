import { type KeyId, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

async function waitForAsyncRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ModelSelectorComponent provider actions", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("shows provider setup shortcut in the warning and emits the selected action", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "One", reasoning: true }],
		});
		harnesses.push(harness);

		let selectedAction: string | undefined;
		let selectedModel: string | undefined;
		setKeybindings(new KeybindingsManager({ "app.provider.add": "ctrl+x" as KeyId }));
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("faux-1"),
			harness.session.modelRegistry,
			[],
			(model) => {
				selectedModel = model.id;
			},
			() => {},
			undefined,
			{
				actions: [{ id: "add_provider", label: "Add provider...", description: "subscription or API key" }],
				onAction: (actionId) => {
					selectedAction = actionId;
				},
				subtitle: "Choose a Prime model, or add another provider.",
			},
		);

		await waitForAsyncRender();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Choose a Prime model, or add another provider.");
		expect(output).toContain("Ctrl+X to add providers and access more models.");
		expect(output.indexOf("add provider")).toBeLessThan(output.indexOf("Search models"));
		expect(output.match(/add provider/g)).toHaveLength(1);

		selector.handleInput("\r");
		expect(selectedModel).toBe("faux-1");

		selector.handleInput("\x18");

		expect(selectedAction).toBe("add_provider");
	});

	it("uses injected available models when refreshing scoped models", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "Local One", reasoning: true }],
		});
		harnesses.push(harness);

		const localModel = harness.getModel("faux-1")!;
		const connectionModel = { ...localModel, name: "Connection One" };
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			localModel,
			harness.session.modelRegistry,
			[{ model: localModel }],
			() => {},
			() => {},
			undefined,
			{
				availableModels: [connectionModel],
			},
		);

		await waitForAsyncRender();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Connection One");
		expect(output).not.toContain("Local One");
	});

	it("keeps the model menu within a short terminal viewport", async () => {
		const harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `faux-${index + 1}`,
				name: `Faux Model ${index + 1}`,
				reasoning: true,
			})),
		});
		harnesses.push(harness);

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("faux-1"),
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			undefined,
			{ getRows: () => 12 },
		);

		await waitForAsyncRender();

		expect(selector.render(120)).toHaveLength(12);

		selector.handleInput("\x1b[B");
		const output = stripAnsi(selector.render(120).join("\n"));

		expect(selector.render(120)).toHaveLength(12);
		expect(output).toContain("faux-2");
		expect(output).toContain("(2/12)");
	});

	it("orders search matches by recency among equally-good fuzzy matches", async () => {
		const harness = await createHarness({
			models: [
				{ id: "glm-5", name: "GLM 5", reasoning: true },
				{ id: "glm-5.1", name: "GLM 5.1", reasoning: true },
				{ id: "glm-5.2", name: "GLM 5.2", reasoning: true },
			],
		});
		harnesses.push(harness);

		const provider = harness.getModel("glm-5")!.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"glm",
			{ recentModels: [`${provider}/glm-5.2`, `${provider}/glm-5.1`] },
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const row52 = lines.findIndex((line) => /glm-5\.2/.test(line));
		const row51 = lines.findIndex((line) => /glm-5\.1/.test(line));
		const row5 = lines.findIndex((line) => /glm-5(?![.\d])/.test(line));
		expect(row52).toBeGreaterThanOrEqual(0);
		expect(row52).toBeLessThan(row51);
		expect(row51).toBeLessThan(row5);
	});

	it("treats a whitespace-only query as no search and keeps the current model first", async () => {
		const harness = await createHarness({
			models: [
				{ id: "glm-5", name: "GLM 5", reasoning: true },
				{ id: "glm-5.1", name: "GLM 5.1", reasoning: true },
				{ id: "glm-5.2", name: "GLM 5.2", reasoning: true },
			],
		});
		harnesses.push(harness);

		const provider = harness.getModel("glm-5")!.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("glm-5"),
			harness.session.modelRegistry,
			[],
			() => {},
			() => {},
			"   ",
			{ recentModels: [`${provider}/glm-5.2`, `${provider}/glm-5.1`] },
		);

		await waitForAsyncRender();

		const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
		const firstRow = lines.findIndex((line) => /glm-5/.test(line));
		expect(/glm-5(?![.\d])/.test(lines[firstRow] ?? "")).toBe(true);
	});

	it("keeps scoped model help within a short terminal viewport", async () => {
		const harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `faux-${index + 1}`,
				name: `Faux Model ${index + 1}`,
				reasoning: true,
			})),
		});
		harnesses.push(harness);
		const scopedModels = Array.from({ length: 12 }, (_, index) => {
			const model = harness.getModel(`faux-${index + 1}`);
			if (!model) {
				throw new Error(`Missing model faux-${index + 1}`);
			}
			return { model };
		});

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("faux-1"),
			harness.session.modelRegistry,
			scopedModels,
			() => {},
			() => {},
			undefined,
			{ getRows: () => 16 },
		);

		await waitForAsyncRender();

		const lines = selector.render(120);
		const output = stripAnsi(lines.join("\n"));

		expect(lines.length).toBeLessThanOrEqual(16);
		expect(output).toContain("Scope: ");
		expect(output).toContain("(all/scoped)");
		expect(output).toContain("(1/12)");
	});
});
