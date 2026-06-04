import { Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type ClearCommandContext = {
	stopWorkingLoader: () => void;
	agentConnection: {
		newSession: () => Promise<{ cancelled: boolean }>;
	};
	renderCurrentSessionState: () => Promise<void>;
	chatContainer: Container;
	ui: { requestRender: () => void };
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
};

type InteractiveModePrototype = {
	handleClearCommand(this: ClearCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function renderAll(container: Container, width = 120): string {
	return container.children
		.flatMap((child) => child.render(width))
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("InteractiveMode /clear", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("creates the replacement session through AgentConnection", async () => {
		const newSession = vi.fn(async () => ({ cancelled: false }));
		const renderCurrentSessionState = vi.fn(async () => {});
		const requestRender = vi.fn();
		const context: ClearCommandContext = {
			stopWorkingLoader: vi.fn(),
			agentConnection: { newSession },
			renderCurrentSessionState,
			chatContainer: new Container(),
			ui: { requestRender },
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
		};

		await interactiveModePrototype.handleClearCommand.call(context);

		expect(context.stopWorkingLoader).toHaveBeenCalledWith();
		expect(newSession).toHaveBeenCalledWith();
		expect(renderCurrentSessionState).toHaveBeenCalledWith();
		expect(requestRender).toHaveBeenCalledWith();
		expect(renderAll(context.chatContainer)).toContain("New session started");
	});

	it("does not rerender when the connection reports cancellation", async () => {
		const newSession = vi.fn(async () => ({ cancelled: true }));
		const context: ClearCommandContext = {
			stopWorkingLoader: vi.fn(),
			agentConnection: { newSession },
			renderCurrentSessionState: vi.fn(async () => {}),
			chatContainer: new Container(),
			ui: { requestRender: vi.fn() },
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
		};

		await interactiveModePrototype.handleClearCommand.call(context);

		expect(newSession).toHaveBeenCalledWith();
		expect(context.renderCurrentSessionState).not.toHaveBeenCalled();
		expect(context.ui.requestRender).not.toHaveBeenCalled();
		expect(context.chatContainer.children).toHaveLength(0);
	});
});
