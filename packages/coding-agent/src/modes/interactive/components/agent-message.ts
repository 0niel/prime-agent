import {
	Container,
	Markdown,
	type MarkdownTheme,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentSessionMessage, AgentSessionMessageDetails } from "../../../core/agent-messages.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { keyText } from "./keybinding-hints.js";

function senderLabel(details: AgentSessionMessageDetails): string {
	return (
		details.from?.sessionName?.trim() ||
		details.from?.activeSessionId?.trim() ||
		details.from?.clientId?.trim() ||
		"Unknown agent"
	);
}

function collapseText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export class AgentMessageComponent extends Container {
	private readonly content = new Container();
	private readonly header = new Text("", 1, 0);
	private expanded = false;

	constructor(
		private readonly message: AgentSessionMessage,
		private readonly markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(this.content);
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) {
			return;
		}
		this.expanded = expanded;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.content.clear();
		this.header.setText(this.headerText());
		this.content.addChild(this.header);
		if (this.expanded) {
			this.content.addChild(
				new Markdown(this.message.details.message, 1, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("customMessageText", text),
				}),
			);
		}
	}

	private headerText(): string {
		const icon = theme.fg("accent", "◆");
		const title = theme.fg("muted", "Agent message received");
		const sender = theme.fg("muted", senderLabel(this.message.details));
		const separator = theme.fg("dim", " · ");
		if (this.expanded) {
			return `${icon} ${title}${separator}${sender}`;
		}

		const prefixWidth = visibleWidth(`◆ Agent message received · ${senderLabel(this.message.details)} · `);
		const preview = truncateToWidth(collapseText(this.message.details.message), Math.max(20, 100 - prefixWidth));
		const hint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
		return `${icon} ${title}${separator}${sender}${separator}${theme.fg("muted", preview)}${hint}`;
	}
}
