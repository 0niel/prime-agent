import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.js";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.js";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.js";
import { convertToPng } from "../../../utils/image-convert.js";
import type { AgentConnectionToolDefinition } from "../../agent-connection/index.js";
import { type Theme, theme } from "../theme/theme.js";
import { getIpythonCodeFromArgs, IPythonCellComponent } from "./ipython-cell.js";
import { ToolPanel } from "./tool-panel.js";

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
}

export interface ToolExecutionRendererDefinition {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}
export type ToolExecutionDefinition = AgentConnectionToolDefinition & Partial<ToolExecutionRendererDefinition>;

export class ToolExecutionComponent extends Container {
	private contentPanel: ToolPanel;
	private selfRenderContainer: Container;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private ipythonCellComponent?: IPythonCellComponent;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolExecutionDefinition;
	private builtInToolDefinition?: ToolDefinition<any, any>;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolExecutionDefinition | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create both shell variants. contentPanel is the tool panel used
		// for default renderer-based composition (and the generic fallback when no
		// tool definition exists). selfRenderContainer is used when the tool
		// renders its own framing.
		this.contentPanel = new ToolPanel();
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			this.addChild(this.selfRenderContainer);
		} else {
			this.addChild(this.contentPanel);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (this.shouldUseIpythonRenderer()) {
			return "self";
		}
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private shouldUseIpythonRenderer(): boolean {
		return this.toolName === "ipython" && !this.toolDefinition?.renderCall && !this.toolDefinition?.renderResult;
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}
		return new Text(theme.fg("toolOutput", output), 0, 0);
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) {
			return [];
		}
		return super.render(width);
	}

	private updateDisplay(): void {
		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			this.selfRenderContainer.clear();

			if (this.shouldUseIpythonRenderer()) {
				const state = {
					code: getIpythonCodeFromArgs(this.args),
					content: this.result?.content,
					details: this.result?.details,
					isPartial: this.isPartial,
					isError: this.result?.isError ?? false,
					expanded: this.expanded,
					executionStarted: this.executionStarted,
					argsComplete: this.argsComplete,
					showImages: this.showImages,
					cwd: this.cwd,
				};
				if (!this.ipythonCellComponent) {
					this.ipythonCellComponent = new IPythonCellComponent(state);
				} else {
					this.ipythonCellComponent.update(state);
				}
				this.selfRenderContainer.addChild(this.ipythonCellComponent);
				hasContent = true;
			} else {
				hasContent = this.mountRenderers(this.selfRenderContainer, true);
			}
		} else {
			// Default shell: tool panel with a `label · status` header so the block
			// is self-identifying. The header replaces the bold-tool-name fallback.
			this.contentPanel.setHeader(this.panelHeader());
			this.contentPanel.clear();
			if (this.hasRendererDefinition()) {
				this.mountRenderers(this.contentPanel, false);
			} else {
				const fallbackText = this.formatToolExecution();
				if (fallbackText) {
					this.contentPanel.addChild(new Text(fallbackText, 0, 0));
				}
			}
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
	}

	/**
	 * Mount the call/result renderer components into the given shell container.
	 * `useFallbacks` keeps the bold-tool-name call fallback for self-rendering
	 * tools; the default panel shell already names the tool in its header.
	 */
	private mountRenderers(container: Container | ToolPanel, useFallbacks: boolean): boolean {
		let hasContent = false;

		const callRenderer = this.getCallRenderer();
		if (!callRenderer) {
			if (useFallbacks) {
				container.addChild(this.createCallFallback());
				hasContent = true;
			}
		} else {
			try {
				const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
				this.callRendererComponent = component;
				container.addChild(component);
				hasContent = true;
			} catch {
				this.callRendererComponent = undefined;
				if (useFallbacks) {
					container.addChild(this.createCallFallback());
					hasContent = true;
				}
			}
		}

		if (this.result) {
			const resultRenderer = this.getResultRenderer();
			if (!resultRenderer) {
				const component = this.createResultFallback();
				if (component) {
					container.addChild(component);
					hasContent = true;
				}
			} else {
				try {
					const component = resultRenderer(
						{ content: this.result.content as any, details: this.result.details },
						{ expanded: this.expanded, isPartial: this.isPartial },
						theme,
						this.getRenderContext(this.resultRendererComponent),
					);
					this.resultRendererComponent = component;
					container.addChild(component);
					hasContent = true;
				} catch {
					this.resultRendererComponent = undefined;
					const component = this.createResultFallback();
					if (component) {
						container.addChild(component);
						hasContent = true;
					}
				}
			}
		}

		return hasContent;
	}

	private panelHeader(): string {
		const label = this.toolDefinition?.label ?? this.builtInToolDefinition?.label ?? this.toolName;
		return `${theme.fg("muted", label)}${theme.fg("dim", " · ")}${this.panelStatus()}`;
	}

	private panelStatus(): string {
		if (this.result && !this.isPartial) {
			return this.result.isError ? theme.fg("error", "error") : theme.fg("success", "done");
		}
		if (this.result?.isError) {
			return theme.fg("error", "error");
		}
		if (this.executionStarted) {
			return theme.fg("bashMode", "running");
		}
		return theme.fg("muted", "queued");
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		const parts: string[] = [];
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			parts.push(content);
		}
		const output = this.getTextOutput();
		if (output) {
			parts.push(output);
		}
		return parts.join("\n\n");
	}
}
