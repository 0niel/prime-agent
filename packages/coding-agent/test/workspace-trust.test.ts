import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAndLoadExtensions } from "../src/core/extensions/loader.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import {
	canonicalizeWorkspacePath,
	canPersistWorkspaceTrust,
	detectProjectScopedConfig,
	isAgentDirWithinWorkspace,
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

		it("merges concurrent mutations instead of clobbering with stale snapshots", () => {
			const otherDir = join(tempDir, "other");
			mkdirSync(otherDir, { recursive: true });
			WorkspaceTrustStore.create(agentDir).trust(projectDir);

			// Two processes load the same snapshot, then interleave mutations.
			const processA = WorkspaceTrustStore.create(agentDir);
			const processB = WorkspaceTrustStore.create(agentDir);
			processB.untrust(projectDir); // revoke first...
			processA.trust(otherDir); // ...then a stale-snapshot writer must not resurrect it

			const result = WorkspaceTrustStore.create(agentDir);
			expect(result.isTrusted(projectDir)).toBe(false);
			expect(result.isTrusted(otherDir)).toBe(true);
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

		it("ignores executable settings when the global file is the project file (aliased agentDir)", () => {
			// Portable setup: agentDir points at the project config directory, so
			// global and project settings are the same attacker-committed file.
			const aliasedAgentDir = configDir;
			writeProjectSettings({
				shellCommandPrefix: "echo pwned",
				mcpServers: { evil: { type: "stdio", command: "./evil" } },
			});
			const untrusted = SettingsManager.create(projectDir, aliasedAgentDir, { projectTrusted: false });
			expect(untrusted.getShellCommandPrefix()).toBeUndefined();
			expect(untrusted.getMcpServers()).toBeUndefined();

			const trusted = SettingsManager.create(projectDir, aliasedAgentDir, { projectTrusted: true });
			expect(trusted.getShellCommandPrefix()).toBe("echo pwned");
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
			writeProjectSettings({ extensions: [join(outsideDir, "evil.ts")] });
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir });

			await loader.reload();

			expect(existsSync(canaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);

			// Same fixture must load when trusted (proves the negative leg is real).
			trustProject();
			const trustedLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir });
			await trustedLoader.reload();
			expect(existsSync(canaryPath)).toBe(true);
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

		it("does not fall back to a project-controlled global SYSTEM.md when untrusted", async () => {
			// agentDir aliased into the project: the global fallback path is the
			// same committed file and must not bypass the project-trust guard.
			const aliasedAgentDir = configDir;
			writeFileSync(join(configDir, "SYSTEM.md"), "project system prompt");
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir: aliasedAgentDir });
			await loader.reload();
			expect(loader.getSystemPrompt()).toBeUndefined();

			// A trust store inside the workspace cannot vouch for it: even a
			// written trust entry keeps the workspace untrusted.
			WorkspaceTrustStore.create(aliasedAgentDir).trust(projectDir);
			const stillUntrustedLoader = new DefaultResourceLoader({ cwd: projectDir, agentDir: aliasedAgentDir });
			await stillUntrustedLoader.reload();
			expect(stillUntrustedLoader.getSystemPrompt()).toBeUndefined();
		});

		it("narrows a caller-provided trusted manager when the store is untrusted", async () => {
			const canaryPath = writeEvilExtension();
			const settingsManager = SettingsManager.create(projectDir, agentDir, { projectTrusted: true });
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir, settingsManager });

			await loader.reload();

			expect(settingsManager.isProjectTrusted()).toBe(false);
			expect(existsSync(canaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);
		});

		it("loads project extensions with a caller-provided manager when the store is trusted", async () => {
			const canaryPath = writeEvilExtension();
			trustProject();
			const settingsManager = SettingsManager.create(projectDir, agentDir);
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

			expect(text).toContain("project extensions (1 entry)");
			expect(text).toContain("shellCommandPrefix");
			expect(text).not.toContain("theme");
			expect(text).toContain("SYSTEM.md");
		});

		it("ignores malformed project settings", () => {
			writeFileSync(join(configDir, "settings.json"), "{ not json");
			expect(detectProjectScopedConfig(projectDir)).toEqual([]);
		});

		it("reports prompts and themes directories", () => {
			mkdirSync(join(configDir, "prompts"), { recursive: true });
			writeFileSync(join(configDir, "prompts", "review.md"), "prompt");
			mkdirSync(join(configDir, "themes"), { recursive: true });
			writeFileSync(join(configDir, "themes", "dark.json"), "{}");

			const text = detectProjectScopedConfig(projectDir)
				.map((finding) => finding.summary)
				.join("\n");

			expect(text).toContain("project prompt templates are auto-discovered");
			expect(text).toContain("project themes are auto-discovered");
		});

		it("reports an extensions directory that is itself a manifest package", () => {
			const extensionsDir = join(configDir, "extensions");
			mkdirSync(join(extensionsDir, "src"), { recursive: true });
			writeFileSync(join(extensionsDir, "src", "main.ts"), "export default function () {}\n");
			writeFileSync(join(extensionsDir, "package.json"), JSON.stringify({ pi: { extensions: ["./src/main.ts"] } }));

			const findings = detectProjectScopedConfig(projectDir);

			expect(findings.some((finding) => finding.summary.includes("project extensions (1 entry)"))).toBe(true);
		});

		it("reports manifest-based extensions", () => {
			const pkgDir = join(configDir, "extensions", "pkg-ext");
			mkdirSync(pkgDir, { recursive: true });
			writeFileSync(join(pkgDir, "main.ts"), "export default function () {}\n");
			writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ pi: { extensions: ["./main.ts"] } }));

			const findings = detectProjectScopedConfig(projectDir);

			expect(findings.some((finding) => finding.summary.includes("project extensions (1 entry)"))).toBe(true);
		});

		it("does not crash on malformed pi.extensions manifest entries", () => {
			const extensionsDir = join(configDir, "extensions");
			mkdirSync(extensionsDir, { recursive: true });
			writeFileSync(join(extensionsDir, "package.json"), JSON.stringify({ pi: { extensions: [null, 42, {}] } }));

			expect(() => detectProjectScopedConfig(projectDir)).not.toThrow();
		});

		it("treats an agent dir as inside a root-level workspace", () => {
			// The root workspace prefix must not become "//" and miss containment.
			expect(isAgentDirWithinWorkspace("/.prime/agent", "/")).toBe(true);
			expect(isAgentDirWithinWorkspace("/somewhere", "/")).toBe(true);
			expect(isAgentDirWithinWorkspace("/", "/")).toBe(true);
		});

		it("reports .agents/skills from ancestor directories up to the git root", () => {
			// Launch from a subdirectory; skills committed at the repo root are
			// discovered by the loader and must produce a finding.
			mkdirSync(join(projectDir, ".git"));
			mkdirSync(join(projectDir, ".agents", "skills", "evil"), { recursive: true });
			writeFileSync(join(projectDir, ".agents", "skills", "evil", "SKILL.md"), "---\nname: evil\n---\n");
			const subDir = join(projectDir, "packages", "sub");
			mkdirSync(subDir, { recursive: true });

			const findings = detectProjectScopedConfig(subDir);

			expect(findings.some((finding) => finding.summary.includes(".agents/skills"))).toBe(true);
		});
	});

	describe("package updates", () => {
		it("skips project package sources when untrusted", async () => {
			writeProjectSettings({ packages: ["npm:some-pkg"] });
			const untrusted = new DefaultPackageManager({
				cwd: projectDir,
				agentDir,
				settingsManager: SettingsManager.create(projectDir, agentDir, { projectTrusted: false }),
			});
			// The project-committed source is invisible, so it cannot be matched.
			await expect(untrusted.update("npm:some-pkg")).rejects.toThrow();

			const previousOffline = process.env.PI_OFFLINE;
			process.env.PI_OFFLINE = "1";
			try {
				const trusted = new DefaultPackageManager({
					cwd: projectDir,
					agentDir,
					settingsManager: SettingsManager.create(projectDir, agentDir, { projectTrusted: true }),
				});
				// Trusted: the source matches; offline mode short-circuits before npm.
				await expect(trusted.update("npm:some-pkg")).resolves.toBeUndefined();
			} finally {
				if (previousOffline === undefined) {
					delete process.env.PI_OFFLINE;
				} else {
					process.env.PI_OFFLINE = previousOffline;
				}
			}
		});
	});

	describe("aliased agent dir (portable setup)", () => {
		const evilSource = (canaryPath: string) => `
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(canaryPath)}, "executed", "utf-8");
export default function () {}
`;

		it("treats global-scope extensions as project-controlled when untrusted", async () => {
			// agentDir == project config dir: the "global" extensions directory
			// is the same committed directory as the project one.
			const aliasedAgentDir = configDir;
			const canaryPath = join(tempDir, "aliased-canary.txt");
			mkdirSync(join(configDir, "extensions"), { recursive: true });
			writeFileSync(join(configDir, "extensions", "evil.ts"), evilSource(canaryPath));
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir: aliasedAgentDir });

			await loader.reload();

			expect(existsSync(canaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);
		});

		it("ignores aliased global settings-driven extension paths and packages when untrusted", async () => {
			const aliasedAgentDir = configDir;
			const canaryPath = join(tempDir, "aliased-canary.txt");
			const toolsDir = join(projectDir, "tools");
			mkdirSync(toolsDir, { recursive: true });
			writeFileSync(join(toolsDir, "evil.ts"), evilSource(canaryPath));
			// The single committed settings.json is simultaneously the global and
			// project file in an aliased setup. Absolute path so the entry really
			// resolves to the committed file.
			writeProjectSettings({ extensions: [join(toolsDir, "evil.ts")], packages: ["npm:some-pkg"] });
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir: aliasedAgentDir });

			await loader.reload();

			expect(existsSync(canaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);

			const manager = new DefaultPackageManager({
				cwd: projectDir,
				agentDir: aliasedAgentDir,
				settingsManager: SettingsManager.create(projectDir, aliasedAgentDir, { projectTrusted: false }),
			});
			await expect(manager.update("npm:some-pkg")).rejects.toThrow();
		});

		it("stays untrusted when the trust store lives inside the workspace", async () => {
			const aliasedAgentDir = configDir;
			const canaryPath = join(tempDir, "aliased-canary.txt");
			mkdirSync(join(configDir, "extensions"), { recursive: true });
			writeFileSync(join(configDir, "extensions", "evil.ts"), evilSource(canaryPath));
			WorkspaceTrustStore.create(aliasedAgentDir).trust(projectDir);
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir: aliasedAgentDir });

			await loader.reload();

			expect(isWorkspaceTrusted(projectDir, aliasedAgentDir)).toBe(false);
			expect(existsSync(canaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);
		});

		it("ignores a committed trust store that trusts its own workspace", async () => {
			// Simulate a checkout that ships its own trusted-workspaces.json
			// outside .prime/agent but still inside the workspace tree.
			const committedAgentDir = join(projectDir, ".agent-data");
			mkdirSync(committedAgentDir, { recursive: true });
			writeFileSync(
				join(committedAgentDir, "trusted-workspaces.json"),
				JSON.stringify({ version: 1, trusted: [canonicalizeWorkspacePath(projectDir)] }, null, 2),
			);
			const canaryPath = join(tempDir, "committed-store-canary.txt");
			mkdirSync(join(configDir, "extensions"), { recursive: true });
			writeFileSync(join(configDir, "extensions", "evil.ts"), evilSource(canaryPath));
			// A "global" extensions directory at the non-conventional agent dir is
			// checkout-controlled too and must not execute either.
			const globalCanaryPath = join(tempDir, "committed-store-global-canary.txt");
			mkdirSync(join(committedAgentDir, "extensions"), { recursive: true });
			writeFileSync(join(committedAgentDir, "extensions", "evil2.ts"), evilSource(globalCanaryPath));

			expect(canPersistWorkspaceTrust(projectDir, committedAgentDir)).toBe(false);
			expect(isWorkspaceTrusted(projectDir, committedAgentDir)).toBe(false);
			const loader = new DefaultResourceLoader({ cwd: projectDir, agentDir: committedAgentDir });
			await loader.reload();
			expect(existsSync(canaryPath)).toBe(false);
			expect(existsSync(globalCanaryPath)).toBe(false);
			expect(loader.getExtensions().extensions).toEqual([]);
		});
	});

	describe("home-directory cwd", () => {
		it("does not treat the user's own global config as hostile when cwd is the home directory", () => {
			// Fake HOME so the default agent dir lives under the temp dir, then
			// run with cwd == that home: project config dir == global agent dir.
			const fakeHome = join(tempDir, "home");
			mkdirSync(join(fakeHome, ".prime", "agent"), { recursive: true });
			writeFileSync(
				join(fakeHome, ".prime", "agent", "settings.json"),
				JSON.stringify({ shellCommandPrefix: "my-own-prefix" }, null, 2),
			);
			const previousHome = process.env.HOME;
			process.env.HOME = fakeHome;
			try {
				const manager = SettingsManager.create(fakeHome, join(fakeHome, ".prime", "agent"), {
					projectTrusted: false,
				});
				expect(manager.isGlobalConfigAliasedToProject()).toBe(false);
				expect(manager.getShellCommandPrefix()).toBe("my-own-prefix");
				expect(detectProjectScopedConfig(fakeHome)).toEqual([]);
			} finally {
				if (previousHome === undefined) {
					delete process.env.HOME;
				} else {
					process.env.HOME = previousHome;
				}
			}
		});
	});

	describe("discoverAndLoadExtensions (public API)", () => {
		it("skips project extensions for untrusted workspaces", async () => {
			mkdirSync(join(configDir, "extensions"), { recursive: true });
			writeFileSync(join(configDir, "extensions", "evil.ts"), "export default function () {}\n");

			const untrusted = await discoverAndLoadExtensions([], projectDir, agentDir);
			expect(untrusted.extensions).toEqual([]);

			trustProject();
			const trusted = await discoverAndLoadExtensions([], projectDir, agentDir);
			expect(trusted.extensions.map((e) => e.path)).toEqual([join(configDir, "extensions", "evil.ts")]);
		});
	});
});
