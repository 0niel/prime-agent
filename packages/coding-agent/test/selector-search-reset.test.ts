import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/index.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { PrimeTeamSelectorComponent } from "../src/modes/interactive/components/prime-team-selector.js";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

const DOWN = "\x1b[B";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function moveDown(component: { handleInput(data: string): void }, count: number): void {
	for (let index = 0; index < count; index++) {
		component.handleInput(DOWN);
	}
}

function makeSession(index: number): AgentConnectionSavedSessionInfo {
	return {
		path: `/tmp/session-${index}.jsonl`,
		id: `session-${index}`,
		cwd: "/tmp",
		name: `Session ${index}`,
		created: new Date(index),
		modified: new Date(index),
		messageCount: 1,
		firstMessage: "common topic",
		allMessagesText: "common topic",
	};
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("searchable selector navigation", () => {
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

	it("selects the first model after the search query changes", async () => {
		const harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `faux-${index + 1}`,
				name: `Faux ${index + 1}`,
				reasoning: true,
			})),
		});
		harnesses.push(harness);
		let selectedModelId: string | undefined;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.session.modelRegistry,
			[],
			(model) => {
				selectedModelId = model.id;
			},
			() => {},
			undefined,
			{ availableModels: harness.models },
		);

		moveDown(selector, 8);
		selector.handleInput("f");
		selector.handleInput("\r");

		expect(selectedModelId).toBe("faux-1");
	});

	it("selects the first provider after the search query changes", () => {
		let selectedProviderId: string | undefined;
		const selector = new OAuthSelectorComponent(
			"login",
			AuthStorage.inMemory(),
			Array.from({ length: 12 }, (_, index) => ({
				id: `provider-${index + 1}`,
				name: `Provider ${String(index + 1).padStart(2, "0")}`,
				authType: "api_key" as const,
			})),
			(provider) => {
				selectedProviderId = provider.id;
			},
			() => {},
		);

		moveDown(selector, 8);
		selector.handleInput("p");
		selector.handleInput("\r");

		expect(selectedProviderId).toBe("provider-1");
	});

	it("selects the first team after the search query changes", () => {
		let selectedTeamId: string | undefined;
		const selector = new PrimeTeamSelectorComponent(
			Array.from({ length: 12 }, (_, index) => ({
				teamId: `team-${index + 1}`,
				name: `Team ${String(index + 1).padStart(2, "0")}`,
			})),
			undefined,
			(team) => {
				selectedTeamId = team?.teamId;
			},
			() => {},
		);

		moveDown(selector, 8);
		selector.handleInput("t");
		selector.handleInput("\r");

		expect(selectedTeamId).toBe("team-1");
	});

	it("toggles the first scoped model after the search query changes", async () => {
		const harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({
				id: `faux-${index + 1}`,
				name: `Faux ${index + 1}`,
				reasoning: true,
			})),
		});
		harnesses.push(harness);
		let enabledModelIds: string[] | null | undefined;
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: harness.models, enabledModelIds: [] },
			{
				onChange: (ids) => {
					enabledModelIds = ids;
				},
				onPersist: () => {},
				onCancel: () => {},
			},
		);

		moveDown(selector, 8);
		selector.handleInput("f");
		selector.handleInput("\r");

		expect(enabledModelIds).toEqual([`${harness.models[0]?.provider}/faux-1`]);
	});

	it("selects the first session after the search query changes", async () => {
		const sessions = Array.from({ length: 12 }, (_, index) => makeSession(index + 1));
		let selectedPath: string | undefined;
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => sessions,
			(path) => {
				selectedPath = path;
			},
			() => {},
			() => {},
			() => {},
		);
		await flushPromises();

		const list = selector.getSessionList();
		moveDown(list, 8);
		list.handleInput("c");
		list.handleInput("\r");

		expect(selectedPath).toBe(sessions.at(-1)?.path);
	});
});
