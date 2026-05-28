import { Container, type Focusable, fuzzyFilter, getKeybindings, Spacer, TruncatedText } from "@earendil-works/pi-tui";
import type { PrimeTeam } from "../../../core/prime-inference-auth.js";
import { theme } from "../theme/theme.js";
import { MenuList, MenuPanel, MenuRow, MenuSearchInput } from "./menu-panel.js";

type PrimeTeamOption = {
	type: "personal" | "team";
	team: PrimeTeam | null;
};

export class PrimeTeamSelectorComponent extends Container implements Focusable {
	private readonly searchInput: MenuSearchInput;
	private readonly listContainer: Container;
	private readonly allOptions: PrimeTeamOption[];
	private filteredOptions: PrimeTeamOption[];
	private selectedIndex = 0;
	private _focused = false;

	constructor(
		teams: PrimeTeam[],
		private readonly currentTeamId: string | undefined,
		private readonly onSelect: (team: PrimeTeam | null) => void,
		private readonly onCancel: () => void,
	) {
		super();

		this.allOptions = [{ type: "personal", team: null }, ...teams.map((team) => ({ type: "team" as const, team }))];
		this.filteredOptions = this.allOptions;

		const panel = new MenuPanel({
			title: "Prime Team",
			subtitle: "Choose which account pays for Prime Inference usage.",
		});
		this.addChild(panel);

		this.searchInput = new MenuSearchInput("Search teams");
		this.searchInput.onSubmit = () => {
			const selected = this.filteredOptions[this.selectedIndex];
			if (selected) {
				this.onSelect(selected.team);
			}
		};
		panel.addChild(this.searchInput);
		panel.addChild(new Spacer(1));

		this.listContainer = new MenuList();
		panel.addChild(this.listContainer);
		this.filterOptions("");
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private filterOptions(query: string): void {
		this.filteredOptions = query
			? fuzzyFilter(this.allOptions, query, (option) => this.getSearchText(option))
			: this.allOptions;
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, this.filteredOptions.length - 1)));
		this.updateList();
	}

	private getSearchText(option: PrimeTeamOption): string {
		if (option.type === "personal") {
			return "personal account";
		}
		const team = option.team;
		return team ? `${team.name} ${team.slug ?? ""} ${team.role ?? ""} ${team.teamId}` : "";
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 8;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredOptions.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredOptions.length);

		for (let i = startIndex; i < endIndex; i++) {
			const option = this.filteredOptions[i];
			if (!option) {
				continue;
			}
			this.listContainer.addChild(
				new MenuRow({
					primary: this.getPrimary(option),
					secondary: this.getSecondary(option),
					meta: this.getMeta(option),
					selected: i === this.selectedIndex,
				}),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredOptions.length) {
			this.listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredOptions.length})`), 1, 0),
			);
		}

		if (this.filteredOptions.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "No matching teams"), 1, 0));
		}
	}

	private getPrimary(option: PrimeTeamOption): string {
		return option.team?.name ?? "Personal";
	}

	private getSecondary(option: PrimeTeamOption): string {
		if (!option.team) {
			return "personal account";
		}
		const role = option.team.role?.toLowerCase() ?? "member";
		return option.team.slug ? `slug: ${option.team.slug}, role: ${role}` : `role: ${role}`;
	}

	private getMeta(option: PrimeTeamOption): string {
		const isCurrent = option.team ? option.team.teamId === this.currentTeamId : this.currentTeamId === undefined;
		return isCurrent ? theme.fg("success", "current") : "";
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredOptions.length === 0) {
				return;
			}
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredOptions.length === 0) {
				return;
			}
			this.selectedIndex = Math.min(this.filteredOptions.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredOptions[this.selectedIndex];
			if (selected) {
				this.onSelect(selected.team);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterOptions(this.searchInput.getValue());
		}
	}
}
