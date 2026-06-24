import { isAbsolute, relative } from "node:path";
import {
	type Component,
	truncateToWidth,
	VersionedRenderCache,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { generateDiffString } from "../../../core/tools/edit-diff.js";
import { shortenPath } from "../../../core/tools/render-utils.js";
import { getLanguageFromPath, highlightCode, theme } from "../theme/theme.js";
import { getWorkingPulseFrame, WORKING_ICON_FRAMES, workingIconFrame } from "../theme/working-icon.js";
import { normalizeErrorDetails, summarizeErrorDetails } from "./collapsible-error.js";
import { renderDiffSeparator, renderRichDiff } from "./diff.js";
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
	/** Session cwd — edit paths nested under it render relative, else absolute. */
	cwd?: string;
}

interface DiffDisplay {
	path: string;
	oldStr: string;
	newStr: string;
	startLine?: number;
}

interface IpythonDetails {
	durationMs?: number;
	status?: string;
	errorEname?: string;
	stdout?: string;
	stderr?: string;
	result?: string;
	diffs?: DiffDisplay[];
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

// Cap so the trailing duration/counts stay visible on narrow widths.
const DESCRIPTOR_MAX_WIDTH = 64;

const COMMENT_LINE_PATTERN = /^\s*#/;
// Strip a leading `cd … &&` to surface the real command.
const CD_PREFIX_PATTERN = /^\s*cd\s+[^&;|]+(?:&&|;)\s*/;

const SGR_PATTERN = /\x1b\[([0-9;]*)m/g;

/**
 * Append `ESC[0m` when `line` ends with a foreground or background color still
 * open, so a span that wrapTextWithAnsi split across lines cannot bleed into the
 * trailing padding or the next line.
 */
function closeOpenSgr(line: string): string {
	let fgOpen = false;
	let bgOpen = false;
	for (const match of line.matchAll(SGR_PATTERN)) {
		const params = match[1] === "" ? ["0"] : match[1].split(";");
		for (let i = 0; i < params.length; i++) {
			const code = Number(params[i]);
			if (code === 0) {
				fgOpen = false;
				bgOpen = false;
			} else if (code === 38 || code === 48) {
				// Skip the color data of `38;5;n` / `38;2;r;g;b` so a component (e.g. 38) isn't read as a code.
				if (code === 38) fgOpen = true;
				else bgOpen = true;
				const mode = Number(params[i + 1]);
				i += mode === 2 ? 4 : mode === 5 ? 2 : 1;
			} else if (code === 39) {
				fgOpen = false;
			} else if (code === 49) {
				bgOpen = false;
			} else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
				fgOpen = true;
			} else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
				bgOpen = true;
			}
		}
	}
	return fgOpen || bgOpen ? `${line}\x1b[0m` : line;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function truncateDescriptor(text: string): string {
	if (text.length <= DESCRIPTOR_MAX_WIDTH) {
		return text;
	}
	return `${text.slice(0, DESCRIPTOR_MAX_WIDTH - 1).trimEnd()}…`;
}

/** Leading meaningful command of a cell; "" while code is still streaming. */
function summarizeCell(code: string): string {
	const lines = code.split("\n");
	const isBashCell = CELL_MAGIC_PATTERN.test(lines[0] ?? "");
	const body = isBashCell ? lines.slice(1) : lines;
	for (const rawLine of body) {
		const trimmed = rawLine.trim();
		if (!trimmed || COMMENT_LINE_PATTERN.test(trimmed)) {
			continue;
		}
		const command = trimmed.replace(MAGIC_LINE_PATTERN, "").trim();
		if (!command) {
			continue;
		}
		return truncateDescriptor(collapseWhitespace(command.replace(CD_PREFIX_PATTERN, "")));
	}
	return "";
}

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
		diffs: readDiffDisplays(record.diffs),
		error,
	};
}

function readDiffDisplays(value: unknown): DiffDisplay[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const diffs = value.flatMap((entry): DiffDisplay[] => {
		if (!entry || typeof entry !== "object") {
			return [];
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.path !== "string" || typeof record.oldStr !== "string" || typeof record.newStr !== "string") {
			return [];
		}
		return [
			{
				path: record.path,
				oldStr: record.oldStr,
				newStr: record.newStr,
				startLine: typeof record.startLine === "number" ? record.startLine : undefined,
			},
		];
	});
	return diffs.length > 0 ? diffs : undefined;
}

