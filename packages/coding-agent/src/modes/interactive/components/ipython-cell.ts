import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { highlightCode, theme } from "../theme/theme.js";
import { keyHint } from "./keybinding-hints.js";

export interface IPythonCellContentBlock {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

export interface IPythonCellState {
	code: string;
	content?: readonly IPythonCellContentBlock[];
	details?: unknown;
	isPartial?: boolean;
	isError?: boolean;
	expanded?: boolean;
	executionStarted?: boolean;
	argsComplete?: boolean;
	showImages?: boolean;
}

interface IpythonDetails {
	durationMs?: number;
	status?: string;
	errorEname?: string;
}

interface TracebackParts {
	output: string;
	traceback: string;
	preview: string;
}

type CellBackground = "customMessageBg" | "toolPendingBg" | "toolErrorBg";

const MAGIC_LINE_PATTERN = /^\s*!/;
const CELL_MAGIC_PATTERN = /^\s*%%bash\b/;

// Collapse long kernel output to the last N lines with a "M earlier lines hidden" marker.
// Mirrors the bash-execution preview cap so a long-running task doesn't flood the chat.
const OUTPUT_PREVIEW_LINES = 20;

export function getIpythonCodeFromArgs(args: unknown): string {
	if (!args || typeof args !== "object" || !("code" in args)) {
		return "";
	}
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : "";
}

function readDetails(details: unknown): IpythonDetails {
	if (!details || typeof details !== "object") {
		return {};
	}
	const record = details as Record<string, unknown>;
	return {
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		status: typeof record.status === "string" ? record.status : undefined,
		errorEname: typeof record.errorEname === "string" ? record.errorEname : undefined,
	};
}

function normalizeText(text: string): string {
	return stripAnsi(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function formatDuration(durationMs: number | undefined): string | undefined {
	if (durationMs === undefined) {
		return undefined;
	}
	if (durationMs < 1000) {
		return `${Math.round(durationMs)}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function isImageBlock(block: IPythonCellContentBlock): boolean {
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

function textFromBlocks(blocks: readonly IPythonCellContentBlock[] | undefined): string {
	if (!blocks) {
		return "";
	}
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

function splitTraceback(text: string, errorName: string | undefined): TracebackParts | undefined {
	const normalized = normalizeText(text);
	if (!normalized.trim()) {
		return undefined;
	}

	const lines = normalized.split("\n");
	let tracebackIndex = lines.findIndex((line) => line.includes("Traceback (most recent call last):"));
	if (tracebackIndex < 0 && errorName) {
		tracebackIndex = lines.findIndex((line) => line.trim().startsWith(`${errorName}:`));
	}
	if (tracebackIndex < 0) {
		tracebackIndex = lines.findIndex((line) =>
			/^[A-Za-z_][\w.]*?(Error|Exception|Interrupt|Exit)\b/.test(line.trim()),
		);
	}
	if (tracebackIndex < 0) {
		return undefined;
	}

	const output = lines.slice(0, tracebackIndex).join("\n").trimEnd();
	const traceback = lines.slice(tracebackIndex).join("\n").trim();
	const preview =
		traceback
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.at(-1) ??
		errorName ??
		"error";
	return { output, traceback, preview };
}

export class IPythonCellComponent implements Component {
	private readonly paddingX = 2;
	private state: IPythonCellState;

	constructor(state: IPythonCellState) {
		this.state = state;
	}

	update(state: IPythonCellState): void {
		this.state = state;
	}

	invalidate(): void {
		// Render output depends only on current state and width.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const details = readDetails(this.state.details);
		const lines: string[] = [];

		lines.push(this.panelLine(this.header(details), safeWidth));
		const hasCode = this.renderCode(lines, safeWidth);
		this.renderOutput(lines, safeWidth, details, hasCode);
		return lines;
	}

	private header(details: IpythonDetails): string {
		const status = this.status(details);
		const duration = formatDuration(details.durationMs);
		const parts = [status.label];
		if (duration) {
			parts.push(theme.fg("muted", duration));
		}
		return parts.join(theme.fg("dim", " · "));
	}

	private status(details: IpythonDetails): { label: string } {
		const status = details.status;
		if (this.state.isError || status === "error") {
			return { label: theme.fg("error", "error") };
		}
		if (status === "aborted") {
			return { label: theme.fg("warning", "aborted") };
		}
		if (this.state.isPartial || (this.state.executionStarted && !status)) {
			return { label: theme.fg("bashMode", "running") };
		}
		if (!this.state.executionStarted) {
			return { label: theme.fg("muted", "queued") };
		}
		return { label: theme.fg("success", "done") };
	}

	private renderCode(lines: string[], width: number): boolean {
		const code = this.state.code.trimEnd();
		if (!code) {
			this.addBlank(lines, width);
			this.addWrapped(lines, "", theme.fg("muted", "waiting for code"), width);
			return false;
		}

		this.addBlank(lines, width);
		const isBashCell = CELL_MAGIC_PATTERN.test(code.split("\n")[0] ?? "");
		const rawLines = code.split("\n");
		for (const [index, rawLine] of rawLines.entries()) {
			const prefix = index === 0 ? theme.fg("dim", "› ") : theme.fg("dim", "  ");
			const highlighted = this.highlightInputLine(rawLine, isBashCell);
			this.addWrapped(lines, prefix, highlighted || " ", width);
		}
		return true;
	}

	private highlightInputLine(line: string, isBashCell: boolean): string {
		if (isBashCell || MAGIC_LINE_PATTERN.test(line) || CELL_MAGIC_PATTERN.test(line)) {
			return theme.fg("bashMode", line);
		}
		const highlighted = highlightCode(line, "python");
		return highlighted[0] ?? theme.fg("mdCodeBlock", line);
	}

	private renderOutput(lines: string[], width: number, details: IpythonDetails, hasCode: boolean): void {
		const blocks = this.state.content ?? [];
		const text = textFromBlocks(blocks);
		const imageCount = blocks.filter(isImageBlock).length;
		const traceback =
			this.state.isError || details.status === "error" ? splitTraceback(text, details.errorEname) : undefined;
		let outputStarted = false;

		const startOutput = (): void => {
			if (outputStarted) {
				return;
			}
			outputStarted = true;
			if (hasCode) {
				this.addBlank(lines, width);
			}
		};

		if (traceback?.output) {
			startOutput();
			this.renderOutputText(lines, width, traceback.output, "out");
		} else if (text.trim()) {
			startOutput();
			this.renderOutputText(lines, width, normalizeText(text), this.state.isError ? "err" : "out");
		} else if (this.state.isPartial || (this.state.executionStarted && !this.state.argsComplete)) {
			startOutput();
			this.addWrapped(lines, "", theme.fg("muted", "waiting for output..."), width);
		} else if (this.state.executionStarted && imageCount === 0) {
			startOutput();
			this.addWrapped(lines, "", theme.fg("muted", "no output"), width);
		}

		if (traceback) {
			startOutput();
			if (this.state.expanded) {
				this.renderTraceback(lines, width, traceback.traceback);
			} else {
				this.addWrapped(lines, "", theme.fg("error", traceback.preview), width);
				this.addWrapped(
					lines,
					"",
					`${theme.fg("muted", "traceback collapsed")} ${theme.fg("dim", "·")} ${keyHint("app.tools.expand", "to expand")}`,
					width,
				);
			}
		}

		if (imageCount > 0) {
			startOutput();
			const text = this.state.showImages
				? `${imageCount} image${imageCount === 1 ? "" : "s"} rendered below`
				: `${imageCount} image${imageCount === 1 ? "" : "s"} hidden`;
			this.addWrapped(lines, "", theme.fg("muted", text), width);
		}
	}

	private renderOutputText(lines: string[], width: number, text: string, label: "out" | "err"): void {
		const color = label === "err" ? "error" : "toolOutput";
		const allLines = text.split("\n");
		const expanded = this.state.expanded ?? false;
		const showCollapsed = !expanded && allLines.length > OUTPUT_PREVIEW_LINES;
		const visibleLines = showCollapsed ? allLines.slice(-OUTPUT_PREVIEW_LINES) : allLines;

		if (showCollapsed) {
			const hidden = allLines.length - OUTPUT_PREVIEW_LINES;
			const headerHint = `${theme.fg("muted", `${hidden} earlier line${hidden === 1 ? "" : "s"} hidden`)} ${theme.fg("dim", "·")} ${keyHint("app.tools.expand", "to expand")}`;
			this.addWrapped(lines, "", headerHint, width);
		}

		for (const line of visibleLines) {
			this.addWrapped(lines, "", theme.fg(color, line || " "), width);
		}
	}

	private renderTraceback(lines: string[], width: number, traceback: string): void {
		for (const line of traceback.split("\n")) {
			this.addWrapped(lines, "", theme.fg("error", line || " "), width);
		}
	}

	private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const available = Math.max(1, contentWidth - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			lines.push(this.panelLine(linePrefix + line, width));
		}
	}

	private addBlank(lines: string[], width: number): void {
		lines.push(this.panelLine("", width));
	}

	private panelLine(line: string, width: number): string {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const truncated = truncateToWidth(line, contentWidth, "");
		const paddedContent = truncated + " ".repeat(Math.max(0, contentWidth - visibleWidth(truncated)));
		const padded = `${" ".repeat(this.paddingX)}${paddedContent}${" ".repeat(this.paddingX)}`;
		return theme.bg(this.background(), padded);
	}

	private background(): CellBackground {
		if (this.state.isError || readDetails(this.state.details).status === "error") {
			return "toolErrorBg";
		}
		if (this.state.isPartial || !this.state.executionStarted) {
			return "toolPendingBg";
		}
		return "customMessageBg";
	}
}
