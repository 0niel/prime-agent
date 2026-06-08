import { Container, type Focusable, fuzzyFilter, getKeybindings, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import type { AuthStatus, AuthStorage } from "../../../core/auth-storage.js";
import { theme } from "../theme/theme.js";
import {
	getMenuListLayout,
	MenuList,
	MenuPanel,
	MenuRow,
	MenuSearchInput,
	type MenuViewportProvider,
} from "./menu-panel.js";

export type AuthSelectorProvider = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
};

export function compareAuthSelectorProviders(a: AuthSelectorProvider, b: AuthSelectorProvider): number {
	if (a.authType !== b.authType) {
		return a.authType === "oauth" ? -1 : 1;
	}
	return a.name.localeCompare(b.name);
}

const PREFERRED_VISIBLE_PROVIDERS = 8;
const PROVIDER_LIST_RESERVED_ROWS = 7;
const PROVIDER_SCROLL_INDICATOR_ROWS = 1;

/**
 * Component that renders an auth provider selector
 */
export class OAuthSelectorComponent extends Container implements Focusable {
	private searchInput: MenuSearchInput;

	// Focusable implementation - propagate to search input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private listContainer: Container;
	private allProviders: AuthSelectorProvider[];
	private filteredProviders: AuthSelectorProvider[];
	private selectedIndex: number = 0;
	private mode: "login" | "logout";
	private authStorage: AuthStorage;
	private getAuthStatus: (providerId: string) => AuthStatus;
	private onSelectCallback: (provider: AuthSelectorProvider) => void;
	private onCancelCallback: () => void;
	private listLayout = getMenuListLayout({
		preferredVisibleItems: PREFERRED_VISIBLE_PROVIDERS,
		reservedRows: PROVIDER_LIST_RESERVED_ROWS,
		comfortableItemRows: 3,
		compactItemRows: 2,
	});
	private readonly viewport: MenuViewportProvider;

	constructor(
		mode: "login" | "logout",
		authStorage: AuthStorage,
		providers: AuthSelectorProvider[],
		onSelect: (provider: AuthSelectorProvider) => void,
		onCancel: () => void,
		getAuthStatus?: (providerId: string) => AuthStatus,
		viewport: MenuViewportProvider = {},
	) {
		super();

		this.mode = mode;
		this.authStorage = authStorage;
		this.getAuthStatus = getAuthStatus ?? ((providerId) => this.authStorage.getAuthStatus(providerId));
		this.viewport = viewport;
		this.allProviders = this.sortProviders(providers);
		this.filteredProviders = this.allProviders;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		const panel = new MenuPanel({
			title: mode === "login" ? "Providers" : "Saved Credentials",
			subtitle: mode === "login" ? "Connect with a subscription or API key." : "Choose a credential to remove.",
		});
		this.addChild(panel);

		this.searchInput = new MenuSearchInput("Search providers");
		this.searchInput.onSubmit = () => {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider);
			}
		};
		panel.addChild(this.searchInput);
		panel.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new MenuList({ compact: () => this.listLayout.compact });
		panel.addChild(this.listContainer);

		// Initial render
		this.filterProviders("");
	}

	private filterProviders(query: string): void {
		this.filteredProviders = query
			? fuzzyFilter(this.allProviders, query, (provider) => `${provider.name} ${provider.id} ${provider.authType}`)
			: this.allProviders;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredProviders.length - 1)));
		this.updateList();
	}

	private sortProviders(providers: AuthSelectorProvider[]): AuthSelectorProvider[] {
		return [...providers].sort((a, b) => {
			const configuredDelta = Number(this.isProviderConfigured(b)) - Number(this.isProviderConfigured(a));
			if (configuredDelta !== 0) {
				return configuredDelta;
			}
			return compareAuthSelectorProviders(a, b);
		});
	}

	private isProviderConfigured(provider: AuthSelectorProvider): boolean {
		const credential = this.authStorage.get(provider.id);
		if (credential) {
			return true;
		}
		if (provider.authType !== "api_key") {
			return false;
		}
		return this.getAuthStatus(provider.id).source !== undefined;
	}

	override render(width: number): string[] {
		const previousLayout = this.listLayout;
		this.updateLayout();
		if (
			this.listLayout.compact !== previousLayout.compact ||
			this.listLayout.visibleItems !== previousLayout.visibleItems
		) {
			this.updateList();
		}
		return super.render(width);
	}

	private updateList(): void {
		this.updateLayout();
		this.listContainer.clear();

		const maxVisible = this.listLayout.visibleItems;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredProviders.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredProviders.length);

		for (let i = startIndex; i < endIndex; i++) {
			const provider = this.filteredProviders[i];
			if (!provider) continue;

			const isSelected = i === this.selectedIndex;

			this.listContainer.addChild(
				new MenuRow({
					primary: provider.name,
					secondary: provider.authType === "oauth" ? "subscription" : "api key",
					meta: this.formatStatusIndicator(provider),
					selected: isSelected,
				}),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredProviders.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredProviders.length})`);
			this.listContainer.addChild(new TruncatedText(scrollInfo, 1, 0));
		}

		// Show "no providers" if empty
		if (this.filteredProviders.length === 0) {
			const message =
				this.allProviders.length === 0
					? this.mode === "login"
						? "No providers available"
						: "No providers logged in. Use /login first."
					: "No matching providers";
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", message), 1, 0));
		}
	}

	private formatStatusIndicator(provider: AuthSelectorProvider): string {
		const credential = this.authStorage.get(provider.id);
		if (credential?.type === provider.authType) return theme.fg("success", "configured");
		if (credential) {
			const label = credential.type === "oauth" ? "subscription configured" : "API key configured";
			return theme.fg("warning", label);
		}
		if (provider.authType !== "api_key") return theme.fg("muted", "unconfigured");

		const status = this.getAuthStatus(provider.id);
		switch (status.source) {
			case "environment":
				return theme.fg("success", `env: ${status.label ?? "API key"}`);
			case "prime_cli":
				return theme.fg("success", status.label ?? "Prime CLI");
			case "runtime":
				return theme.fg("success", "runtime API key");
			case "fallback":
				return theme.fg("success", "custom API key");
			case "models_json_key":
				return theme.fg("success", "key in models.json");
			case "models_json_command":
				return theme.fg("success", "command in models.json");
			default:
				return theme.fg("muted", "unconfigured");
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredProviders.length === 0) return;
			this.selectedIndex = Math.min(this.filteredProviders.length - 1, this.selectedIndex + 1);
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedProvider = this.filteredProviders[this.selectedIndex];
			if (selectedProvider) {
				this.onSelectCallback(selectedProvider);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterProviders(this.searchInput.getValue());
		}
	}

	private updateLayout(): void {
		this.listLayout = getMenuListLayout({
			getRows: this.viewport.getRows,
			preferredVisibleItems: PREFERRED_VISIBLE_PROVIDERS,
			totalItems: this.filteredProviders.length,
			reservedRows: PROVIDER_LIST_RESERVED_ROWS,
			comfortableItemRows: 3,
			compactItemRows: 2,
			scrollIndicatorRows: PROVIDER_SCROLL_INDICATOR_ROWS,
		});
	}
}
