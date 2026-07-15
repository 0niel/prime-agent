/**
 * TUI session selector for --resume flag
 */

import { ProcessTerminal, setKeybindings, TUI } from "@earendil-works/pi-tui";
import { VERSION } from "../config.js";
import { KeybindingsManager } from "../core/keybindings.js";
import { type SessionInfo, type SessionListCallbacks, SessionManager } from "../core/session-manager.js";
import { SessionPickerScreen } from "../modes/interactive/components/session-picker-screen.js";
import { SessionSelectorComponent } from "../modes/interactive/components/session-selector.js";
import { BrandSplashHeader } from "../modes/interactive/interactive-mode.js";

type SessionsLoader = (callbacks?: SessionListCallbacks) => Promise<SessionInfo[]>;
type AllSessionsLoader = (callbacks?: SessionListCallbacks, sessionDir?: string) => Promise<SessionInfo[]>;

/** Show TUI session selector and return selected session path or null if cancelled */
export async function selectSession(
	currentSessionsLoader: SessionsLoader,
	allSessionsLoader: AllSessionsLoader,
	options?: { cwd?: string; modelId?: string; sessionDir?: string },
): Promise<string | null> {
	return new Promise((resolve) => {
		const ui = new TUI(new ProcessTerminal());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		let resolved = false;

		const selector = new SessionSelectorComponent(
			(callbacks) =>
				currentSessionsLoader({
					onProgress: callbacks?.onProgress,
					onSession: callbacks?.onSession,
				}),
			(callbacks) =>
				allSessionsLoader(
					{
						onProgress: callbacks?.onProgress,
						onSession: callbacks?.onSession,
					},
					options?.sessionDir,
				),
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
			{
				renameSession: async (sessionPath, nextName) => {
					const name = (nextName ?? "").trim();
					if (!name) return;
					SessionManager.open(sessionPath, options?.sessionDir).appendSessionInfo(name);
				},
				showRenameHint: true,
				keybindings,
				frameless: true,
			},
		);

		const splash = new BrandSplashHeader(
			VERSION,
			() => options?.modelId,
			() => options?.cwd ?? process.cwd(),
		);
		ui.addChild(new SessionPickerScreen(ui, splash, selector));
		ui.setFocus(selector);
		ui.start();
	});
}
