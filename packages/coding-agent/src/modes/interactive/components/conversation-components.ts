import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component, MarkdownTheme, TUI } from "@earendil-works/pi-tui";
import { AssistantMessageComponent } from "./assistant-message.js";
import { ToolExecutionComponent, type ToolExecutionDefinition, type ToolExecutionOptions } from "./tool-execution.js";
import { UserMessageComponent } from "./user-message.js";

export interface ConversationComponentsOptions {
	ui: TUI;
	cwd: string;
	toolOptions: ToolExecutionOptions;
	getToolDefinition: (name: string) => ToolExecutionDefinition | undefined;
	markdownTheme?: MarkdownTheme;
	hideThinkingBlock?: boolean;
	hiddenThinkingLabel?: string;
	toolsExpanded?: boolean;
}

function readUserText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter(
			(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("");
}

/** Build conversation components from a message list, matching tool results to their calls. */
export function buildConversationComponents(
	messages: readonly AgentMessage[],
	options: ConversationComponentsOptions,
): Component[] {
	const components: Component[] = [];
	const pendingTools = new Map<string, ToolExecutionComponent>();
	const expanded = options.toolsExpanded ?? false;

	for (const message of messages) {
		if (message.role === "assistant") {
			components.push(
				new AssistantMessageComponent(
					message,
					options.hideThinkingBlock ?? false,
					options.markdownTheme,
					options.hiddenThinkingLabel ?? "Thinking...",
					{ expanded },
				),
			);
			for (const content of message.content) {
				if (content.type !== "toolCall") {
					continue;
				}
				const tool = new ToolExecutionComponent(
					content.name,
					content.id,
					content.arguments,
					// Replayed history rebuilds on every event; don't re-emit inline images.
					{ ...options.toolOptions, allowInlineImages: false },
					options.getToolDefinition(content.name),
					options.ui,
					options.cwd,
				);
				tool.setExpanded(expanded);
				tool.markExecutionStarted();
				tool.setArgsComplete();
				components.push(tool);
				if (message.stopReason === "aborted" || message.stopReason === "error") {
					tool.updateResult({
						content: [{ type: "text", text: message.errorMessage || "Operation aborted" }],
						isError: true,
					});
				} else {
					pendingTools.set(content.id, tool);
				}
			}
		} else if (message.role === "toolResult") {
			pendingTools.get(message.toolCallId)?.updateResult(message);
			pendingTools.delete(message.toolCallId);
		} else if (message.role === "user") {
			const text = readUserText(message.content);
			const hasContent =
				typeof message.content === "string" ? message.content.length > 0 : message.content.length > 0;
			// An image-only prompt has no text; show a placeholder rather than dropping it.
			const display = text || (hasContent ? "[image]" : "");
			if (display) {
				components.push(new UserMessageComponent(display, options.markdownTheme));
			}
		}
		// Non-conversational messages (bash/branch-summary/compaction/custom) aren't shown.
	}
	return components;
}
