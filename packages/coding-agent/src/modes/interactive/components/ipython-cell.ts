import { type Component, VersionedRenderCache, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { highlightCode, theme } from "../theme/theme.js";
import { normalizeErrorDetails, summarizeErrorDetails } from "./collapsible-error.js";
import { keyHint } from "./keybinding-hints.js";
import { toolPanelContentWidth, toolPanelLine } from "./tool-panel.js";

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
	stdout?: string;
	stderr?: string;
	result?: string;
	error?: IpythonErrorDetails;
}

interface IpythonErrorDetails {
	ename: string;
	evalue: string;
	traceback: readonly string[];
}

interface TracebackParts {
	output: string;
	traceback: string;
	preview: string;
}

type ExpandHintFormatter = (label: string) => string;

const MAGIC_LINE_PATTERN = /^\s*!/;
const CELL_MAGIC_PATTERN = /^\s*%%bash\b/;

const OUTPUT_PREVIEW_LINES = 5;
const INPUT_PREVIEW_LINES = 3;

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
	const error = readErrorDetails(record.error);
	return {
		durationMs: typeof record.durationMs === "number" ? record.durationMs : undefined,
		status: typeof record.status === "string" ? record.status : undefined,
		errorEname: error?.ename ?? (typeof record.errorEname === "string" ? record.errorEname : undefined),
		stdout: typeof record.stdout === "string" ? record.stdout : undefined,
		stderr: typeof record.stderr === "string" ? record.stderr : undefined,
		result: typeof record.result === "string" ? record.result : undefined,
		error,
	};
}

function readErrorDetails(value: unknown): IpythonErrorDetails | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.ename !== "string") {
		return undefined;
	}
	return {
		ename: record.ename,
		evalue: typeof record.evalue === "string" ? record.evalue : "",
		traceback: Array.isArray(record.traceback)
			? record.traceback.filter((line): line is string => typeof line === "string")
			: [],
	};
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

function hiddenLinesLabel(hidden: number): string {
	return `… +${hidden} line${hidden === 1 ? "" : "s"}`;
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
	const normalized = normalizeErrorDetails(text);
	if (!normalized.trim()) {
		return undefined;
	}

	const lines = normalized.split("\n");
	let tracebackIndex = lines.findIndex((line) => line.includes("Traceback (most recent call last):"));
	if (tracebackIndex < 0 && errorName) {
		tracebackIndex = lines.findIndex((line) => line.trim().startsWith(`${errorName}:`));
	}
	if (tracebackIndex < 0) {
		return undefined;
	}

	const output = lines.slice(0, tracebackIndex).join("\n").trimEnd();
	const traceback = lines.slice(tracebackIndex).join("\n").trim();
	const preview = summarizeErrorDetails(traceback);
	return { output, traceback, preview: preview === "Error" && errorName ? errorName : preview };
}

function formatIpythonErrorSummary(error: IpythonErrorDetails): string {
	const normalizedValue = normalizeErrorDetails(error.evalue);
	if (!normalizedValue.trim()) {
		return error.ename;
	}
	const value = summarizeErrorDetails(normalizedValue);
	if (value === "Error") {
		return error.ename;
	}
	return visibleWidth(value) <= 48 ? `${error.ename}: ${value}` : error.ename;
}

export class IPythonCellComponent implements Component {
	private readonly renderCache = new VersionedRenderCache();
	private state: IPythonCellState;
	private stateVersion = 0;

	constructor(state: IPythonCellState) {
		this.state = state;
	}

	update(state: IPythonCellState): void {
		this.state = state;
		this.stateVersion += 1;
	}

	invalidate(): void {
		this.renderCache.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const cached = this.renderCache.get(safeWidth, this.stateVersion);
		if (cached) {
			return cached;
		}

		const details = readDetails(this.state.details);
		const lines: string[] = [];
		let expandHintShown = false;
		const withExpandHint: ExpandHintFormatter = (label) => {
			if (expandHintShown) {
				return theme.fg("muted", label);
			}
			expandHintShown = true;
			return `${theme.fg("muted", label)} ${theme.fg("dim", "·")} ${keyHint("app.tools.expand", "to expand")}`;
		};

		lines.push(toolPanelLine(this.header(details), safeWidth));
		const hasCode = this.renderCode(lines, safeWidth, withExpandHint);
		this.renderOutput(lines, safeWidth, details, hasCode, withExpandHint);
		return this.renderCache.set(safeWidth, this.stateVersion, lines);
	}

