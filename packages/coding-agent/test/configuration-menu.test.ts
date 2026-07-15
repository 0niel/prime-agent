import { type KeyId, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	ConfigurationMenuComponent,
	type ConfigurationMenuTab,
} from "../src/modes/interactive/components/configuration-menu.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

describe("ConfigurationMenuComponent", () => {
	const harnesses: Harness[] = [];

	async function createMenu(
		options: {
			initialTab?: ConfigurationMenuTab;
			getRows?: () => number;
			requestRender?: () => void;
			onSelectProvider?: () => void;
		} = {},
	): Promise<ConfigurationMenuComponent> {
		const harness = await createHarness({
			models: [{ id: "faux-1", name: "Faux One", reasoning: true }],
		});
		harnesses.push(harness);
		const model = harness.getModel("faux-1")!;
		return new ConfigurationMenuComponent({
			initialTab: options.initialTab ?? "providers",
			tui: createFakeTui(),
			authStorage: harness.session.modelRegistry.authStorage,
			providerOptions: [
				{ id: "anthropic", name: "Anthropic", authType: "oauth" },
				{
					id: "serper",
					name: "Serper (web search)",
					authType: "api_key",
					category: "service",
				},
			],
			modelRegistry: harness.session.modelRegistry,
			currentModel: model,
			scopedModels: [],
			availableModels: [model],
			getRows: options.getRows,
			requestRender: options.requestRender ?? (() => {}),
			onSelectProvider: options.onSelectProvider ?? (() => {}),
			onSelectMcpConnection: () => {},
			onSelectModel: () => {},
			onCancel: () => {},
		});
	}

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		initTheme("dark");
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("uses one clearly delineated three-tab menu and keeps each tab body mounted", async () => {
		const requestRender = vi.fn();
		const selectProvider = vi.fn();
		const menu = await createMenu({ requestRender, onSelectProvider: selectProvider });

		let output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("Tabs:");
		expect(output).toContain("[▶ Providers]");
		expect(output).toContain("[  Models]");
		expect(output).toContain("[  MCP Connections]");
		expect(output).toContain("Anthropic");
		expect(output).not.toContain("Serper (web search)");

		menu.handleInput("a");
		menu.setActiveTab("models");
		output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("[  Providers]");
		expect(output).toContain("[▶ Models]");
		expect(output).toContain("Faux One");

		menu.setActiveTab("providers");
		output = stripAnsi(menu.render(120).join("\n"));
		expect(menu.getSearchValue("providers")).toBe("a");
		expect(output).toContain("Anthropic");
		expect(requestRender).toHaveBeenCalled();

		menu.handleInput("\r");
		expect(selectProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "anthropic" }));

		menu.setActiveTab("mcp-connections");
		output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("[▶ MCP Connections]");
		expect(output).toContain("Serper (web search)");
		expect(output).not.toContain("Anthropic");
	});

	it("switches tabs with configured bindings and preserves focus and search state", async () => {
		setKeybindings(
			new KeybindingsManager({
				"app.configuration.previousTab": "ctrl+y" as KeyId,
				"app.configuration.nextTab": "ctrl+x" as KeyId,
			}),
		);
		const menu = await createMenu();
		menu.focused = true;
		expect(stripAnsi(menu.render(120).join("\n"))).toContain("Ctrl+Y/Ctrl+X switch tabs");

		menu.handleInput("\x18");
		expect(menu.getActiveTab()).toBe("models");
		expect(menu.focused).toBe(true);
		menu.handleInput("f");
		expect(menu.getSearchValue("models")).toBe("f");
		menu.handleInput("\x18");
		expect(menu.getActiveTab()).toBe("mcp-connections");
		expect(menu.getSearchValue("models")).toBe("f");
		menu.handleInput("\x19");
		expect(menu.getActiveTab()).toBe("models");
	});

	it("keeps the existing catalog while syncing a post-login current model", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", name: "Faux One", reasoning: true },
				{ id: "faux-2", name: "Faux Two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const firstModel = harness.getModel("faux-1")!;
		const postLoginModel = harness.getModel("faux-2")!;
		const menu = new ConfigurationMenuComponent({
			initialTab: "models",
			tui: createFakeTui(),
			authStorage: harness.session.modelRegistry.authStorage,
			providerOptions: [],
			modelRegistry: harness.session.modelRegistry,
			currentModel: undefined,
			scopedModels: [],
			availableModels: [firstModel],
			initialModelSearch: "faux",
			requestRender: () => {},
			onSelectProvider: () => {},
			onSelectMcpConnection: () => {},
			onSelectModel: () => {},
			onCancel: () => {},
		});

		menu.updateModels(postLoginModel);
		let output = stripAnsi(menu.render(120).join("\n"));
		expect(output).toContain("faux-1");
		expect(menu.getSearchValue("models")).toBe("faux");

		menu.updateModels(postLoginModel, [firstModel, postLoginModel]);
		output = stripAnsi(menu.render(120).join("\n"));
		const postLoginRow = output.split("\n").find((line) => line.includes("faux-2"));
		expect(postLoginRow).toContain("current");
	});

	it("keeps default arrow keys in the active search field while it contains text", async () => {
		const menu = await createMenu();

		menu.handleInput("a");
		menu.handleInput("n");
		menu.handleInput("\x1b[D");
		menu.handleInput("\x1b[C");

		expect(menu.getActiveTab()).toBe("providers");
		expect(menu.getSearchValue()).toBe("an");
	});

	it("wraps complete tab labels at narrow widths without overflowing the viewport", async () => {
		const menu = await createMenu({ getRows: () => 24 });

		for (const tab of ["providers", "models", "mcp-connections"] as const) {
			menu.setActiveTab(tab);
			const lines = menu.render(24);
			const output = stripAnsi(lines.join("\n"));
			expect(output).toContain("Providers");
			expect(output).toContain("Models");
			expect(output).toContain("MCP Connections");
			expect(lines.length).toBeLessThanOrEqual(24);
			for (const line of lines) {
				expect(visibleWidth(line)).toBe(24);
			}
		}
	});

	it("keeps the active marker visible across supported themes", async () => {
		const menu = await createMenu();

		for (const themeName of ["dark", "light", "prime"] as const) {
			initTheme(themeName);
			const rendered = menu.render(120).join("\n");
			expect(stripAnsi(rendered)).toContain("[▶ Providers]");
			expect(rendered).not.toBe(stripAnsi(rendered));
		}
	});
});
