import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PRIME_BUTTERFLY_LOGO } from "../../../themes/prime-logo.js";
import { type ThemeColor, theme } from "../theme/theme.js";

interface PrimeOnboardingSplashOptions {
	getRows?: () => number;
	requestRender?: () => void;
	animationIntervalMs?: number;
}

const LOGO_LINES = PRIME_BUTTERFLY_LOGO.split("\n");
const LOGO_WIDTH = LOGO_LINES.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
const TITLE = "prime agent";
const SUBTITLE = "Research and infrastructure assistant for high-context work.";
const PANEL_GAP = 6;
const ANIMATION_INTERVAL_MS = 900;
const STAR_DENSITY = 91;

type SplashTone = Extract<ThemeColor, "accent" | "borderMuted" | "dim" | "mdLink" | "muted" | "text" | "warning">;

interface SplashCell {
	char: string;
	tone: SplashTone;
	priority: number;
	bold?: boolean;
}

interface TracePoint {
	x: number;
	y: number;
	tone: SplashTone;
}

interface StyledText {
	text: string;
	tone: SplashTone;
	bold?: boolean;
	transparentSpaces?: boolean;
}

type PanelTextLine = StyledText[];

interface PanelLine {
	left: number;
	parts: PanelTextLine;
}

interface QuietZone {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

export class PrimeOnboardingSplashComponent implements Component {
	private frame = 0;
	private animationInterval?: ReturnType<typeof setInterval>;

	constructor(
		private readonly onSelect: () => void,
		private readonly onCancel: () => void,
		private readonly options: PrimeOnboardingSplashOptions = {},
	) {
		if (options.requestRender) {
			this.animationInterval = setInterval(() => {
				this.frame++;
				options.requestRender?.();
			}, options.animationIntervalMs ?? ANIMATION_INTERVAL_MS);
		}
	}

	invalidate(): void {
		// Render output is derived from current theme.
	}

