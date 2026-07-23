import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionImportFileNotFoundError } from "../src/core/session-import-errors.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type PathCommand = "/export" | "/import";

type InteractiveModePrototype = {
	getPathCommandArgument(this: unknown, text: string, command: PathCommand): string | undefined;
	handleAutoImportCommand(this: AutoImportCommandContext, text: string): Promise<void>;
	handleHarnessImportCommand(this: HarnessImportCommandContext): Promise<void>;
	handleImportCommand(this: ImportCommandContext, text: string): Promise<void>;
	importAndResumeSession(this: ImportCommandContext, inputPath: string, successMessage: string): Promise<void>;
};

type AutoImportCommandContext = {
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
	handleImportCommand: (text: string) => Promise<void>;
	handleExternalSessionImport: (inputPath: string, source: "claude" | "codex" | "opencode") => Promise<void>;
	showError: (message: string) => void;
};

type HarnessImportCommandContext = {
	runSessionImportFlow: (trigger: "onboarding" | "command") => Promise<void>;
};

type ImportCommandContext = {
	loadingAnimation?: { stop: () => void };
	statusContainer: { clear: () => void };
	stopWorkingLoader: () => void;
	agentConnection: { importFromJsonl: (inputPath: string, cwdOverride?: string) => Promise<{ cancelled: boolean }> };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showExtensionConfirm: (title: string, message: string) => Promise<boolean>;
	renderCurrentSessionState: () => void;
	handleFatalRuntimeError: (prefix: string, error: unknown) => Promise<never>;
	promptForMissingSessionCwd: (error: unknown) => Promise<string | undefined>;
	getPathCommandArgument: (text: string, command: PathCommand) => string | undefined;
	importAndResumeSession: (inputPath: string, successMessage: string) => Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /import parsing", () => {
	it("opens harness import when no path is provided", async () => {
		const runSessionImportFlow = vi.fn(async () => {});

		await interactiveModePrototype.handleHarnessImportCommand.call({ runSessionImportFlow });

		expect(runSessionImportFlow).toHaveBeenCalledWith("command");
	});

	it("routes supported session files to native or external import", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-import-command-"));
		try {
			const piPath = join(root, "pi-mono.jsonl");
			const claudePath = join(root, "claude.jsonl");
			const codexPath = join(root, "codex.jsonl");
			const openCodePath = join(root, "opencode.json");
			writeFileSync(
				piPath,
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: "pi-mono",
					timestamp: "2026-01-01T00:00:00.000Z",
					cwd: root,
				})}\n`,
			);
			writeFileSync(
				claudePath,
				`${JSON.stringify({
					type: "user",
					message: { role: "user", content: "Claude prompt" },
				})}\n`,
			);
			writeFileSync(
				codexPath,
				`${JSON.stringify({
					type: "session_meta",
					payload: { id: "codex", cwd: root },
				})}\n`,
			);
			writeFileSync(
				openCodePath,
				JSON.stringify({
					info: { id: "opencode", directory: root },
					messages: [{ info: { role: "user" }, parts: [{ type: "text", text: "OpenCode prompt" }] }],
				}),
			);

			const handleImportCommand = vi.fn(async () => {});
			const handleExternalSessionImport = vi.fn(async () => {});
			const context: AutoImportCommandContext = {
				getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
				handleImportCommand,
				handleExternalSessionImport,
				showError: vi.fn(),
			};

			await interactiveModePrototype.handleAutoImportCommand.call(context, `/import "${piPath}"`);
			expect(handleImportCommand).toHaveBeenLastCalledWith(`/import "${piPath}"`);

			await interactiveModePrototype.handleAutoImportCommand.call(context, `/import "${claudePath}"`);
			expect(handleExternalSessionImport).toHaveBeenLastCalledWith(claudePath, "claude");

			await interactiveModePrototype.handleAutoImportCommand.call(context, `/import "${codexPath}"`);
			expect(handleExternalSessionImport).toHaveBeenLastCalledWith(codexPath, "codex");

			await interactiveModePrototype.handleAutoImportCommand.call(context, `/import "${openCodePath}"`);
			expect(handleExternalSessionImport).toHaveBeenLastCalledWith(openCodePath, "opencode");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("strips quotes from /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument('/import "path/to/session.jsonl"', "/import")).toBe(
			"path/to/session.jsonl",
		);
		expect(
			interactiveModePrototype.getPathCommandArgument('/import "path with spaces/session.jsonl"', "/import"),
		).toBe("path with spaces/session.jsonl");
	});

	it("preserves apostrophes in unquoted /import path arguments", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/import john's/session.jsonl", "/import")).toBe(
			"john's/session.jsonl",
		);
	});

	it("enforces command token boundaries", () => {
		expect(interactiveModePrototype.getPathCommandArgument("/important /tmp/session.jsonl", "/import")).toBe(
			undefined,
		);
		expect(interactiveModePrototype.getPathCommandArgument("/exporter out.html", "/export")).toBe(undefined);
		expect(interactiveModePrototype.getPathCommandArgument("/import /tmp/session.jsonl", "/import")).toBe(
			"/tmp/session.jsonl",
		);
	});

	it("passes unquoted path to agentConnection.importFromJsonl", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			stopWorkingLoader: vi.fn(),
			agentConnection: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
			importAndResumeSession: interactiveModePrototype.importAndResumeSession,
		};

		await interactiveModePrototype.handleImportCommand.call(context, '/import "path/to/session.jsonl"');

		expect(showExtensionConfirm).toHaveBeenCalledWith(
			"Import session",
			"Replace current session with path/to/session.jsonl?",
		);
		expect(importFromJsonl).toHaveBeenCalledWith("path/to/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: path/to/session.jsonl");
	});

	it("passes unquoted apostrophe path to agentConnection.importFromJsonl unchanged", async () => {
		const importFromJsonl = vi.fn(async () => ({ cancelled: false }));
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			stopWorkingLoader: vi.fn(),
			agentConnection: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError: vi.fn(async () => {
				throw new Error("unexpected fatal error");
			}),
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
			importAndResumeSession: interactiveModePrototype.importAndResumeSession,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import john's/session.jsonl");

		expect(importFromJsonl).toHaveBeenCalledWith("john's/session.jsonl");
		expect(showError).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Session imported from: john's/session.jsonl");
	});

	it("shows a non-fatal error when /import path does not exist", async () => {
		const importFromJsonl = vi.fn(async () => {
			throw new SessionImportFileNotFoundError("/tmp/missing-session.jsonl");
		});
		const showExtensionConfirm = vi.fn(async () => true);
		const showStatus = vi.fn();
		const showError = vi.fn();
		const handleFatalRuntimeError = vi.fn(async () => {
			throw new Error("unexpected fatal error");
		});

		const context: ImportCommandContext = {
			statusContainer: { clear: vi.fn() },
			stopWorkingLoader: vi.fn(),
			agentConnection: { importFromJsonl },
			showError,
			showStatus,
			showExtensionConfirm,
			renderCurrentSessionState: vi.fn(),
			handleFatalRuntimeError,
			promptForMissingSessionCwd: vi.fn(async () => undefined),
			getPathCommandArgument: interactiveModePrototype.getPathCommandArgument,
			importAndResumeSession: interactiveModePrototype.importAndResumeSession,
		};

		await interactiveModePrototype.handleImportCommand.call(context, "/import /tmp/missing-session.jsonl");

		expect(showError).toHaveBeenCalledWith("Failed to import session: File not found: /tmp/missing-session.jsonl");
		expect(showStatus).not.toHaveBeenCalled();
		expect(handleFatalRuntimeError).not.toHaveBeenCalled();
	});
});
