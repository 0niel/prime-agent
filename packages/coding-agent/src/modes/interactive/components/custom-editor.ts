import { Editor, type EditorOptions, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.js";

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private defaultPromptPrefix: string;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onMoveBelowPrompt?: () => boolean;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: EditorOptions) {
		const promptPrefix = options?.promptPrefix ?? "> ";
		super(tui, theme, { ...options, promptPrefix });
		this.keybindings = keybindings;
		this.defaultPromptPrefix = promptPrefix;
	}

	protected override getPromptPrefix(): string {
		return this.getBashPromptInfo(this.getLines()[0] ?? "")?.promptPrefix ?? this.defaultPromptPrefix;
	}

	protected override formatPromptPrefix(prefix: string): string {
		return prefix.startsWith("!") ? this.borderColor(prefix) : prefix;
	}

	protected override getHiddenTextPrefixLength(lineIndex: number, line: string): number {
		if (lineIndex !== 0) {
			return 0;
		}
		return this.getBashPromptInfo(line)?.hiddenTextPrefixLength ?? 0;
	}

	private getBashPromptInfo(line: string): { promptPrefix: string; hiddenTextPrefixLength: number } | undefined {
		const trimmedLine = line.trimStart();
		const leadingWhitespaceLength = line.length - trimmedLine.length;
		if (trimmedLine.startsWith("!!")) {
			return {
				promptPrefix: "!! ",
				hiddenTextPrefixLength: leadingWhitespaceLength + (trimmedLine.startsWith("!! ") ? 3 : 2),
			};
		}
		if (trimmedLine.startsWith("!")) {
			return {
				promptPrefix: "! ",
				hiddenTextPrefixLength: leadingWhitespaceLength + (trimmedLine.startsWith("! ") ? 2 : 1),
			};
		}
		return undefined;
	}

	/**
	 * Register a handler for an app action.
	 */
	onAction(action: AppKeybinding, handler: () => void): void {
		this.actionHandlers.set(action, handler);
	}

	handleInput(data: string): void {
		// Check extension-registered shortcuts first
		if (this.onExtensionShortcut?.(data)) {
			return;
		}

		// Check for paste image keybinding
		if (this.keybindings.matches(data, "app.clipboard.pasteImage")) {
			this.onPasteImage?.();
			return;
		}

		// Check app keybindings first

		// Escape/interrupt - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.interrupt")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.interrupt");
				if (handler) {
					handler();
					return;
				}
			}
			// Let parent handle escape for autocomplete cancellation
			super.handleInput(data);
			return;
		}

		// Exit (Ctrl+D) - only when editor is empty
		if (this.keybindings.matches(data, "app.exit")) {
			if (this.getText().length === 0) {
				const handler = this.onCtrlD ?? this.actionHandlers.get("app.exit");
				if (handler) handler();
				return;
			}
			// Fall through to editor handling for delete-char-forward when not empty
		}

		// Check all other app actions
		for (const [action, handler] of this.actionHandlers) {
			if (action !== "app.interrupt" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				handler();
				return;
			}
		}

		if (
			this.keybindings.matches(data, "tui.editor.cursorDown") &&
			!this.isShowingAutocomplete() &&
			!this.isHistoryNavigationActive() &&
			this.isCursorOnLastVisualLine() &&
			this.onMoveBelowPrompt?.()
		) {
			return;
		}

		// Pass to parent for editor handling
		super.handleInput(data);
	}
}
