import { beforeAll, describe, expect, test, vi } from "vitest";
import { createSessionSlashCommandMessage, createSessionSlashCommandResultMessage } from "../src/core/messages.js";
import {
	isLeadingSlashCommand,
	SlashCommandMessageComponent,
} from "../src/modes/interactive/components/slash-command-message.js";
import { SlashCommandResultMessageComponent } from "../src/modes/interactive/components/slash-command-result-message.js";
import { InteractiveMode, styleQueuedMessagePreview } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const command = { name: "compact" as const, args: "focus", text: "/compact focus" };

describe("InteractiveMode session command rendering", () => {
	beforeAll(() => initTheme("dark"));
	test("uses specialized components for live command messages", () => {
		const children: unknown[] = [];
		const fakeThis = {
			chatContainer: { children: [], addChild: vi.fn((child: unknown) => children.push(child)) },
			toolOutputExpanded: false,
		};
		const add = Reflect.get(InteractiveMode.prototype, "addMessageToChat") as (
			this: typeof fakeThis,
			message:
				| ReturnType<typeof createSessionSlashCommandMessage>
				| ReturnType<typeof createSessionSlashCommandResultMessage>,
		) => void;

		add.call(fakeThis, createSessionSlashCommandMessage(command));
		add.call(
			fakeThis,
			createSessionSlashCommandResultMessage("Command failed", {
				command,
				success: false,
				severity: "error",
				error: "failed",
			}),
		);

		expect(children[0]).toBeInstanceOf(SlashCommandMessageComponent);
		expect(children[1]).toBeInstanceOf(SlashCommandResultMessageComponent);
	});

	test("recognizes only a complete command token at the start", () => {
		const recognized = (name: string) => name === "goal";
		expect(isLeadingSlashCommand("/goal ship it", recognized)).toBe(true);
		expect(isLeadingSlashCommand("/goal", recognized)).toBe(true);
		expect(isLeadingSlashCommand("/goalkeeper", recognized)).toBe(false);
		expect(isLeadingSlashCommand("/goal\nship it", recognized)).toBe(false);
		expect(isLeadingSlashCommand("/goal	ship it", recognized)).toBe(true);
		expect(isLeadingSlashCommand("Explain /goal", recognized)).toBe(false);
	});

	test("keeps only recognized commands accented in queued previews", () => {
		const recognized = (name: string) => name === "compact";
		const commandPreview = styleQueuedMessagePreview("/compact focus", "Follow-up", recognized);
		const unknownPreview = styleQueuedMessagePreview("/unknown focus", "Follow-up", recognized);

		expect(commandPreview).toContain(theme.fg("accent", "/compact"));
		expect(unknownPreview).not.toContain(theme.fg("accent", "/unknown"));
	});
});
