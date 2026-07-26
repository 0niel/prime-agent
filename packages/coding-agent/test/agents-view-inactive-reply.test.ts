import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import {
	AgentsViewMode,
	createReplyComposerAutocompleteProvider,
	createSearchViewAutocompleteProvider,
	getReplyComposerCommandRejection,
	parseAgentsViewCommand,
} from "../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function summary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "saved-1",
		lifecycle: "archived",
		activity: "idle",
		sessionId: "saved-1",
		cwd: process.cwd(),
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 3,
		pendingMessageCount: 0,
		...overrides,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") {
		throw new Error(`AgentsViewMode.${method} no longer exists; update this test harness`);
	}
	return member.call(self, ...args);
}

function editorWithText(initial: string) {
	let text = initial;
	return {
		getText: () => text,
		setText: vi.fn((next: string) => {
			text = next;
		}),
	};
}

describe("agents view reply on inactive sessions", () => {
	beforeAll(() => {
		setKeybindings(new KeybindingsManager());
	});

	const savedSummary = summary({
		sessionFile: "/tmp/sessions/saved-1.jsonl",
		cwd: process.cwd(),
		summary: "Persisted recap text",
		firstMessage: "opener",
	});

	it("arms the composer on a saved-only row using the persisted recap", async () => {
		const setReplyTarget = vi.fn();
		const requestRender = vi.fn();
		const self: Record<string, unknown> = {
			rows: [
				{ kind: "agent", selectable: true, identity: "file:/tmp/sessions/saved-1.jsonl", summary: savedSummary },
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			replyTarget: undefined,
			setReplyTarget,
			ui: { requestRender },
			requireClient: () => {
				throw new Error("saved rows must not hit the daemon for a preview");
			},
		};

		await invoke("toggleReplyTarget", self);

		expect(setReplyTarget).toHaveBeenCalledWith({ key: "saved-1", summary: savedSummary });
		expect(self.replyLastAssistantText).toBe("Persisted recap text");
	});

	it("ignores rows with neither a runtime nor a session file", async () => {
		const setReplyTarget = vi.fn();
		const self = {
			rows: [{ kind: "agent", selectable: true, identity: "session:saved-1", summary: summary({}) }],
			selectedIndex: 0,
			setReplyTarget,
		};

		await invoke("toggleReplyTarget", self);

		expect(setReplyTarget).not.toHaveBeenCalled();
	});

	it("resumes a saved session before delivering the reply", async () => {
		const request = vi.fn(async (command: { type: string }) => {
			if (command.type === "create") {
				return {
					success: true,
					data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9", isStreaming: true },
				};
			}
			return { success: true, data: {} };
		});
		const target = { key: "saved-1", summary: savedSummary };
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			replyTarget: target,
			// Stale pre-resume rows do not know the resumed session; scheduling must
			// come from the resume response instead.
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, target, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith("active-9", "wake up", "steer");
		expect(self.selectSummary).toHaveBeenCalledWith(expect.objectContaining({ activeSessionId: "active-9" }));
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
	});

	it("does not select a resumed session after its reply target is cancelled", async () => {
		let finishResume: ((result: { success: true; data: SessionSummary }) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: SessionSummary }>((resolve) => {
					finishResume = resolve;
				}),
		);
		const target = { key: "saved-1", summary: savedSummary };
		const selection = { activeSessionId: "active-2" };
		const selectSummary = vi.fn((next: SessionSummary) => {
			selection.activeSessionId = next.activeSessionId ?? next.id;
		});
		const sendPrompt = vi.fn(async () => {});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			replyTarget: target,
			setStatusMessage: vi.fn(),
			selectSummary,
			sendPrompt,
		};

		const reply = invoke("sendReply", self, target, "wake up") as Promise<boolean>;
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
		self.replyTarget = undefined;
		finishResume?.({
			success: true,
			data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
		});

		await expect(reply).resolves.toBe(true);
		expect(selectSummary).not.toHaveBeenCalled();
		expect(selection.activeSessionId).toBe("active-2");
		expect(sendPrompt).toHaveBeenCalledWith("active-9", "wake up", undefined);
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
	});

	it("preserves a replacement composer when an older reply succeeds", async () => {
		const editor = editorWithText("old reply");
		const oldTarget = { key: "saved-1", summary: savedSummary };
		const newTarget = {
			key: "active-2",
			summary: summary({ id: "active-2", activeSessionId: "active-2", lifecycle: "live" }),
		};
		const self: Record<string, unknown> = {
			replyTarget: oldTarget,
			options: {},
			editor,
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			sendReply: vi.fn(async () => {
				self.replyTarget = newTarget;
				editor.setText("new reply");
				return true;
			}),
		};

		await invoke("submit", self, "old reply");

		expect(self.replyTarget).toBe(newTarget);
		expect(editor.getText()).toBe("new reply");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
		expect(self.refreshSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
	});

	it("preserves new text entered while the same reply succeeds", async () => {
		const editor = editorWithText("first reply");
		const target = { key: "saved-1", summary: savedSummary };
		const self: Record<string, unknown> = {
			replyTarget: target,
			options: {},
			editor,
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			sendReply: vi.fn(async () => {
				editor.setText("next reply");
				return true;
			}),
		};

		await invoke("submit", self, "first reply");

		expect(self.replyTarget).toBe(target);
		expect(editor.getText()).toBe("next reply");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "resume failure", failure: "resume", remainsInactive: true },
		{ name: "send failure", failure: "send", remainsInactive: false },
		{
			name: "replacement text entered during send failure",
			failure: "send",
			replacement: "replacement",
			remainsInactive: false,
		},
	] as const)("handles $name", async ({ failure, replacement, remainsInactive }) => {
		const editor = editorWithText("wake up");
		const target = { key: "saved-1", summary: savedSummary };
		const inactiveAgentIdentities = new Set(["file:/tmp/sessions/saved-1.jsonl"]);
		const request = vi.fn(async () => {
			if (failure === "resume") throw new Error("resume failed");
			return {
				success: true,
				data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
			};
		});
		const sendPrompt = vi.fn(async () => {
			if (replacement) editor.setText(replacement);
			throw new Error("send failed");
		});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities,
			replyTarget: target,
			editor,
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt,
			sendReply: (replyTarget: unknown, text: string) => invoke("sendReply", self, replyTarget, text),
		};

		await invoke("submit", self, "wake up");

		expect(editor.setText).toHaveBeenNthCalledWith(1, "");
		expect(editor.getText()).toBe(replacement ?? "wake up");
		expect(inactiveAgentIdentities.has("file:/tmp/sessions/saved-1.jsonl")).toBe(remainsInactive);
		expect(self.refreshSessions).toHaveBeenCalledTimes(remainsInactive ? 0 : 1);
		if (!remainsInactive) {
			expect(self.refreshSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
		}
	});

	it("keeps the cwd-fallback notice visible after the reply is sent", async () => {
		const missingCwd = "/definitely/not/a/real/dir/for/this/test";
		const savedWithMissingCwd = { ...savedSummary, cwd: missingCwd };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...savedWithMissingCwd, lifecycle: "live", activeSessionId: "active-9" },
		}));
		const statuses: Array<[string, { sticky?: boolean } | undefined]> = [];
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage: vi.fn((message: string, options?: { sticky?: boolean }) => {
				statuses.push([message, options]);
			}),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "saved-1", summary: savedWithMissingCwd }, "wake up");

		const last = statuses.at(-1);
		expect(last?.[0]).toContain("Original directory is missing");
		expect(last?.[1]).toEqual({ sticky: true });
	});

	it("resumes the current saved row when an armed live target becomes inactive", async () => {
		const capturedLive = summary({
			activeSessionId: "active-dead",
			lifecycle: "live",
			sessionFile: savedSummary.sessionFile,
		});
		const currentSaved = { ...savedSummary, activeSessionId: undefined };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...currentSaved, lifecycle: "live", activeSessionId: "active-new" },
		}));
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			unifiedRecords: [
				{
					daemon: currentSaved,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "inactive",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set<string>(),
			replyTarget: undefined,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-dead", summary: capturedLive }, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith("active-new", "wake up", undefined);
		expect(self.sendPrompt).not.toHaveBeenCalledWith("active-dead", expect.anything(), expect.anything());
	});

	it("queues a follow-up when Alt+Enter delivery is requested", async () => {
		const liveSummary = summary({ activeSessionId: "active-1", lifecycle: "live", isStreaming: true });
		const self: Record<string, unknown> = {
			options: { config: {} },
			requireClient: () => ({ request: vi.fn() }),
			findSummaryByActiveSessionId: () => liveSummary,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-1", summary: liveSummary }, "later please", "followUp");

		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "later please", "followUp");
	});

	it("steers a streaming session on plain submit", async () => {
		const liveSummary = summary({ activeSessionId: "active-1", lifecycle: "live", isStreaming: true });
		const self: Record<string, unknown> = {
			options: { config: {} },
			requireClient: () => ({ request: vi.fn() }),
			findSummaryByActiveSessionId: () => liveSummary,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-1", summary: liveSummary }, "change course");

		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "change course", "steer");
	});

	it("routes the follow-up keybinding through submit with followUp delivery", () => {
		const submit = vi.fn(async () => {});
		const self = {
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			editor: { getExpandedText: () => "queued reply" },
			submit,
		};

		invoke("handleReplyFollowUp", self);

		expect(submit).toHaveBeenCalledWith("queued reply", "followUp");
	});

	it("ignores the follow-up keybinding without an armed target or text", () => {
		const submit = vi.fn(async () => {});
		invoke("handleReplyFollowUp", { replyTarget: undefined, editor: { getExpandedText: () => "text" }, submit });
		invoke("handleReplyFollowUp", {
			replyTarget: { key: "a", summary: summary({}) },
			editor: { getExpandedText: () => "   " },
			submit,
		});
		expect(submit).not.toHaveBeenCalled();
	});

	it("replies to live sessions without resuming", async () => {
		const liveSummary = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn();
		const self: Record<string, unknown> = {
			options: { config: {} },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => liveSummary,
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-1", summary: liveSummary }, "hello");

		expect(request).not.toHaveBeenCalled();
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "hello", undefined);
		expect(self.selectSummary).not.toHaveBeenCalled();
	});

	it("creates a new daemon session over a dedicated connection and opens it", async () => {
		const created = summary({ id: "active-new", activeSessionId: "active-new", lifecycle: "live" });
		const request = vi.fn(async () => ({ success: true, data: created }));
		const close = vi.fn();
		const finish = vi.fn();
		const self: Record<string, unknown> = {
			creatingNewSession: false,
			options: { config: { cwd: process.cwd() } },
			connectDedicatedClient: vi.fn(async () => ({ request, close })),
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			finish,
		};

		await invoke("createNewSession", self);

		expect(request).toHaveBeenCalledWith(expect.objectContaining({ type: "create" }));
		expect(self.selectSummary).toHaveBeenCalledWith(created);
		expect(finish).toHaveBeenCalledWith({ type: "open", summary: created });
		expect(close).toHaveBeenCalled();
	});

	it("kills a session created after the view already finished", async () => {
		const created = summary({ id: "active-new", activeSessionId: "active-new", lifecycle: "live" });
		const requests: { type: string }[] = [];
		const self: Record<string, unknown> = {
			creatingNewSession: false,
			stopped: false,
			options: { config: {} },
			connectDedicatedClient: vi.fn(async () => ({
				close: vi.fn(),
				request: vi.fn(async (command: { type: string }) => {
					requests.push(command);
					// The view finishes while create is in flight.
					self.stopped = true;
					return { success: true, data: created };
				}),
			})),
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			finish: vi.fn(),
		};

		await invoke("createNewSession", self);

		expect(requests.map((r) => r.type)).toEqual(["create", "kill"]);
		expect(self.finish).not.toHaveBeenCalled();
		expect(self.selectSummary).not.toHaveBeenCalled();
	});

	it("expands paste markers for the alt+enter follow-up path", () => {
		const submit = vi.fn(async () => {});
		const self = {
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			editor: { getExpandedText: () => "expanded paste body" },
			submit,
		};

		invoke("handleReplyFollowUp", self);

		expect(submit).toHaveBeenCalledWith("expanded paste body", "followUp");
	});

	it("reports a create failure without leaving the view", async () => {
		const request = vi.fn(async () => {
			throw new Error("daemon busy");
		});
		const finish = vi.fn();
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = {
			creatingNewSession: false,
			options: { config: {} },
			connectDedicatedClient: vi.fn(async () => ({ request, close: vi.fn() })),
			setStatusMessage,
			selectSummary: vi.fn(),
			finish,
		};

		await expect(invoke("createNewSession", self)).resolves.toBe(false);

		expect(finish).not.toHaveBeenCalled();
		expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("Failed to create session"));
		expect(self.creatingNewSession).toBe(false);
	});

	it("resets the guard when no daemon connection is available", async () => {
		const self: Record<string, unknown> = {
			creatingNewSession: false,
			options: { config: {} },
			connectDedicatedClient: vi.fn(async () => {
				throw new Error("Agents view daemon socket is not configured");
			}),
			setStatusMessage: vi.fn(),
		};

		await expect(invoke("createNewSession", self)).resolves.toBe(false);
		expect(self.creatingNewSession).toBe(false);
	});

	it("shows composer-mode hints that track target state and typed text", () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live", isStreaming: true });
		const self: Record<string, unknown> = {
			replyTarget: { key: "active-1", summary: live },
			unifiedRecords: [],
			findSummaryByActiveSessionId: () => live,
			editor: editorWithText(""),
		};

		const idleHints = stripAnsi(invoke("renderReplyComposerHints", self) as string);
		expect(idleHints).toContain("steer");
		expect(idleHints).toContain("cancel");
		expect(idleHints).not.toContain("queue");

		self.editor = editorWithText("some reply");
		const typedHints = stripAnsi(invoke("renderReplyComposerHints", self) as string);
		expect(typedHints).toContain("queue");

		const saved = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		self.replyTarget = { key: "saved-1", summary: saved };
		self.findSummaryByActiveSessionId = () => undefined;
		const savedHints = stripAnsi(invoke("renderReplyComposerHints", self) as string);
		expect(savedHints).toContain("resume & send");
	});
});