	dispose(): void {
		if (!this.animationInterval) {
			return;
		}
		clearInterval(this.animationInterval);
		this.animationInterval = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const panelLines = this.renderPanel(safeWidth);
		const targetRows = this.getTargetRows(panelLines.length);
		const topPadding = Math.max(0, Math.floor((targetRows - panelLines.length) / 2));
		const quietZone = this.panelQuietZone(panelLines, topPadding, safeWidth, targetRows);
		const canvas = this.renderBackdrop(safeWidth, targetRows, quietZone);
		panelLines.forEach((line, index) => {
			this.drawStyledText(canvas, line.left, topPadding + index, line.parts, 8);
		});
		return canvas.map((line) => this.renderCells(line));
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm")) {
			this.onSelect();
			return;
		}
		if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancel();
		}
	}

	private formatContinueHint(): PanelTextLine {
		return [
			{ text: "Press ", tone: "muted" },
			{ text: "Enter", tone: "accent", bold: true },
			{ text: " to login with Prime Intellect", tone: "muted" },
		];
	}

	private renderPanel(width: number): PanelLine[] {
		const textLines = this.renderTextLines();
		const textWidth = textLines.reduce((max, line) => Math.max(max, this.visiblePartsWidth(line)), 0);
		const horizontalWidth = LOGO_WIDTH + PANEL_GAP + textWidth;
		const left = Math.max(0, Math.floor((width - Math.min(width, horizontalWidth)) / 2));
		const lines: PanelLine[] = [];

		if (horizontalWidth <= width) {
			const lockupHeight = Math.max(LOGO_LINES.length, textLines.length);
			const logoTopPadding = Math.max(0, Math.floor((lockupHeight - LOGO_LINES.length) / 2));
			const textTopPadding = Math.max(0, Math.floor((lockupHeight - textLines.length) / 2));
			for (let index = 0; index < lockupHeight; index++) {
				const logoLine = LOGO_LINES[index - logoTopPadding] ?? "";
				const textLine = textLines[index - textTopPadding] ?? [];
				lines.push({ left, parts: this.renderLockupLine(logoLine, textLine) });
			}
		} else {
			for (const line of this.renderLogoBlock(width)) {
				lines.push(this.centerParts(line, width));
			}
			lines.push({ left: 0, parts: [] });
			for (const line of textLines) {
				lines.push(this.centerParts(line, width));
			}
		}

		return lines;
	}

	private renderTextLines(): PanelTextLine[] {
		return [
			[{ text: TITLE, tone: "text", bold: true }],
			[{ text: SUBTITLE, tone: "muted" }],
			[],
			this.formatBullet("Inspect logs, evals, training runs, and environments."),
			this.formatBullet("Keep context alive in Python state and artifacts."),
			this.formatBullet("Delegate focused work through recursive RLM calls."),
			[],
			this.formatContinueHint(),
		];
	}

	private formatBullet(text: string): PanelTextLine {
		return [
			{ text: "• ", tone: "muted" },
			{ text, tone: "muted" },
		];
	}

	private renderLockupLine(logoLine: string, textLine: PanelTextLine): PanelTextLine {
		const paddedLogo = logoLine + " ".repeat(Math.max(0, LOGO_WIDTH - visibleWidth(logoLine)));
		return [
			{ text: paddedLogo, tone: "text", transparentSpaces: true },
			{ text: " ".repeat(PANEL_GAP), tone: "dim", transparentSpaces: true },
			...textLine,
		];
	}

	private renderLogoBlock(width: number): PanelTextLine[] {
		const logoWidth = Math.min(LOGO_WIDTH, width);
		return LOGO_LINES.map((line) => {
			const paddedLine = line + " ".repeat(Math.max(0, LOGO_WIDTH - visibleWidth(line)));
			return [{ text: truncateToWidth(paddedLine, logoWidth, ""), tone: "text", transparentSpaces: true }];
		});
	}

	private renderBackdrop(width: number, rows: number, quietZone: QuietZone | undefined): SplashCell[][] {
		const canvas = Array.from({ length: rows }, () =>
			Array.from({ length: width }, (): SplashCell => ({ char: " ", tone: "dim", priority: 0 })),
		);

		this.drawStarfield(canvas, width, rows);
		this.drawContourField(canvas, width, rows, quietZone);
		this.drawMetricTraces(canvas, width, rows, quietZone);
		this.drawPulseMarkers(canvas, width, rows, quietZone);

		return canvas;
	}

	private drawStarfield(canvas: SplashCell[][], width: number, rows: number): void {
		for (let y = 0; y < rows; y++) {
			for (let x = 0; x < width; x++) {
				const value = this.hash(x, y);
				if (value % STAR_DENSITY !== 0) {
					continue;
				}
				const tone = value % 7 === 0 ? "muted" : "dim";
				this.put(canvas, x, y, "·", tone, 1);
			}
		}
	}

	private drawContourField(
		canvas: SplashCell[][],
		width: number,
		rows: number,
		quietZone: QuietZone | undefined,
	): void {
		if (width < 72 || rows < 18) {
			return;
		}
		const centerX = width * 0.35;
		const centerY = rows * 0.55;
		const maxX = Math.floor(width * 0.82);
		for (let y = 1; y < rows - 1; y++) {
			for (let x = 2; x < maxX; x++) {
				const radius = Math.hypot((x - centerX) / 13, (y - centerY) / 3.5);
				const wave = radius * 2.65 + Math.sin(x * 0.075) * 0.32;
				if (Math.abs((wave % 1) - 0.5) > 0.016) {
					continue;
				}
				if (this.isInsideQuietZone(x, y, quietZone)) {
					continue;
				}
				const char = (x + y) % 6 === 0 ? "╌" : "·";
				this.put(canvas, x, y, char, "borderMuted", 2);
			}
		}
	}

	private drawMetricTraces(
		canvas: SplashCell[][],
		width: number,
		rows: number,
		quietZone: QuietZone | undefined,
	): void {
		if (width < 48 || rows < 12) {
			return;
		}
		for (const trace of this.metricTraces(width, rows, quietZone)) {
			for (let index = 0; index < trace.length; index++) {
				const point = trace[index];
				if (!point || point.x % 2 !== 0) {
					continue;
				}
				if (this.isInsideQuietZone(point.x, point.y, quietZone)) {
					continue;
				}
				const char = index % 19 === 0 ? "•" : "·";
				this.put(canvas, point.x, point.y, char, point.tone, 3);
			}
		}
	}

	private drawPulseMarkers(
		canvas: SplashCell[][],
		width: number,
		rows: number,
		quietZone: QuietZone | undefined,
	): void {
		const traces = this.metricTraces(width, rows, quietZone);
		for (let traceIndex = 0; traceIndex < traces.length; traceIndex++) {
			const trace = traces[traceIndex];
			if (!trace || trace.length === 0) {
				continue;
			}
			const offset = traceIndex * Math.floor(trace.length / 3);
			const point = trace[(this.frame + offset) % trace.length];
			if (!point) {
				continue;
			}
			if (this.isInsideQuietZone(point.x, point.y, quietZone)) {
				continue;
			}
			const tone: SplashTone = traceIndex === 1 ? "warning" : "accent";
			this.put(canvas, point.x, point.y, "•", tone, 5);
		}
	}

	private metricTraces(width: number, rows: number, quietZone: QuietZone | undefined): TracePoint[][] {
		if (width < 48 || rows < 12) {
			return [];
		}
		const left = Math.max(3, Math.floor(width * 0.04));
		const right = Math.max(left + 1, width - Math.max(4, Math.floor(width * 0.04)));
		const span = Math.max(1, right - left);
		const traces: TracePoint[][] = [[], [], []];

		for (let x = left; x < right; x++) {
			const t = (x - left) / span;
			const loss = 0.18 + 0.34 * (1 - Math.exp(-t * 3.1)) + Math.sin(t * Math.PI * 7) * 0.018;
			const reward = 0.72 - 0.3 * (1 - Math.exp(-t * 2.4)) + Math.cos(t * Math.PI * 5) * 0.016;
			const horizon = 0.58 + Math.sin(t * Math.PI * 3.2) * 0.035 + Math.sin(t * Math.PI * 13) * 0.01;
			traces[0]?.push({ x, y: this.routedTraceY(this.traceY(loss, rows), x, 0, rows, quietZone), tone: "mdLink" });
			traces[1]?.push({
				x,
				y: this.routedTraceY(this.traceY(reward, rows), x, 1, rows, quietZone),
				tone: "accent",
			});
			traces[2]?.push({
				x,
				y: this.routedTraceY(this.traceY(horizon, rows), x, 2, rows, quietZone),
				tone: "borderMuted",
			});
		}

		return traces;
	}

	private routedTraceY(
		baseY: number,
		x: number,
		traceIndex: number,
		rows: number,
		quietZone: QuietZone | undefined,
	): number {
		if (!quietZone) {
			return baseY;
		}
		const horizontalFade = 18;
		const start = quietZone.left - horizontalFade;
		const end = quietZone.right + horizontalFade;
		if (x < start || x > end) {
			return baseY;
		}
		const blend =
			x < quietZone.left
				? this.smoothStep((x - start) / horizontalFade)
				: x > quietZone.right
					? this.smoothStep((end - x) / horizontalFade)
					: 1;
		const routeProgress = (x - start) / Math.max(1, end - start);
		const baseAmplitude = Math.max(2, Math.min(5, rows * 0.075));
		const arch = Math.sin(routeProgress * Math.PI);
		const ripple =
			Math.sin(routeProgress * Math.PI * 2.4 + traceIndex * 1.1) * Math.max(1, Math.min(2, rows * 0.022));
		const clearance = traceIndex === 2 ? 1 : 2;
		const targetY =
			traceIndex === 1
				? Math.min(rows - 1, quietZone.bottom + clearance + arch * baseAmplitude * 1.25 + ripple)
				: Math.max(0, quietZone.top - clearance - arch * baseAmplitude * (traceIndex === 2 ? 0.45 : 0.7) + ripple);
		return Math.round(baseY * (1 - blend) + targetY * blend);
	}

	private traceY(normalized: number, rows: number): number {
		const y = Math.round(normalized * Math.max(1, rows - 1));
		return Math.max(0, Math.min(rows - 1, y));
	}

	private smoothStep(value: number): number {
		const clamped = Math.max(0, Math.min(1, value));
		return clamped * clamped * (3 - 2 * clamped);
	}

	private isInsideQuietZone(x: number, y: number, quietZone: QuietZone | undefined): boolean {
		return (
			quietZone !== undefined &&
			x >= quietZone.left &&
			x <= quietZone.right &&
			y >= quietZone.top &&
			y <= quietZone.bottom
		);
	}

	private drawStyledText(
		canvas: SplashCell[][],
		left: number,
		y: number,
		parts: PanelTextLine,
		priority: number,
	): void {
		let x = left;
		for (const part of parts) {
			for (const char of part.text) {
				const width = Math.max(0, visibleWidth(char));
				if (char !== " " || !part.transparentSpaces) {
					this.put(canvas, x, y, char, part.tone, priority, part.bold);
				}
				x += Math.max(1, width);
			}
		}
	}

	private put(
		canvas: SplashCell[][],
		x: number,
		y: number,
		char: string,
		tone: SplashTone,
		priority: number,
		bold = false,
	): void {
		if (y < 0 || y >= canvas.length) return;
		const row = canvas[y];
		if (!row || x < 0 || x >= row.length) return;
		if (row[x] && row[x].priority > priority) return;
		row[x] = { char, tone, priority, bold };
	}

	private renderCells(cells: SplashCell[]): string {
		let rendered = "";
		let currentTone: SplashTone | undefined;
		let currentBold = false;
		let segment = "";

		const flush = () => {
			if (!segment || !currentTone) return;
			const colored = theme.fg(currentTone, segment);
			rendered += currentBold ? theme.bold(colored) : colored;
			segment = "";
		};

		for (const cell of cells) {
			const bold = cell.bold === true;
			if (cell.tone !== currentTone || bold !== currentBold) {
				flush();
				currentTone = cell.tone;
				currentBold = bold;
			}
			segment += cell.char;
		}
		flush();
		return rendered;
	}

	private hash(x: number, y: number): number {
		let value = x * 374761393 + y * 668265263;
		value = (value ^ (value >> 13)) * 1274126177;
		return Math.abs(value ^ (value >> 16));
	}

	private visiblePartsWidth(parts: PanelTextLine): number {
		return parts.reduce((sum, part) => sum + visibleWidth(part.text), 0);
	}

	private panelQuietZone(
		panelLines: PanelLine[],
		topPadding: number,
		width: number,
		rows: number,
	): QuietZone | undefined {
		let left = Number.POSITIVE_INFINITY;
		let right = Number.NEGATIVE_INFINITY;
		let top = Number.POSITIVE_INFINITY;
		let bottom = Number.NEGATIVE_INFINITY;

		for (let rowIndex = 0; rowIndex < panelLines.length; rowIndex++) {
			const line = panelLines[rowIndex];
			if (!line) {
				continue;
			}
			let x = line.left;
			for (const part of line.parts) {
				for (const char of part.text) {
					const charWidth = Math.max(1, visibleWidth(char));
					if (char !== " " || !part.transparentSpaces) {
						left = Math.min(left, x);
						right = Math.max(right, x + charWidth - 1);
						top = Math.min(top, topPadding + rowIndex);
						bottom = Math.max(bottom, topPadding + rowIndex);
					}
					x += charWidth;
				}
			}
		}

		if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(top) || !Number.isFinite(bottom)) {
			return undefined;
		}

		return {
			left: Math.max(0, Math.floor(left) - 4),
			right: Math.min(width - 1, Math.ceil(right) + 4),
			top: Math.max(0, Math.floor(top) - 2),
			bottom: Math.min(rows - 1, Math.ceil(bottom) + 2),
		};
	}

	private centerParts(parts: PanelTextLine, width: number): PanelLine {
		const left = Math.max(0, Math.floor((width - this.visiblePartsWidth(parts)) / 2));
		return { left, parts };
	}

	private getTargetRows(contentLineCount: number): number {
		const requestedRows = this.options.getRows?.();
		if (requestedRows && Number.isFinite(requestedRows)) {
			return Math.max(contentLineCount, Math.floor(requestedRows));
		}
		return contentLineCount;
	}
}
