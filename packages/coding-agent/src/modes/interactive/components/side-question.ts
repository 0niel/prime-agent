import { type Component, Markdown, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConnectionSideQuestionEvent } from "../../agent-connection/types.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";

export class SideQuestionComponent implements Component {
	private readonly paddingX: number;
	private readonly answer: Markdown;
	private event: AgentConnectionSideQuestionEvent;

	constructor(
		event: AgentConnectionSideQuestionEvent,
		private readonly getMaxLines: () => number,
		paddingX = 2,
	) {
		this.event = event;
		this.paddingX = Math.max(2, paddingX);
		this.answer = new Markdown("", this.paddingX, 0, getMarkdownTheme(), {
			color: (content: string) => theme.fg("userMessageText", content),
		});
		this.answer.setText(event.answer);
	}

	update(event: AgentConnectionSideQuestionEvent): void {
		this.event = event;
		this.answer.setText(event.answer);
	}

	invalidate(): void {
		this.answer.invalidate();
	}

	render(width: number): string[] {
		const blank = " ".repeat(Math.max(1, width));
		const question = new Text(
			`${theme.fg("accent", "/btw")}  ${theme.bold(theme.fg("userMessageText", this.event.question))}`,
			this.paddingX,
			0,
		).render(width);
		const lines = [blank, ...question, blank, ...this.renderAnswer(width), blank];
		const maxLines = Math.max(6, this.getMaxLines());
		if (lines.length <= maxLines) {
			return lines.map((line) => this.applySurface(line, width));
		}
		const ellipsis = new Text(theme.fg("dim", "…"), this.paddingX, 0).render(width)[0] ?? blank;
		return [...lines.slice(0, maxLines - 1), ellipsis].map((line) => this.applySurface(line, width));
	}

	private renderAnswer(width: number): string[] {
		if (this.event.answer) {
			return this.answer.render(width);
		}
		if (this.event.errorMessage) {
			return new Text(theme.fg("error", this.event.errorMessage), this.paddingX, 0).render(width);
		}
		if (this.event.status === "cancelled") {
			return new Text(theme.fg("userMessageText", "Cancelled"), this.paddingX, 0).render(width);
		}
		const message = this.event.status === "complete" ? "No response" : "Thinking…";
		return new Text(theme.fg("userMessageText", message), this.paddingX, 0).render(width);
	}

	private applySurface(line: string, width: number): string {
		const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
		const background = theme.getUserMessageBackgroundColor();
		return padded
			.split("\x1b[0m")
			.map((segment) => background(segment))
			.join("\x1b[0m");
	}
}