describe("reply composer slash commands", () => {
	it("lets session-owned commands pass through to the prompt path", () => {
		expect(getReplyComposerCommandRejection("/compact focus on the API work")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/refine")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/goal ship it")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/autonomous")).toBeUndefined();
	});

	it("rejects recognized non-session built-ins with guidance", () => {
		expect(getReplyComposerCommandRejection("/model gpt-5")).toContain("/model is not available here");
		expect(getReplyComposerCommandRejection("/settings")).toContain("not available here");
	});

	it("treats unrecognized slash-prefixed text as a plain reply", () => {
		expect(getReplyComposerCommandRejection("/usr/local/bin looks wrong")).toBeUndefined();
		expect(getReplyComposerCommandRejection("plain reply")).toBeUndefined();
	});

	it("restores the draft when a command is rejected after submit cleared the buffer", async () => {
		// submitValue empties the editor before onSubmit runs.
		const editor = editorWithText("");
		const setStatusMessage = vi.fn();
		const sendReply = vi.fn();
		const self: Record<string, unknown> = {
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			options: {},
			editor,
			setStatusMessage,
			sendReply,
		};

		await invoke("submit", self, "/model gpt-5");

		expect(sendReply).not.toHaveBeenCalled();
		expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("not available here"), {
			tone: "warning",
		});
		expect(editor.getText()).toBe("/model gpt-5");
	});

	it("does not overwrite newer typing when a rejection lands late", async () => {
		const editor = editorWithText("newer draft");
		const self: Record<string, unknown> = {
			replyTarget: { key: "active-1", summary: summary({ activeSessionId: "active-1" }) },
			options: {},
			editor,
			setStatusMessage: vi.fn(),
			sendReply: vi.fn(),
		};

		await invoke("submit", self, "/settings");

		expect(editor.getText()).toBe("newer draft");
	});

	it("binds reply autocomplete to the armed target's cwd", () => {
		const self: Record<string, unknown> = {
			replyTarget: undefined,
			replyAutocomplete: undefined,
			actionModeSearchQuery: undefined,
			persistentState: {},
			editor: Object.assign(editorWithText(""), { setPlaceholder: vi.fn() }),
			replyLastAssistantText: undefined,
			replyLastAssistantTextLoading: false,
			replyHeaderTime: "",
			rebuildRows: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const target = { key: "active-1", summary: summary({ activeSessionId: "active-1", cwd: "/tmp/elsewhere" }) };
		invoke("setReplyTarget", self, target);
		expect(self.replyAutocomplete).toBeDefined();
		invoke("setReplyTarget", self, undefined);
		expect(self.replyAutocomplete).toBeUndefined();
	});

	it("suggests only session-owned commands", async () => {
		const provider = createReplyComposerAutocompleteProvider(process.cwd());
		const suggestions = await provider.getSuggestions(["/"], 0, 1, { signal: new AbortController().signal });
		const names = suggestions?.items.map((item) => item.value) ?? [];
		expect(names).toEqual(expect.arrayContaining(["compact", "refine", "goal", "autonomous"]));
		expect(names).not.toContain("model");
		expect(names).not.toContain("settings");
	});
});

