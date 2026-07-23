import { Container, getKeybindings, Spacer, Text } from "@earendil-works/pi-tui";
import type { SessionImportInventory, SessionImportSource } from "../../../core/session-import/index.js";
import { orderedSelectedSources } from "../../../core/session-import/index.js";
import { keyHint, rawKeyHint } from "./keybinding-hints.js";
import { MenuList, MenuPanel, MenuRow } from "./menu-panel.js";

function countLabel(count: number, singular: string): string {
	return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export class SessionImportSelectorComponent extends Container {
	private readonly selectedSources: Set<SessionImportSource>;
	private readonly list = new MenuList({ compact: true });
	private selectedIndex = 0;

	constructor(
		private readonly inventories: SessionImportInventory[],
		private readonly onSelect: (sources: SessionImportSource[]) => void,
		private readonly onCancel: () => void,
	) {
		super();
		this.selectedSources = new Set(inventories.map((inventory) => inventory.source));
		this.selectedIndex = inventories.length;
		const panel = new MenuPanel({
			title: "Bring your work with you",
			subtitle: "Import local sessions and skills. Existing Prime data is never overwritten.",
		});
		panel.addChild(this.list);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "toggle / confirm") +
					"  " +
					keyHint("tui.select.cancel", "skip"),
				1,
				0,
			),
		);
		this.addChild(panel);
		this.updateList();
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		const itemCount = this.inventories.length + 1;
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = (this.selectedIndex - 1 + itemCount) % itemCount;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = (this.selectedIndex + 1) % itemCount;
			this.updateList();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		if (!kb.matches(keyData, "tui.select.confirm")) {
			return;
		}
		const inventory = this.inventories[this.selectedIndex];
		if (inventory) {
			if (this.selectedSources.has(inventory.source)) {
				this.selectedSources.delete(inventory.source);
			} else {
				this.selectedSources.add(inventory.source);
			}
			this.updateList();
			return;
		}
		this.onSelect(orderedSelectedSources(this.selectedSources));
	}

	private updateList(): void {
		this.list.clear();
		for (const [index, inventory] of this.inventories.entries()) {
			const selected = this.selectedSources.has(inventory.source);
			const counts = [
				inventory.sessionCount > 0 ? countLabel(inventory.sessionCount, "session") : undefined,
				inventory.skillCount > 0 ? countLabel(inventory.skillCount, "skill") : undefined,
			]
				.filter((value): value is string => value !== undefined)
				.join(", ");
			this.list.addChild(
				new MenuRow({
					primary: `${selected ? "✓" : " "}  ${inventory.label}`,
					secondary: counts,
					meta: selected ? "selected" : "not selected",
					selected: index === this.selectedIndex,
				}),
			);
		}
		const selectedCount = this.selectedSources.size;
		this.list.addChild(new Spacer(1));
		this.list.addChild(
			new MenuRow({
				primary: selectedCount > 0 ? "Import selected sessions and skills" : "Continue without importing",
				meta: selectedCount > 0 ? `${countLabel(selectedCount, "source")} selected` : undefined,
				selected: this.selectedIndex === this.inventories.length,
			}),
		);
	}
}
