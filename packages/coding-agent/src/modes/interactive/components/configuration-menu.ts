import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { AuthStorage } from "../../../core/auth-storage.js";
import type { ModelRegistry } from "../../../core/model-registry.js";
import { theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";
import { getMenuPanelInnerWidth } from "./menu-panel.js";
import { type ModelSelectorAction, ModelSelectorComponent } from "./model-selector.js";
import { type AuthSelectorProvider, OAuthSelectorComponent } from "./oauth-selector.js";

export const CONFIGURATION_MENU_TABS = ["providers", "models", "mcp-connections"] as const;

export type ConfigurationMenuTab = (typeof CONFIGURATION_MENU_TABS)[number];

export interface ConfigurationMenuScopedModel {
	model: Model<Api>;
	thinkingLevel?: string;
}

export interface ConfigurationMenuOptions {
	initialTab: ConfigurationMenuTab;
	tui: TUI;
	authStorage: AuthStorage;
	providerOptions: ReadonlyArray<AuthSelectorProvider>;
	modelRegistry: ModelRegistry;
	currentModel: Model<Api> | undefined;
	scopedModels: ReadonlyArray<ConfigurationMenuScopedModel>;
	availableModels: ReadonlyArray<Model<Api>>;
	recentModels?: ReadonlyArray<string>;
	initialModelSearch?: string;
	getRows?: () => number;
	requestRender: () => void;
	onSelectProvider: (provider: AuthSelectorProvider) => void;
	onSelectMcpConnection: (provider: AuthSelectorProvider) => void;
	onSelectModel: (model: Model<Api>) => void;
	onCancel: () => void;
}

const MODEL_SELECTOR_ACTIONS: readonly ModelSelectorAction[] = [
	{ id: "add_provider", label: "Add provider...", description: "subscription or API key" },
];

const TAB_LABELS: Record<ConfigurationMenuTab, string> = {
	providers: "Providers",
	models: "Models",
	"mcp-connections": "MCP Connections",
};

class ConfigurationMenuTabBar implements Component {
	constructor(private readonly getActiveTab: () => ConfigurationMenuTab) {}

	render(width: number): string[] {
		return this.getLines(width);
	}

	getRowCount(width: number): number {
		return this.getLines(width).length;
	}

	private getLines(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const activeTab = this.getActiveTab();
		const labels = CONFIGURATION_MENU_TABS.map((tab) => {
			const label = `[${tab === activeTab ? "▶" : " "} ${TAB_LABELS[tab]}]`;
			return tab === activeTab ? theme.bold(theme.fg("accent", label)) : theme.fg("text", label);
		});
		const lines = this.wrapItems(
			[theme.bold(theme.fg("muted", "Tabs:")), ...labels],
			theme.fg("muted", "  "),
			safeWidth,
		);
		const previousKey = keyText("app.configuration.previousTab", { primaryOnly: true });
		const nextKey = keyText("app.configuration.nextTab", { primaryOnly: true });
		const hint = `${theme.fg("dim", `${previousKey}/${nextKey}`)}${theme.fg("muted", " switch tabs")}`;
		const lastLine = lines.at(-1);
		if (lastLine && visibleWidth(`${lastLine}   ${hint}`) <= safeWidth) {
			lines[lines.length - 1] = `${lastLine}   ${hint}`;
			return lines;
		}
		return [...lines, ...wrapTextWithAnsi(hint, safeWidth)];
	}

	private wrapItems(items: string[], separator: string, width: number): string[] {
		const lines: string[] = [];
		let line = "";
		for (const item of items) {
			const candidate = line ? `${line}${separator}${item}` : item;
			if (line && visibleWidth(candidate) > width) {
				lines.push(...wrapTextWithAnsi(line, width));
				line = item;
			} else {
				line = candidate;
			}
		}
		if (line) {
			lines.push(...wrapTextWithAnsi(line, width));
		}
		return lines;
	}

	invalidate(): void {}
}

export class ConfigurationMenuComponent extends Container implements Focusable {
	private readonly bodies: {
		providers: OAuthSelectorComponent;
		models: ModelSelectorComponent;
		"mcp-connections": OAuthSelectorComponent;
	};
	private activeTab: ConfigurationMenuTab;
	private _focused = false;
	private renderWidth = 78;

	constructor(private readonly options: ConfigurationMenuOptions) {
		super();
		this.activeTab = options.initialTab;
		const tabBar = new ConfigurationMenuTabBar(() => this.activeTab);
		const getHeaderRows = () => tabBar.getRowCount(getMenuPanelInnerWidth(this.renderWidth)) + 1;
		const providerOptions = options.providerOptions.filter(
			(provider) => (provider.category ?? "provider") === "provider",
		);
		const mcpOptions = options.providerOptions.filter((provider) => provider.category === "service");

		const providers = new OAuthSelectorComponent(
			"login",
			options.authStorage,
			providerOptions,
			options.onSelectProvider,
			options.onCancel,
			(providerId) => options.modelRegistry.getProviderAuthStatus(providerId),
			{
				getRows: options.getRows,
				header: tabBar,
				getHeaderRows,
				title: "Providers",
				subtitle: "Connect with a subscription or API key.",
				searchPlaceholder: "Search providers",
			},
		);
		const models = new ModelSelectorComponent(
			options.tui,
			options.currentModel,
			options.modelRegistry,
			options.scopedModels,
			options.onSelectModel,
			options.onCancel,
			options.initialModelSearch,
			{
				actions: MODEL_SELECTOR_ACTIONS,
				availableModels: options.availableModels,
				header: tabBar,
				getHeaderRows,
				onAction: () => this.setActiveTab("providers"),
				getRows: options.getRows,
				recentModels: options.recentModels,
			},
		);
		const mcpConnections = new OAuthSelectorComponent(
			"login",
			options.authStorage,
			mcpOptions,
			options.onSelectMcpConnection,
			options.onCancel,
			(providerId) => options.modelRegistry.getProviderAuthStatus(providerId),
			{
				getRows: options.getRows,
				header: tabBar,
				getHeaderRows,
				title: "MCP Connections",
				subtitle: "Connect MCP integrations and service credentials.",
				searchPlaceholder: "Search MCP connections",
			},
		);

		this.bodies = {
			providers,
			models,
			"mcp-connections": mcpConnections,
		};
		this.addChild(this.activeBody);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.activeBody.focused = value;
	}

	override render(width: number): string[] {
		this.renderWidth = width;
		return super.render(width);
	}

	getActiveTab(): ConfigurationMenuTab {
		return this.activeTab;
	}

	getSearchValue(tab: ConfigurationMenuTab = this.activeTab): string {
		return this.bodies[tab].getSearchInput().getValue();
	}

	setActiveTab(tab: ConfigurationMenuTab): void {
		if (tab === this.activeTab) return;
		this.activeBody.focused = false;
		this.activeTab = tab;
		this.clear();
		this.addChild(this.activeBody);
		this.activeBody.focused = this._focused;
		this.options.requestRender();
	}

	refreshAuthentication(): void {
		this.bodies.providers.refresh();
		this.bodies["mcp-connections"].refresh();
		this.options.requestRender();
	}

	updateModels(currentModel: Model<Api> | undefined, models?: ReadonlyArray<Model<Api>>): void {
		this.bodies.models.updateState(currentModel, models);
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (
			kb.matches(keyData, "app.configuration.previousTab") &&
			(this.activeSearchIsEmpty() || !kb.matches(keyData, "tui.editor.cursorLeft"))
		) {
			this.switchTab(-1);
			return;
		}
		if (
			kb.matches(keyData, "app.configuration.nextTab") &&
			(this.activeSearchIsEmpty() || !kb.matches(keyData, "tui.editor.cursorRight"))
		) {
			this.switchTab(1);
			return;
		}
		this.activeBody.handleInput(keyData);
	}

	private get activeBody(): OAuthSelectorComponent | ModelSelectorComponent {
		return this.bodies[this.activeTab];
	}

	private activeSearchIsEmpty(): boolean {
		return this.activeBody.getSearchInput().getValue() === "";
	}

	private switchTab(direction: -1 | 1): void {
		const currentIndex = CONFIGURATION_MENU_TABS.indexOf(this.activeTab);
		const nextIndex = (currentIndex + direction + CONFIGURATION_MENU_TABS.length) % CONFIGURATION_MENU_TABS.length;
		this.setActiveTab(CONFIGURATION_MENU_TABS[nextIndex] ?? "providers");
	}
}
