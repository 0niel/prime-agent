import { Box, Container, type MarkdownTheme, Text } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

export function styleSlashCommandText(text: string): string {
	const space = text.search(/\s/);
	const command = space === -1 ? text : text.slice(0, space);
	const rest = space === -1 ? "" : text.slice(space);
	return theme.fg("accent", command) + theme.fg("userMessageText", rest);
}

export class SlashCommandMessageComponent extends Container {
	constructor(text: string, _markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		const box = new Box(2, 1, (content) => theme.getUserMessageBackgroundColor()(content));
		box.addChild(new Text(styleSlashCommandText(text), 0, 0));
		this.addChild(box);
	}

	setExpanded(_expanded: boolean): void {}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
