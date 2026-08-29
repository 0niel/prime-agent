import type { AssistantMessage } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import type { MermaidRenderingMode } from "../src/core/settings-manager.js";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.js";
import { createMermaidMarkdownTransform } from "../src/modes/interactive/components/mermaid.js";
import { initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.js";

interface TransformOptions {
	maxWidth?: number;
	isStreaming?: boolean;
	mode?: MermaidRenderingMode;
	theme?: Theme;
}

function transformMermaid(markdown: string, options: TransformOptions = {}): string {
	const transform = createMermaidMarkdownTransform({
		getMode: () => options.mode ?? "streaming",
		theme: options.theme,
	});
	return transform(markdown, options.maxWidth ?? 100, options.isStreaming ?? false);
}

describe("Mermaid rendering", () => {
	it("replaces Mermaid code blocks with Unicode diagrams", () => {
		const markdown = "Before\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\nAfter";
		const rendered = transformMermaid(markdown);

		expect(rendered).toContain("Before");
		expect(rendered).toContain("┌───────┐");
		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).toContain("└───────┘    └──────┘`\nAfter");
		expect(rendered).not.toContain("```mermaid");
		expect(rendered).toContain("After");
	});

	it("leaves unsupported and oversized diagrams unchanged", () => {
		const unsupported = '```mermaid\npie\n  title Pets\n  "Dogs" : 4\n```';
		const markdown = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

		expect(transformMermaid(unsupported)).toBe(unsupported);
		// The rendered diagram is exactly 21 columns wide: exact fit renders, one short falls back.
		expect(transformMermaid(markdown, { maxWidth: 21 })).toContain("───▶");
		expect(transformMermaid(markdown, { maxWidth: 20 })).toBe(markdown);
	});

	it("maps semantic spans through the theme", () => {
		const fakeTheme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => `<bold>${text}</bold>`,
		} as unknown as Theme;
		const rendered = transformMermaid("```mermaid\nflowchart LR\n  A --> B\n```", { theme: fakeTheme });

		expect(rendered).toContain("<borderMuted>");
		expect(rendered).toContain("<accent>");
	});

	it("renders incomplete Mermaid blocks during streaming", () => {
		const partialMarkdown = "```mermaid\nflowchart LR\n  A --> B";

		expect(transformMermaid(partialMarkdown, { isStreaming: true })).toContain("───▶");
	});

	it("falls back to the code block with a warning after streaming", () => {
		const markdown = "```mermaid\nflowchart LR\n  A[Foo] --> B[Bar]\n  ???bogus line\n```";
		const final = transformMermaid(markdown);
		const followedByText = transformMermaid(`${markdown}\nFollowing text`);
		const streaming = transformMermaid(markdown, { isStreaming: true });

		expect(final).toContain(markdown);
		expect(final).toContain("```\n`Mermaid diagram not rendered");
		expect(final).toContain('dropped, does not start with a node: "???bogus line"');
		expect(final).not.toContain("more)");
		expect(followedByText).toContain("  \nFollowing text");
		expect(streaming).not.toContain("Mermaid diagram not rendered");
		expect(streaming).not.toContain("```mermaid");
		expect(streaming).toContain("│ Foo ├───▶│ Bar │");

		// Additional warnings are summarized as a count instead of listed.
		const twoWarnings = transformMermaid(
			"```mermaid\nflowchart LR\n  A[Foo] --> B[Bar]\n  ???bogus one\n  ???bogus two\n```",
		);
		expect(twoWarnings).toContain('dropped, does not start with a node: "???bogus one"');
		expect(twoWarnings).toContain("(+1 more)");
		expect(twoWarnings).not.toContain('"???bogus two"');
	});

	it("respects rendering modes", () => {
		const markdown = "```mermaid\nflowchart LR\n  A --> B\n```";

		expect(transformMermaid(markdown, { mode: "off" })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final", isStreaming: true })).toBe(markdown);
		expect(transformMermaid(markdown, { mode: "final" })).not.toContain("```mermaid");
	});
});

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const MERMAID_MARKDOWN = "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```";

describe("Mermaid rendering in assistant messages", () => {
	let mode: MermaidRenderingMode;
	const mermaidTransform = createMermaidMarkdownTransform({ getMode: () => mode, theme });

	function createComponent(content: AssistantMessage["content"]): AssistantMessageComponent {
		return new AssistantMessageComponent(createAssistantMessage(content), false, undefined, "Thinking...", {
			mermaidTransform,
		});
	}

	beforeAll(() => {
		initTheme("dark");
	});

	it("renders Mermaid code blocks in assistant text as Unicode diagrams", () => {
		mode = "streaming";
		const component = createComponent([{ type: "text", text: `Before\n\n${MERMAID_MARKDOWN}\nAfter` }]);
		const rendered = stripAnsi(component.render(100).join("\n"));

		expect(rendered).toContain("│ Start ├───▶│ Done │");
		expect(rendered).not.toContain("```mermaid");

		// The transform sees the component's real content width: too narrow falls back to the code block.
		const narrow = stripAnsi(
			createComponent([{ type: "text", text: MERMAID_MARKDOWN }])
				.render(16)
				.join("\n"),
		);
		expect(narrow).toContain("flowchart LR");
		expect(narrow).not.toContain("───▶");
	});

	it("preserves backticks in diagram labels", () => {
		mode = "streaming";
		const component = createComponent([
			{ type: "text", text: '```mermaid\nflowchart LR\n  A["has ` tick"] --> B[Done]\n```' },
		]);
		const rendered = stripAnsi(component.render(100).join("\n"));

		expect(rendered).toContain("│ has ` tick ├───▶│ Done │");
	});

	it("never transforms thinking blocks", () => {
		mode = "streaming";
		const component = createComponent([{ type: "thinking", thinking: MERMAID_MARKDOWN }]);
		const rendered = stripAnsi(component.render(100).join("\n"));

		expect(rendered).toContain("flowchart LR");
		expect(rendered).not.toContain("───▶");
	});
});
