import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/index.js";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.js";
import { initTheme, preloadCodeHighlighter } from "../src/modes/interactive/theme/theme.js";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function makeSession(
	overrides: Partial<AgentConnectionSavedSessionInfo> & { id: string },
): AgentConnectionSavedSessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

// Kitty keyboard protocol encoding for Ctrl+R
const CTRL_R = "\x1b[114;5u";

describe("session selector rename", () => {
	beforeAll(async () => {
		initTheme("dark");
		await preloadCodeHighlighter();
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	it("shows rename hint in interactive /resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ showRenameHint: true, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).toContain("Ctrl+R");
		expect(output).toContain("rename");
	});

	it("shows rename hint in --resume picker configuration", async () => {
		const sessions = [makeSession({ id: "a" })];
		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession: async () => {}, showRenameHint: true, keybindings },
		);
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(output).toContain("Ctrl+R");
		expect(output).toContain("rename");
	});

	it("enters rename mode on Ctrl+R and submits with Enter", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.handleInput(CTRL_R);
		await flushPromises();

		// Rename mode layout
		const output = selector.render(120).join("\n");
		expect(output).toContain("Rename Session");
		expect(output).not.toContain("Resume Session");

		// Type and submit
		selector.handleInput("X");
		selector.handleInput("\r");
		await flushPromises();

		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(renameSession).toHaveBeenCalledWith(sessions[0]!.path, "XOld");
	});

	it("shows an error when rename fails", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {
			throw new Error("daemon unavailable");
		});

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();

		selector.handleInput("\r");
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(output).toContain("Resume Session");
		expect(output).toContain("Failed to rename: daemon unavailable");
	});

	it("does not report rename failure when refresh after rename fails", async () => {
		const sessions = [makeSession({ id: "a", name: "Old" })];
		const renameSession = vi.fn(async () => {});
		let loadCalls = 0;

		const keybindings = new KeybindingsManager();
		const selector = new SessionSelectorComponent(
			async () => {
				loadCalls++;
				if (loadCalls > 1) {
					throw new Error("refresh unavailable");
				}
				return sessions;
			},
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ renameSession, showRenameHint: true, keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(CTRL_R);
		await flushPromises();

		selector.handleInput("\r");
		await flushPromises();

		const output = selector.render(120).join("\n");
		expect(renameSession).toHaveBeenCalledTimes(1);
		expect(output).toContain("Resume Session");
		expect(output).not.toContain("Failed to rename");
	});
});
