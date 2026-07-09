import { type Component, type Focusable, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionSelectorComponent } from "./session-selector.js";

export function sessionPickerListMaxVisible(rows: number, headerLines: number): number {
	return Math.max(3, rows - headerLines - 10);
}

export class SessionPickerScreen implements Component, Focusable {
	private _focused = false;

	constructor(
		private readonly ui: TUI,
		private readonly header: Component,
		private readonly selector: SessionSelectorComponent,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.selector.focused = value;
	}

	handleInput(data: string): void {
		this.selector.handleInput(data);
	}

	invalidate(): void {
		this.header.invalidate?.();
		this.selector.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.ui.terminal.rows);
		const headerLines = this.header.render(safeWidth);
		this.selector.setListMaxVisible(sessionPickerListMaxVisible(height, headerLines.length));
		const content = [...headerLines, ...this.selector.render(safeWidth)];

		const lines = content.slice(0, height).map((line) => {
			const truncated = truncateToWidth(line, safeWidth, "");
			return truncated + " ".repeat(Math.max(0, safeWidth - visibleWidth(truncated)));
		});
		while (lines.length < height) {
			lines.push(" ".repeat(safeWidth));
		}
		return lines;
	}
}
