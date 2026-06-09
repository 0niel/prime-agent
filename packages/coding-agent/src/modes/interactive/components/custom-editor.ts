import {
	Editor,
	type EditorOptions,
	type EditorTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AppKeybinding, KeybindingsManager } from "../../../core/keybindings.js";

export interface CustomEditorOptions extends EditorOptions {
	placeholder?: string;
	placeholderColor?: (text: string) => string;
}

/**
 * Custom editor that handles app-level keybindings for coding-agent.
 */
export class CustomEditor extends Editor {
	private keybindings: KeybindingsManager;
	private defaultPromptPrefix: string;
	private readonly configuredPaddingX: number;
	private placeholder: string | undefined;
	private readonly placeholderColor: (text: string) => string;
	public actionHandlers: Map<AppKeybinding, () => void> = new Map();

	// Special handlers that can be dynamically replaced
	public onEscape?: () => void;
	public onCtrlD?: () => void;
	public onPasteImage?: () => void;
	public onMoveBelowPrompt?: () => boolean;
	public onAgentsBack?: () => boolean;
	/** Handler for extension-registered shortcuts. Returns true if handled. */
	public onExtensionShortcut?: (data: string) => boolean;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, options?: CustomEditorOptions) {
		const promptPrefix = options?.promptPrefix ?? "> ";
		super(tui, theme, { ...options, promptPrefix });
		this.keybindings = keybindings;
		this.defaultPromptPrefix = promptPrefix;
		this.configuredPaddingX = options?.paddingX ?? 0;
		this.placeholder = options?.placeholder;
		this.placeholderColor = options?.placeholderColor ?? ((text) => text);
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

	override render(width: number): string[] {
		const lines = super.render(width);
		if (!this.placeholder || this.getText().length > 0 || lines.length < 2) {
			return lines;
		}
		return [lines[0]!, this.renderPlaceholderLine(width), ...lines.slice(2)];
	}

	setPlaceholder(placeholder: string | undefined): void {
		this.placeholder = placeholder;
		this.invalidate();
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

		if (this.keybindings.matches(data, "app.agents.back") && this.onAgentsBack?.()) {
			return;
		}

		// Clear input - only if autocomplete is NOT active
		if (this.keybindings.matches(data, "app.input.clear")) {
			if (!this.isShowingAutocomplete()) {
				// Use dynamic onEscape if set, otherwise registered handler
				const handler = this.onEscape ?? this.actionHandlers.get("app.input.clear");
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
			if (action !== "app.input.clear" && action !== "app.exit" && this.keybindings.matches(data, action)) {
				if ((action === "app.clear" || action === "app.interrupt") && this.isShowingAutocomplete()) {
					this.cancelAutocomplete();
				}
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

	private renderPlaceholderLine(width: number): string {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const useBackgroundSurface = this.backgroundColor !== undefined;
		const configuredPaddingX = Math.min(this.configuredPaddingX, maxPadding);
		const paddingX = useBackgroundSurface
			? Math.min(Math.max(configuredPaddingX, 2), maxPadding)
			: configuredPaddingX;
		const contentWidth = Math.max(1, width - paddingX * 2);
		const promptPrefixText = this.getPromptPrefix();
		const promptPrefixWidth = Math.min(visibleWidth(promptPrefixText), Math.max(0, contentWidth - 1));
		const inputWidth = Math.max(1, contentWidth - promptPrefixWidth);
		const promptPrefix =
			promptPrefixWidth > 0 ? this.formatPromptPrefix(truncateToWidth(promptPrefixText, promptPrefixWidth, "")) : "";
		const promptPrefixInset = promptPrefixWidth > 0 ? Math.min(1, paddingX) : 0;
		const promptLeadingPadding = " ".repeat(promptPrefixInset);
		const promptTrailingPadding = " ".repeat(Math.max(0, paddingX - promptPrefixInset));
		const rightPadding = " ".repeat(paddingX);
		const placeholderText = truncateToWidth(this.placeholder ?? "", inputWidth, "");
		const displayText = this.placeholderColor(placeholderText);
		const padding = " ".repeat(Math.max(0, inputWidth - visibleWidth(placeholderText)));
		const line = `${promptLeadingPadding}${promptPrefix}${promptTrailingPadding}${displayText}${padding}${rightPadding}`;
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		return this.backgroundColor ? this.backgroundColor(padded) : padded;
	}
}
