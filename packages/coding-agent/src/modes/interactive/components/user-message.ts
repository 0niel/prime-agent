import { Box, type Component, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { parseSlashCommand } from "../../../core/slash-commands.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { isLeadingSlashCommand } from "./slash-command-message.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

class SlashCommandMarkdown implements Component {
	private readonly markdown: Markdown;
	private readonly placeholder: string;
	private readonly command: string;

	constructor(text: string, markdownTheme: MarkdownTheme) {
		const parsed = parseSlashCommand(text);
		const commandEnd = parsed ? parsed.name.length + 1 : text.length;
		this.command = text.slice(0, commandEnd);
		this.placeholder = "¤".repeat(this.command.length);
		this.markdown = new Markdown(`${this.placeholder}${text.slice(commandEnd)}`, 0, 0, markdownTheme, {
			color: (content: string) => theme.fg("userMessageText", content),
		});
	}

	render(width: number): string[] {
		let commandOffset = 0;
		return this.markdown.render(width).map((line) =>
			line.replace(/¤+/g, (placeholderChunk) => {
				const remaining = this.command.length - commandOffset;
				if (remaining <= 0) return placeholderChunk;
				const consumed = Math.min(remaining, placeholderChunk.length);
				const chunk = this.command.slice(commandOffset, commandOffset + consumed);
				commandOffset += consumed;
				return `${theme.fg("accent", chunk)}${placeholderChunk.slice(consumed)}`;
			}),
		);
	}

	invalidate(): void {
		this.markdown.invalidate();
	}
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private contentBox: Box;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		isRecognizedSlashCommand: (name: string) => boolean = () => false,
	) {
		super();
		this.contentBox = new Box(2, 1, (content: string) => theme.getUserMessageBackgroundColor()(content));
		this.contentBox.addChild(
			isLeadingSlashCommand(text, isRecognizedSlashCommand)
				? new SlashCommandMarkdown(text, markdownTheme)
				: new Markdown(text, 0, 0, markdownTheme, {
						color: (content: string) => theme.fg("userMessageText", content),
					}),
		);
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
