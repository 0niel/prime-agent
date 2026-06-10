/**
 * TUI session selector for --resume flag
 */

import { type Component, ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { VERSION } from "../config.js";
import { KeybindingsManager } from "../core/keybindings.js";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.js";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.js";
import { BrandSplashHeader } from "../modes/interactive/interactive-mode.js";

type SessionsLoader = (onProgress?: SessionListProgress) => Promise<SessionInfo[]>;

/** Full-screen layout matching the agents view: brand splash on top, selector below. */
class SessionPickerScreen implements Component {
	constructor(
		private readonly ui: TUI,
		private readonly splash: BrandSplashHeader,
		private readonly selector: SessionSelectorComponent,
	) {}

	invalidate(): void {
		this.splash.invalidate();
		this.selector.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = Math.max(1, this.ui.terminal.rows);
		const splashLines = this.splash.render(safeWidth);
		// Selector chrome (header, hints, search, spacers) takes ~8 rows; give the
		// list the rest of the terminal instead of its compact default.
		this.selector.setListMaxVisible(height - splashLines.length - 10);
		const lines = [...splashLines, ...this.selector.render(safeWidth)];
		while (lines.length < height) {
			lines.push("");
		}
		return lines.slice(0, height);
	}
}

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: SessionsLoader,
	options?: { cwd?: string; modelId?: string },
): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			currentSessionsLoader,
			allSessionsLoader,
			(path: string) => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(path);
				}
			},
			() => {
				if (!resolved) {
					resolved = true;
					ui.stop();
					resolve(null);
				}
			},
			() => {
				ui.stop();
				process.exit(0);
			},
			() => ui.requestRender(),
			{ showRenameHint: false, keybindings, frameless: true },
		);

		const splash = new BrandSplashHeader(
			VERSION,
			() => options?.modelId,
			() => options?.cwd ?? process.cwd(),
		);
		ui.addChild(new SessionPickerScreen(ui, splash, selector));
		ui.setFocus(selector.getSessionList());
		ui.start();
	});
}