	private header(details: IpythonDetails): string {
		// Name the cell so the status reads as part of this tool call instead of
		// a floating label between the surrounding blocks.
		const isBashCell = CELL_MAGIC_PATTERN.test(this.state.code.split("\n")[0] ?? "");
		const status = this.status(details);
		const duration = formatDuration(details.durationMs);
		const parts = [theme.fg("muted", isBashCell ? "bash" : "python"), status.label];
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

	private renderCode(lines: string[], width: number, withExpandHint: ExpandHintFormatter): boolean {
		const code = this.state.code.trimEnd();
		if (!code) {
			this.addBlank(lines, width);
			this.addWrapped(lines, "", theme.fg("muted", "waiting for code"), width);
			return false;
		}

		this.addBlank(lines, width);
		const isBashCell = CELL_MAGIC_PATTERN.test(code.split("\n")[0] ?? "");
		const rawLines = code.split("\n");
		const expanded = this.state.expanded ?? false;
		const showCollapsed = !expanded && rawLines.length > INPUT_PREVIEW_LINES;
		const visibleRawLines = showCollapsed ? rawLines.slice(0, INPUT_PREVIEW_LINES) : rawLines;
		for (const [index, rawLine] of visibleRawLines.entries()) {
			const prefix = index === 0 ? theme.fg("dim", "› ") : theme.fg("dim", "  ");
			const highlighted = this.highlightInputLine(rawLine, isBashCell);
			this.addWrapped(lines, prefix, highlighted || " ", width);
		}

		if (showCollapsed) {
			const hidden = rawLines.length - INPUT_PREVIEW_LINES;
			this.addWrapped(lines, "", withExpandHint(hiddenLinesLabel(hidden)), width);
			return true;
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

	private renderOutput(
		lines: string[],
		width: number,
		details: IpythonDetails,
		hasCode: boolean,
		withExpandHint: ExpandHintFormatter,
	): void {
		const blocks = this.state.content ?? [];
		const text = textFromBlocks(blocks);
		const imageCount = blocks.filter(isImageBlock).length;
		const hasStructuredOutput =
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined;
		const traceback =
			!hasStructuredOutput && (this.state.isError || details.status === "error")
				? splitTraceback(text, details.errorEname)
				: undefined;
		let outputStarted = false;
		let renderedTextOutput = false;

		const startOutput = (): void => {
			if (outputStarted) {
				return;
			}
			outputStarted = true;
			if (hasCode) {
				this.addBlank(lines, width);
			}
		};

		if (hasStructuredOutput) {
			if (details.stdout?.trim()) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stdout), "out", withExpandHint);
			}
			if (details.stderr?.trim()) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stderr), "err", withExpandHint);
			}
			if (details.result?.trim()) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.result), "out", withExpandHint);
			}
		} else if (traceback) {
			if (traceback.output) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, traceback.output, "out", withExpandHint);
			}
		} else if (text.trim()) {
			startOutput();
			renderedTextOutput = true;
			this.renderOutputText(
				lines,
				width,
				normalizeErrorDetails(text),
				this.state.isError ? "err" : "out",
				withExpandHint,
			);
		}

		if (!renderedTextOutput && this.state.isPartial) {
			startOutput();
			this.addWrapped(lines, "", theme.fg("muted", "waiting for output..."), width);
		} else if (!renderedTextOutput && this.state.executionStarted && !this.state.argsComplete) {
			startOutput();
			this.addWrapped(lines, "", theme.fg("muted", "waiting for output..."), width);
		} else if (
			!renderedTextOutput &&
			!traceback &&
			!details.error &&
			this.state.executionStarted &&
			imageCount === 0
		) {
			startOutput();
			this.addWrapped(lines, "", theme.fg("muted", "no output"), width);
		}

		if (details.error) {
			startOutput();
			if (this.state.expanded) {
				this.renderTraceback(
					lines,
					width,
					details.error.traceback.join("\n") || formatIpythonErrorSummary(details.error),
				);
			} else {
				this.addWrapped(lines, "", withExpandHint(formatIpythonErrorSummary(details.error)), width);
			}
		} else if (traceback) {
			startOutput();
			if (this.state.expanded) {
				this.renderTraceback(lines, width, traceback.traceback);
			} else {
				this.addWrapped(lines, "", withExpandHint(traceback.preview), width);
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

	private renderOutputText(
		lines: string[],
		width: number,
		text: string,
		label: "out" | "err",
		withExpandHint: ExpandHintFormatter,
	): void {
		const color = label === "err" ? "muted" : "toolOutput";
		const allLines = text.split("\n");
		const expanded = this.state.expanded ?? false;
		const showCollapsed = !expanded && allLines.length > OUTPUT_PREVIEW_LINES;
		const visibleLines = showCollapsed ? allLines.slice(-OUTPUT_PREVIEW_LINES) : allLines;

		if (showCollapsed) {
			const hidden = allLines.length - OUTPUT_PREVIEW_LINES;
			this.addWrapped(lines, "", withExpandHint(hiddenLinesLabel(hidden)), width);
		}

		for (const line of visibleLines) {
			this.addWrapped(lines, "", theme.fg(color, line || " "), width);
		}
	}

	private renderTraceback(lines: string[], width: number, traceback: string): void {
		for (const line of traceback.split("\n")) {
			this.addWrapped(lines, "", theme.fg("muted", line || " "), width);
		}
	}

	private addWrapped(lines: string[], prefix: string, text: string, width: number): void {
		const available = Math.max(1, toolPanelContentWidth(width) - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(text, available);
		for (const [index, line] of (wrapped.length > 0 ? wrapped : [""]).entries()) {
			const linePrefix = index === 0 ? prefix : " ".repeat(visibleWidth(prefix));
			lines.push(toolPanelLine(linePrefix + line, width));
		}
	}

	private addBlank(lines: string[], width: number): void {
		lines.push(toolPanelLine("", width));
	}
}