/** Strip one layer of repr quotes so an `execute_result` string compares cleanly. */
function stripReprQuotes(text: string): string {
	const trimmed = text.trim();
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"')))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

/** True when `text` is just the edit skill's "Edited <path>" confirmation for one of `diffs`. */
function isEditConfirmation(text: string | undefined, diffs: readonly DiffDisplay[]): boolean {
	if (!text) {
		return false;
	}
	const stripped = stripReprQuotes(text);
	return diffs.some((diff) => stripped === `Edited ${diff.path}`);
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

// Relative to the session cwd when nested under it, else the absolute path.
function displayEditPath(path: string, cwd: string | undefined): string {
	if (cwd && isAbsolute(path)) {
		const rel = relative(cwd, path);
		if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
			return rel;
		}
		return shortenPath(path);
	}
	return path;
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
		const details = readDetails(this.state.details);
		// Fold the animation frame into the cache key while running (offset within
		// a stateVersion slot so it never collides with another version).
		const frames = WORKING_ICON_FRAMES.length;
		const cacheVersion =
			this.statusKind(details) === "running"
				? this.stateVersion * frames + (getWorkingPulseFrame() % frames)
				: this.stateVersion * frames;
		const cached = this.renderCache.get(safeWidth, cacheVersion);
		if (cached) {
			return cached;
		}

		// Collapsed default: one line, indented to match message text. Cached by
		// state version so it never re-renders on unrelated repaints (would flicker).
		// Edits are the exception: the diff always shows in full under the summary
		// line so file changes are visible without expanding.
		if (!this.state.expanded) {
			const summary = truncateToWidth(` ${this.collapsedLine(details)}`, safeWidth, "");
			if ((details.diffs?.length ?? 0) === 0) {
				return this.renderCache.set(safeWidth, cacheVersion, [summary]);
			}
			const lines = [summary];
			this.renderDiffs(lines, safeWidth, details.diffs ?? [], this.marker(details));
			return this.renderCache.set(safeWidth, cacheVersion, lines);
		}

		const lines: string[] = [];
		let expandHintShown = false;
		const withExpandHint: ExpandHintFormatter = (label) => {
			if (expandHintShown) {
				return theme.fg("muted", label);
			}
			expandHintShown = true;
			return `${theme.fg("muted", label)} ${theme.fg("dim", "·")} ${keyHint("app.tools.expand", "to expand")}`;
		};

		const hasDiffs = (details.diffs?.length ?? 0) > 0;
		lines.push(toolPanelLine(this.header(details), safeWidth));
		const hasCode = this.renderCode(lines, safeWidth, withExpandHint, hasDiffs);
		this.renderOutput(lines, safeWidth, details, hasCode, withExpandHint);
		return this.renderCache.set(safeWidth, cacheVersion, lines);
	}

	// Command is bash-only: python first-lines are usually imports/setup, not intent.
	private collapsedLine(details: IpythonDetails): string {
		const code = this.state.code.trimEnd();
		const isBashCell = CELL_MAGIC_PATTERN.test(code.split("\n")[0] ?? "");
		const parts = [`${this.marker(details)} ${theme.fg("muted", isBashCell ? "bash" : "python")}`];

		if (isBashCell) {
			const command = summarizeCell(code);
			if (command) {
				parts.push(this.highlightInputLine(command, true));
			} else if (!this.state.executionStarted) {
				parts.push(theme.fg("muted", "waiting for code"));
			}
		}

		const counts = this.lineCounts(details);
		if (counts) {
			parts.push(theme.fg("muted", counts));
		}

		const duration = formatDuration(details.durationMs);
		if (duration) {
			parts.push(theme.fg("muted", duration));
		}

		const errorName = !this.state.isPartial ? (details.error?.ename ?? details.errorEname) : undefined;
		if (errorName) {
			parts.push(theme.fg("error", errorName));
		}

		parts.push(keyHint("app.tools.expand", "to expand"));
		return parts.join(theme.fg("dim", " · "));
	}

	/** Status marker — color carries running/done/error; ✓/✗ once finished. */
	private marker(details: IpythonDetails): string {
		switch (this.statusKind(details)) {
			case "error":
				return theme.fg("error", "✗");
			case "aborted":
				return theme.fg("warning", "✗");
			case "done":
				return theme.fg("success", "✓");
			case "running":
				return theme.fg("bashMode", workingIconFrame(getWorkingPulseFrame()));
			default: // queued
				return theme.fg("muted", "▸");
		}
	}

	// `↑in ↓out lines` — the "lines" unit disambiguates from the token counts on
	// the activity line. Output is omitted for edits (the diff shows on expand).
	private lineCounts(details: IpythonDetails): string | undefined {
		const codeLines = this.state.code.split("\n");
		const isBashCell = CELL_MAGIC_PATTERN.test(codeLines[0] ?? "");
		const body = isBashCell ? codeLines.slice(1) : codeLines;
		const input = body.filter((line) => line.trim().length > 0).length;

		const hasDiffs = (details.diffs?.length ?? 0) > 0;
		const structured = [details.stdout, details.stderr, details.result]
			.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
			.join("\n");
		const outputText = (structured || textFromBlocks(this.state.content)).trim();
		const output = hasDiffs || !outputText ? 0 : outputText.split("\n").length;

		const segments: string[] = [];
		if (input > 0) {
			segments.push(`↑ ${input}`);
		}
		if (output > 0) {
			segments.push(`↓ ${output}`);
		}
		return segments.length > 0 ? `${segments.join(" ")} lines` : undefined;
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

	private statusKind(details: IpythonDetails): "error" | "aborted" | "running" | "queued" | "done" {
		const status = details.status;
		if (this.state.isError || status === "error") {
			return "error";
		}
		if (status === "aborted") {
			return "aborted";
		}
		// Keyed off the result, not executionStarted, so calls rehydrated from a
		// past session (which never saw the live start) render done, not running.
		if (!this.state.isPartial && (status !== undefined || this.state.executionStarted || this.hasResult(details))) {
			return "done";
		}
		if (this.state.isPartial || this.state.executionStarted) {
			return "running";
		}
		return "queued";
	}

	private hasResult(details: IpythonDetails): boolean {
		return (
			details.stdout !== undefined ||
			details.stderr !== undefined ||
			details.result !== undefined ||
			details.error !== undefined ||
			(details.diffs?.length ?? 0) > 0 ||
			(this.state.content?.length ?? 0) > 0
		);
	}

	private status(details: IpythonDetails): { label: string } {
		switch (this.statusKind(details)) {
			case "error":
				return { label: theme.fg("error", "error") };
			case "aborted":
				return { label: theme.fg("warning", "aborted") };
			case "running":
				return { label: theme.fg("bashMode", "running") };
			case "queued":
				return { label: theme.fg("muted", "queued") };
			default:
				return { label: theme.fg("success", "done") };
		}
	}

	private renderCode(lines: string[], width: number, withExpandHint: ExpandHintFormatter, hasDiffs: boolean): boolean {
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

		// With a diff to show below, collapse the (often large) edit source to one bar.
		if (hasDiffs && !expanded) {
			const label = `${rawLines.length} line${rawLines.length === 1 ? "" : "s"} of source`;
			this.addWrapped(lines, theme.fg("dim", "› "), withExpandHint(label), width);
			return true;
		}

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

		const diffs = details.diffs ?? [];

		const startOutput = (): void => {
			if (outputStarted) {
				return;
			}
			outputStarted = true;
			if (hasCode) {
				this.addBlank(lines, width);
			}
		};

		if (diffs.length > 0) {
			// renderDiffs adds its own leading blank, so skip startOutput's to avoid
			// a double gap; mark output started for the trailing text below.
			outputStarted = true;
			this.renderDiffs(lines, width, diffs, this.marker(details));
			renderedTextOutput = true;
		}

		if (hasStructuredOutput) {
			if (details.stdout?.trim() && !isEditConfirmation(details.stdout, diffs)) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stdout), "out", withExpandHint);
			}
			if (details.stderr?.trim()) {
				startOutput();
				renderedTextOutput = true;
				this.renderOutputText(lines, width, normalizeErrorDetails(details.stderr), "err", withExpandHint);
			}
			if (details.result?.trim() && !isEditConfirmation(details.result, diffs)) {
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

	// Edits always render in full, regardless of expand state. Grouped by file.
	private renderDiffs(lines: string[], width: number, diffs: readonly DiffDisplay[], marker: string): void {
		const diffsByPath = new Map<string, DiffDisplay[]>();
		for (const diff of diffs) {
			const existing = diffsByPath.get(diff.path);
			if (existing) existing.push(diff);
			else diffsByPath.set(diff.path, [diff]);
		}
		for (const [path, edits] of diffsByPath) {
			this.addPlain(lines, "");
			this.renderFileDiff(lines, width, path, edits, marker);
		}
	}

	private renderFileDiff(
		lines: string[],
		width: number,
		path: string,
		edits: readonly DiffDisplay[],
		marker: string,
	): void {
		const language = getLanguageFromPath(path);
		let added = 0;
		let removed = 0;
		const rows: string[] = [];
		edits.forEach((edit, index) => {
			const { diff: diffText } = generateDiffString(edit.oldStr, edit.newStr, 4, edit.startLine ?? 1);
			for (const row of diffText.split("\n")) {
				if (row.startsWith("+")) added++;
				else if (row.startsWith("-")) removed++;
			}
			if (index > 0) {
				rows.push(renderDiffSeparator(width));
			}
			// Append, not spread: a huge edit's diff can exceed the JS arg-count limit.
			for (const row of renderRichDiff(diffText, width, { language })) {
				rows.push(row);
			}
		});

		const counts = `${theme.fg("toolDiffAdded", `+${added}`)} ${theme.fg("toolDiffRemoved", `-${removed}`)}`;
		const displayPath = displayEditPath(path, this.state.cwd);
		// Truncate the path (not the counts) so it can't push the header past width.
		const fixed = visibleWidth(marker) + 1 + 2 + visibleWidth(counts);
		const shownPath = truncateToWidth(displayPath, Math.max(1, width - 1 - fixed), "…");
		this.addPlain(lines, `${marker} ${shownPath}  ${counts}`);

		for (const row of rows) {
			lines.push(row);
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
			lines.push(toolPanelLine(linePrefix + closeOpenSgr(line), width));
		}
	}

	private addBlank(lines: string[], width: number): void {
		lines.push(toolPanelLine("", width));
	}

	// No-background line, indented one space to align with the summary line above.
	private addPlain(lines: string[], text: string): void {
		lines.push(` ${text}`);
	}
}
