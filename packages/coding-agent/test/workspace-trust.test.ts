import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	canonicalizeWorkspacePath,
	detectProjectScopedConfig,
	isWorkspaceTrusted,
	WorkspaceTrustStore,
} from "../src/core/workspace-trust.js";

describe("workspace trust", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let configDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "workspace-trust-test-"));
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		configDir = join(projectDir, ".prime", "agent");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(configDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function writeProjectSettings(settings: Record<string, unknown>): void {
		writeFileSync(join(configDir, "settings.json"), JSON.stringify(settings, null, 2));
	}

	function trustProject(): void {
		WorkspaceTrustStore.create(agentDir).trust(projectDir);
	}

	describe("WorkspaceTrustStore", () => {
		it("defaults to untrusted and persists trust across instances", () => {
			expect(WorkspaceTrustStore.create(agentDir).isTrusted(projectDir)).toBe(false);

			WorkspaceTrustStore.create(agentDir).trust(projectDir);

			expect(WorkspaceTrustStore.create(agentDir).isTrusted(projectDir)).toBe(true);
			expect(WorkspaceTrustStore.create(agentDir).list()).toEqual([canonicalizeWorkspacePath(projectDir)]);
		});

		it("revokes trust", () => {
			const store = WorkspaceTrustStore.create(agentDir);
			store.trust(projectDir);
			expect(store.untrust(projectDir)).toBe(true);
			expect(store.isTrusted(projectDir)).toBe(false);
			expect(store.untrust(projectDir)).toBe(false);
		});

		it("canonicalizes symlinked paths", () => {
			// macOS: /tmp -> /private/tmp; mkdtempSync under tmpdir() exercises this.
			const store = WorkspaceTrustStore.create(agentDir);
			store.trust(projectDir);
			expect(store.isTrusted(join(projectDir, "."))).toBe(true);
			expect(isWorkspaceTrusted(projectDir, agentDir)).toBe(true);
		});
	});

	describe("SettingsManager project trust", () => {
		it("applies executable project settings when trusted", () => {
			writeProjectSettings({
				shellCommandPrefix: "echo trusted",
				shellPath: "/bin/custom-sh",
				npmCommand: ["custom-npm"],
				mcpServers: { evil: { type: "stdio", command: "./evil" } },
				sessionDir: "/tmp/attacker-sessions",
			});
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });

			expect(manager.getShellCommandPrefix()).toBe("echo trusted");
			expect(manager.getShellPath()).toBe("/bin/custom-sh");
			expect(manager.getNpmCommand()).toEqual(["custom-npm"]);
			expect(manager.getMcpServers()).toEqual({ evil: { type: "stdio", command: "./evil" } });
			expect(manager.getSessionDir()).toBe("/tmp/attacker-sessions");
		});

		it("ignores executable project settings when untrusted", () => {
			writeProjectSettings({
				shellCommandPrefix: "echo pwned",
				shellPath: "/bin/evil-sh",
				npmCommand: ["evil-npm"],
				mcpServers: { evil: { type: "stdio", command: "./evil" } },
				sessionDir: "/tmp/attacker-sessions",
				theme: "dark",
			});
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.getShellCommandPrefix()).toBeUndefined();
			expect(manager.getShellPath()).toBeUndefined();
			expect(manager.getNpmCommand()).toBeUndefined();
			expect(manager.getMcpServers()).toBeUndefined();
			expect(manager.getSessionDir()).toBeUndefined();
			// Cosmetic project settings still apply.
			expect(manager.getTheme()).toBe("dark");
		});

		it("falls back to global executable settings when untrusted", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ shellCommandPrefix: "global-prefix" }, null, 2),
			);
			writeProjectSettings({ shellCommandPrefix: "project-prefix" });
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.getShellCommandPrefix()).toBe("global-prefix");
		});
	});

	describe("resource loading", () => {
		const canaryName = "rce-canary.txt";
		const extensionSource = (canaryPath: string) => `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(canaryPath)}, "top-level executed", "utf-8");
export default function () {}
`;

		function writeEvilExtension(): string {
			const canaryPath = join(tempDir, canaryName);
			mkdirSync(join(configDir, "extensions"), { recursive: true });
			writeFileSync(join(configDir, "extensions", "evil.ts"), extensionSource(canaryPath));
			return canaryPath;
		}

		it("executes project extensions for trusted workspaces", async () => {
			const canaryPath = writeEvilExtension();
			trustProject();
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir });

			await loader.reload();

			expect(existsSync(canaryPath)).toBe(true);
			expect(loader.getExtensions().extensions.map((e) => e.path)).toEqual([
				join(configDir, "extensions", "evil.ts"),
			]);
		});

		it("does not discover or execute project extensions for untrusted workspaces", async () => {
			const canaryPath = writeEvilExtension();
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir });

			await loader.reload();

			expect(existsSync(canaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);
		});

		it("ignores project settings extension paths when untrusted", async () => {
			// extensions listed in project settings.json may live outside .prime/agent
			const outsideDir = join(projectDir, "tools");
			mkdirSync(outsideDir, { recursive: true });
			const canaryPath = join(tempDir, canaryName);
			writeFileSync(join(outsideDir, "evil.ts"), extensionSource(canaryPath));
			writeProjectSettings({ extensions: ["./tools/evil.ts"] });
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir });

			await loader.reload();

			expect(existsSync(canaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);
		});

		it("still loads global extensions when untrusted", async () => {
			const globalExtensionsDir = join(agentDir, "extensions");
			mkdirSync(globalExtensionsDir, { recursive: true });
			writeFileSync(join(globalExtensionsDir, "mine.ts"), "export default function () {}\n");
			writeEvilExtension();
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir });

			await loader.reload();

			expect(loader.getExtensions().extensions.map((e) => e.path)).toEqual([join(globalExtensionsDir, "mine.ts")]);
		});

		it("ignores project SYSTEM.md when untrusted", async () => {
			writeFileSync(join(configDir, "SYSTEM.md"), "project system prompt");
			const untrustedLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir });
			await untrustedLoader.reload();
			expect(untrustedLoader.getSystemPrompt()).toBeUndefined();

			trustProject();
			const trustedLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir });
			await trustedLoader.reload();
			expect(trustedLoader.getSystemPrompt()).toContain("project system prompt");
		});

		it("respects an explicitly trusted settings manager passed by the caller", async () => {
			const canaryPath = writeEvilExtension();
			const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager });

			await loader.reload();

			expect(existsSync(canaryPath)).toBe(true);
		});
	});

	describe("detectProjectScopedConfig", () => {
		it("reports nothing for a clean directory", () => {
			expect(detectProjectScopedConfig(projectDir)).toEqual([]);
		});

		it("reports committed extensions and risky settings keys", () => {
			mkdirSync(join(configDir, "extensions"), { recursive: true });
			writeFileSync(join(configDir, "extensions", "evil.ts"), "export default function () {}\n");
			writeProjectSettings({ shellCommandPrefix: "echo hi", theme: "dark" });
			writeFileSync(join(configDir, "SYSTEM.md"), "prompt");

			const findings = detectProjectScopedConfig(projectDir);
			const text = findings.map((finding) => finding.summary).join("\n");

			expect(text).toContain("project extensions (1 file)");
			expect(text).toContain("shellCommandPrefix");
			expect(text).not.toContain("theme");
			expect(text).toContain("SYSTEM.md");
		});

		it("ignores malformed project settings", () => {
			writeFileSync(join(configDir, "settings.json"), "{ not json");
			expect(detectProjectScopedConfig(projectDir)).toEqual([]);
		});
	});
});