describe("agents view slash commands", () => {
	it("parses whitelisted view commands and aliases", () => {
		expect(parseAgentsViewCommand("/new")).toEqual({ name: "new", args: "" });
		expect(parseAgentsViewCommand("/fork")).toEqual({ name: "fork", args: "" });
		expect(parseAgentsViewCommand("/name My Agent")).toEqual({ name: "name", args: "My Agent" });
		expect(parseAgentsViewCommand("/rename My Agent")).toEqual({ name: "name", args: "My Agent" });
		expect(parseAgentsViewCommand("/kill")).toEqual({ name: "kill", args: "" });
		expect(parseAgentsViewCommand("/compact")).toBeUndefined();
		expect(parseAgentsViewCommand("/settings")).toBeUndefined();
		expect(parseAgentsViewCommand("plain search text")).toBeUndefined();
	});

	it("keeps view commands out of the composer rejection list", () => {
		expect(getReplyComposerCommandRejection("/fork")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/name x")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/kill")).toBeUndefined();
		expect(getReplyComposerCommandRejection("/new")).toBeUndefined();
	});

	it("suggests view commands in both composers and session commands only when armed", async () => {
		const composer = createReplyComposerAutocompleteProvider(process.cwd());
		const search = createSearchViewAutocompleteProvider(process.cwd());
		const signal = new AbortController().signal;
		const composerNames = (await composer.getSuggestions(["/"], 0, 1, { signal }))?.items.map((i) => i.value) ?? [];
		const searchNames = (await search.getSuggestions(["/"], 0, 1, { signal }))?.items.map((i) => i.value) ?? [];
		expect(composerNames).toEqual(
			expect.arrayContaining(["compact", "refine", "goal", "autonomous", "new", "fork", "name", "kill"]),
		);
		expect(searchNames).toEqual(expect.arrayContaining(["new", "fork", "name", "kill"]));
		expect(searchNames).not.toContain("compact");
		expect(searchNames).not.toContain("settings");
	});

	it("routes a search-editor command to the selected row", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const runAgentsViewCommand = vi.fn(async () => true);
		const self: Record<string, unknown> = {
			replyTarget: undefined,
			renameTarget: undefined,
			options: {},
			rows: [{ kind: "agent", selectable: true, summary: live }],
			selectedIndex: 0,
			runAgentsViewCommand,
			openSelected: vi.fn(),
		};

		await invoke("submit", self, "/kill");

		expect(runAgentsViewCommand).toHaveBeenCalledWith({ name: "kill", args: "" }, live);
		expect(self.openSelected).not.toHaveBeenCalled();
	});

	it("restores the search-editor command when it fails", async () => {
		const editor = editorWithText("");
		const self: Record<string, unknown> = {
			replyTarget: undefined,
			renameTarget: undefined,
			options: {},
			rows: [],
			selectedIndex: 0,
			editor,
			runAgentsViewCommand: vi.fn(async () => false),
			openSelected: vi.fn(),
		};

		await invoke("submit", self, "/kill");

		expect(editor.getText()).toBe("/kill");
	});

	it("keeps plain search text opening the selection", async () => {
		const openSelected = vi.fn();
		const self: Record<string, unknown> = {
			replyTarget: undefined,
			renameTarget: undefined,
			options: {},
			rows: [],
			selectedIndex: 0,
			runAgentsViewCommand: vi.fn(),
			openSelected,
		};

		await invoke("submit", self, "release planner");

		expect(openSelected).toHaveBeenCalledOnce();
		expect(self.runAgentsViewCommand).not.toHaveBeenCalled();
	});

	it("runs /new without a target row and propagates the outcome", async () => {
		const self: Record<string, unknown> = { createNewSession: vi.fn(async () => true), replyTarget: undefined };
		await expect(invoke("runAgentsViewCommand", self, { name: "new", args: "" }, undefined)).resolves.toBe(true);
		expect(self.createNewSession).toHaveBeenCalledOnce();

		const failing: Record<string, unknown> = { createNewSession: vi.fn(async () => false), replyTarget: undefined };
		await expect(invoke("runAgentsViewCommand", failing, { name: "new", args: "" }, undefined)).resolves.toBe(false);
	});

	it("requires a selected row for row-targeted commands", async () => {
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = { setStatusMessage, createNewSession: vi.fn() };

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, undefined);

		expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("Select an agent row"), {
			tone: "warning",
		});
	});

	it("renames a live target via the rename RPC", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn(async () => ({ success: true, data: {} }));
		const editor = editorWithText("/name Fresh Name");
		const self: Record<string, unknown> = {
			requireClient: () => ({ request }),
			editor,
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};

		await invoke("runAgentsViewCommand", self, { name: "name", args: "Fresh Name" }, live);

		expect(request).toHaveBeenCalledWith({ type: "rename", activeSessionId: "active-1", name: "Fresh Name" });
		expect(self.refreshSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
	});

	it("kills a live target and disarms the composer", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn(async () => ({ success: true, data: {} }));
		const setReplyTarget = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({ request }),
			editor: editorWithText("/kill"),
			setStatusMessage: vi.fn(),
			setReplyTarget,
			replyTarget: { key: "active-1", summary: live },
			refreshSessions: vi.fn(async () => true),
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, live);

		expect(request).toHaveBeenCalledWith({ type: "kill", activeSessionId: "active-1" });
		expect(setReplyTarget).toHaveBeenCalledWith(undefined);
	});

	it("does not disarm a composer that was re-armed during the command", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const originalTarget = { key: "active-1", summary: live };
		const newTarget = { key: "active-2", summary: summary({ activeSessionId: "active-2" }) };
		const setReplyTarget = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({
				request: vi.fn(async () => {
					// The user re-arms against a different agent mid-RPC.
					self.replyTarget = newTarget;
					return { success: true, data: {} };
				}),
			}),
			editor: editorWithText(""),
			setStatusMessage: vi.fn(),
			setReplyTarget,
			replyTarget: originalTarget,
			refreshSessions: vi.fn(async () => true),
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, live);

		expect(setReplyTarget).not.toHaveBeenCalled();
	});

	it("restores the command draft when the armed command fails", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const target = { key: "active-1", summary: live };
		const editor = editorWithText("");
		const self: Record<string, unknown> = {
			replyTarget: target,
			options: {},
			unifiedRecords: [],
			findSummaryByActiveSessionId: () => live,
			editor,
			setStatusMessage: vi.fn(),
			runAgentsViewCommand: vi.fn(async () => false),
		};

		await invoke("submit", self, "/name");

		expect(editor.getText()).toBe("/name");
	});

	it("reports a cancelled fork instead of claiming success", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn(async (command: { type: string }) => {
			if (command.type === "get_session_tree") return { success: true, data: { tree: [], leafId: "leaf-1" } };
			return { success: true, data: { cancelled: true } };
		});
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({ request }),
			setStatusMessage,
			refreshSessions: vi.fn(async () => true),
		};

		const forked = await invoke("forkTargetSession", self, live);

		expect(forked).toBe(false);
		expect(setStatusMessage).toHaveBeenCalledWith("Fork cancelled");
		expect(self.refreshSessions).not.toHaveBeenCalled();
	});

	it("stops a session resumed for a fork that then fails", async () => {
		const saved = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl", cwd: process.cwd() });
		const requests: { type: string }[] = [];
		const request = vi.fn(async (command: { type: string }) => {
			requests.push(command);
			if (command.type === "create") {
				return { success: true, data: { ...saved, lifecycle: "live", activeSessionId: "active-9" } };
			}
			// Empty tree: fork aborts after the resume already made the row live.
			return { success: true, data: { tree: [], leafId: null } };
		});
		const inactiveAgentIdentities = new Set(["file:/tmp/sessions/saved-1.jsonl"]);
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			setStatusMessage: vi.fn(),
			inactiveAgentIdentities,
			refreshSessions: vi.fn(async () => true),
		};

		const forked = await invoke("forkTargetSession", self, saved);

		expect(forked).toBe(false);
		// The resume served only the fork: the runtime is stopped again and the
		// row stays inactive.
		expect(requests.map((r) => r.type)).toEqual(["create", "get_session_tree", "kill"]);
		expect(inactiveAgentIdentities.has("file:/tmp/sessions/saved-1.jsonl")).toBe(true);
		expect(self.refreshSessions).toHaveBeenCalledWith({ preserveStatusOnError: true });
	});

	it("freezes the session filter while a view command is typed", () => {
		const matching = {
			daemon: summary({ activeSessionId: "active-1", sessionName: "kilroy" }),
			identity: "active:active-1",
			identityAliases: ["active:active-1"],
			section: "idle",
			searchableText: "kilroy",
		};
		const self: Record<string, unknown> = {
			replyTarget: undefined,
			renameTarget: undefined,
			options: {},
			unifiedRecords: [matching],
			editor: editorWithText("/kill"),
		};

		const records = invoke("getFilteredRecords", self) as unknown[];

		// "/kill" must not be applied as a fuzzy query (it would drop the row).
		expect(records).toHaveLength(1);
	});

	it("re-resolves the armed target before dispatching a view command", async () => {
		const stale = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		const liveNow = summary({
			sessionFile: "/tmp/sessions/saved-1.jsonl",
			activeSessionId: "active-9",
			lifecycle: "live",
		});
		const runAgentsViewCommand = vi.fn(async () => true);
		const self: Record<string, unknown> = {
			replyTarget: { key: "saved-1", summary: stale },
			options: {},
			unifiedRecords: [
				{
					daemon: liveNow,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "idle",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			editor: editorWithText(""),
			runAgentsViewCommand,
		};

		await invoke("submit", self, "/kill");

		expect(runAgentsViewCommand).toHaveBeenCalledWith(
			{ name: "kill", args: "" },
			expect.objectContaining({ activeSessionId: "active-9" }),
		);
	});

	it("ignores view commands in the armed composer under the local adapter", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const target = { key: "active-1", summary: live };
		const runAgentsViewCommand = vi.fn();
		const sendReply = vi.fn(async () => true);
		const self: Record<string, unknown> = {
			replyTarget: target,
			options: { adapter: { kind: "local" } },
			editor: editorWithText(""),
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			runAgentsViewCommand,
			sendReply,
		};

		await invoke("submit", self, "/kill");

		// Adapter sessions cannot run view commands; reject instead of prompting.
		expect(runAgentsViewCommand).not.toHaveBeenCalled();
		expect(sendReply).not.toHaveBeenCalled();
		expect(self.setStatusMessage).toHaveBeenCalledWith("/kill is not available here", { tone: "warning" });
	});

	it("refuses /kill on an inactive row", async () => {
		const saved = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		const request = vi.fn();
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({ request }),
			editor: editorWithText("/kill"),
			setStatusMessage,
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, saved);

		expect(request).not.toHaveBeenCalled();
		expect(setStatusMessage).toHaveBeenCalledWith(expect.stringContaining("inactive"), { tone: "warning" });
	});

	it("forks a live target at its current leaf", async () => {
		const live = summary({ activeSessionId: "active-1", lifecycle: "live" });
		const requests: { type: string }[] = [];
		const request = vi.fn(async (command: { type: string }) => {
			requests.push(command);
			if (command.type === "get_session_tree") return { success: true, data: { tree: [], leafId: "leaf-9" } };
			return { success: true, data: { cancelled: false } };
		});
		const self: Record<string, unknown> = {
			requireClient: () => ({ request }),
			editor: editorWithText("/fork"),
			setStatusMessage: vi.fn(),
			replyTarget: undefined,
			inactiveAgentIdentities: new Set<string>(),
			refreshSessions: vi.fn(async () => true),
		};

		await invoke("forkTargetSession", self, live);

		expect(requests.map((r) => r.type)).toEqual(["get_session_tree", "fork"]);
		expect(request).toHaveBeenCalledWith({
			type: "fork",
			activeSessionId: "active-1",
			entryId: "leaf-9",
			position: "at",
		});
	});

	it("resumes a saved row before forking it", async () => {
		const saved = summary({ sessionFile: "/tmp/sessions/saved-1.jsonl", cwd: process.cwd() });
		const requests: { type: string }[] = [];
		const request = vi.fn(async (command: { type: string }) => {
			requests.push(command);
			if (command.type === "create") {
				return { success: true, data: { ...saved, lifecycle: "live", activeSessionId: "active-9" } };
			}
			if (command.type === "get_session_tree") return { success: true, data: { tree: [], leafId: "leaf-1" } };
			return { success: true, data: { cancelled: false } };
		});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			editor: editorWithText("/fork"),
			setStatusMessage: vi.fn(),
			replyTarget: undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			refreshSessions: vi.fn(async () => true),
		};

		await invoke("forkTargetSession", self, saved);

		expect(requests.map((r) => r.type)).toEqual(["create", "get_session_tree", "fork"]);
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "fork", activeSessionId: "active-9", entryId: "leaf-1" }),
		);
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
	});
});
