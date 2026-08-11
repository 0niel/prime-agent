import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_MESSAGE_SKILL_NAME, type AgentSessionMessageController } from "../src/core/agent-messages.js";
import { AGENT_OBSERVE_SKILL_NAME, type AgentObserveController } from "../src/core/agent-observe.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { admitProjectMcpDeclarations } from "../src/core/mcp/mcp-project-trust.js";
import { createMcpProjectTrustAuthority } from "../src/core/mcp/project-trust-authority.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

describe("createAgentSessionFromServices", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (unregisters.length > 0) {
			unregisters.pop()?.();
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path && existsSync(path)) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("shows the telemetry disclosure independently of the Herdr reporter", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-telemetry-notice-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			noBuiltinHerdrReporter: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).toContainEqual(
			expect.objectContaining({ type: "info", message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(true);
	});

	it("honors an explicit daemon-carried telemetry opt-out", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-daemon-telemetry-opt-out-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const settingsManager = SettingsManager.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager,
			telemetryDisabled: true,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});

		expect(services.diagnostics).not.toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("pseudonymous usage") }),
		);
		expect(settingsManager.getTelemetryNoticeShown()).toBe(false);

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			telemetryDisabled: true,
		});
		try {
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("does not install top-level telemetry for a resumed child session", async () => {
		vi.stubEnv("PRIME_AGENT_TELEMETRY", "1");
		const tempDir = join(tmpdir(), `pi-session-child-telemetry-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			settingsManager: SettingsManager.inMemory({ telemetry: { noticeShown: true } }),
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.newSession({ rlmDepth: 1 });

		const { session } = await createAgentSessionFromServices({ services, sessionManager });
		try {
			expect(session.rlmDepth).toBe(1);
			expect(existsSync(join(tempDir, "telemetry.json"))).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("forwards daemon-backed agent message controllers into AgentSession", async () => {
		const tempDir = join(tmpdir(), `pi-session-services-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const faux = registerFauxProvider();
		unregisters.push(() => faux.unregister());

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
				skillsOverride: () => ({
					skills: [
						{
							name: AGENT_MESSAGE_SKILL_NAME,
							description: "hidden agent message skill",
							filePath: "<test:agent-message>",
							baseDir: tempDir,
							sourceInfo: createSyntheticSourceInfo("<test:agent-message>", { source: "test" }),
							disableModelInvocation: true,
							kind: "python" as const,
							python: {
								importName: "agent_message",
								packagePath: tempDir,
								pyprojectPath: join(tempDir, "pyproject.toml"),
							},
						},
					],
					diagnostics: [],
				}),
			},
		});
		services.modelRegistry.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models,
		});

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current", runtimeKind: "top-level" },
				agents: [
					{
						activeSessionId: "worker",
						sessionId: "session-worker",
						runtimeKind: "top-level",
						cwd: tempDir,
						isStreaming: false,
						unfinishedActionCount: 0,
					},
				],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			model: faux.getModel(),
			agentMessageController,
		});

		try {
			expect(() => session.handleAgentMessageHostRequest("agent_message.list")).toThrow(
				"unknown agent message request",
			);
			expect(
				(
					session as unknown as {
						_createKernelHostHandlers(): Record<string, unknown>;
					}
				)._createKernelHostHandlers(),
			).not.toHaveProperty("agent_message.send");
		} finally {
			session.dispose();
		}
	});

	it("captures a frozen user and globally admitted project snapshot without exposing project endpoints", async () => {
		const temporary = mkdtempSync(join(tmpdir(), "pi-session-project-snapshot-"));
		const cwd = realpathSync.native(temporary);
		const agentDir = join(temporary, "agent");
		mkdirSync(join(cwd, ".prime", "agent"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cleanupPaths.push(temporary);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mcpProjectTrustPolicy: { revision: "r1", allowedProjectDirectories: [cwd] },
				mcpDeclarations: {
					version: 1,
					servers: { user: { name: "user", url: "https://user.example/mcp", enabled: true } },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".prime", "agent", "settings.json"),
			JSON.stringify({
				mcpDeclarations: {
					version: 1,
					servers: { project: { name: "project", url: "https://project.example/mcp", enabled: true } },
				},
			}),
		);
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const snapshot = services.mcpManager.getDeclarationSnapshot()!;
		expect(snapshot.declarations).toHaveProperty("user");
		expect(snapshot.declarations).toHaveProperty("project");
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.declarations)).toBe(true);
		expect(Object.isFrozen(snapshot.declarations.project)).toBe(true);
		expect(services.mcpManager.listStatus().map((status) => status.server)).not.toContain("project");
		expect(services.mcpManager.hostHandlers()).not.toHaveProperty("mcp.declarations");
	});

	it("makes a root-revoked explicit admission inert before the service reader runs", async () => {
		const temporary = mkdtempSync(join(tmpdir(), "pi-session-project-revoked-"));
		const cwd = realpathSync.native(temporary);
		const old = `${cwd}-old`;
		const replacement = `${cwd}-replacement`;
		mkdirSync(replacement);
		cleanupPaths.push(temporary);
		cleanupPaths.push(old);
		const authority = createMcpProjectTrustAuthority({ revision: "r1", allowedProjectDirectories: [cwd] });
		const admission = admitProjectMcpDeclarations(cwd, authority)!;
		const settingsManager = SettingsManager.inMemory({
			mcpDeclarations: {
				version: 1,
				servers: { user: { name: "user", url: "https://user.example/mcp", enabled: true } },
			},
		});
		renameSync(cwd, old);
		renameSync(replacement, cwd);
		const services = await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			authStorage: AuthStorage.inMemory(),
			settingsManager,
			projectMcpAdmission: admission,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const snapshot = services.mcpManager.getDeclarationSnapshot()!;
		expect(snapshot.declarations).toHaveProperty("user");
		expect(snapshot.declarations).not.toHaveProperty("project");
		expect(services.mcpManager.listStatus().map((status) => status.server)).not.toContain("project");
		expect(services.mcpManager.hostHandlers()).not.toHaveProperty("mcp.declarations");
	});

	it("fails closed for a mixed global project policy without reading project declarations", async () => {
		const tempDir = join(
			tmpdir(),
			`pi-session-malformed-mcp-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		const agentDir = join(tempDir, "agent");
		mkdirSync(join(tempDir, ".prime", "agent"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		cleanupPaths.push(tempDir);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				mcpProjectTrustPolicy: { revision: "r1", allowedProjectDirectories: [tempDir, 7] },
				mcpDeclarations: {
					version: 1,
					servers: { "user-only": { name: "user-only", url: "https://user.example/mcp", enabled: true } },
				},
			}),
		);
		writeFileSync(
			join(tempDir, ".prime", "agent", "settings.json"),
			JSON.stringify({
				mcpDeclarations: {
					version: 1,
					servers: { "project-only": { name: "project-only", url: "https://project.example/mcp", enabled: true } },
				},
			}),
		);
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir,
			authStorage: AuthStorage.inMemory(),
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const declarations = services.mcpManager.getDeclarationSnapshot()!.declarations;
		expect(declarations).toHaveProperty("user-only");
		expect(declarations).not.toHaveProperty("project-only");
	});

	it("uses global MCP integrations while preserving the merged legacy view", async () => {
		const tempDir = join(tmpdir(), `pi-session-global-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const stored: Record<"global" | "project", string | undefined> = {
			global: JSON.stringify({
				mcpServers: { globalOnly: { type: "http", url: "https://global.example/mcp" } },
				mcpDeclarations: {
					version: 1,
					servers: { inert: { name: "inert", url: "https://declaration.example/mcp", enabled: true } },
				},
			}),
			project: JSON.stringify({ mcpServers: { projectOnly: { type: "http", url: "https://project.example/mcp" } } }),
		};
		const storage: SettingsStorage = {
			withLock(scope, callback) {
				const next = callback(stored[scope]);
				if (next !== undefined) stored[scope] = next;
			},
		};
		const settingsManager = SettingsManager.fromStorage(storage);
		expect(settingsManager.getMcpServers()).toHaveProperty("projectOnly");
		expect(settingsManager.getGlobalMcpServers()).toHaveProperty("globalOnly");
		expect(settingsManager.getGlobalMcpServers()).not.toHaveProperty("projectOnly");

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage: AuthStorage.inMemory(),
			settingsManager,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		expect(services.mcpManager.listStatus().map((status) => status.server)).toContain("globalOnly");
		expect(services.mcpManager.listStatus().map((status) => status.server)).not.toContain("projectOnly");
		const declarations = services.mcpManager.getDeclarationSnapshot()!;
		expect(declarations.declarations).toHaveProperty("inert");
		expect(Object.isFrozen(declarations)).toBe(true);
		expect(Object.isFrozen(declarations.declarations.inert)).toBe(true);
		expect(services.mcpManager.hostHandlers()).not.toHaveProperty("mcp.declarations");
	});

	it("hides daemon-backed orchestration skills unless their host bridges are available", async () => {
		const tempDir = join(tmpdir(), `pi-session-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		const authStorage = AuthStorage.inMemory();
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noPromptTemplates: true,
				noThemes: true,
			},
		});

		const createSession = async (options: Parameters<typeof createAgentSessionFromServices>[0]) => {
			const { session } = await createAgentSessionFromServices(options);
			return session;
		};
		const visibleSkillNames = (session: unknown) =>
			(
				session as {
					_modelVisibleSkills(): Array<{ name: string }>;
				}
			)
				._modelVisibleSkills()
				.map((skill) => skill.name);
		const kernelHostHandlers = (session: unknown) =>
			(
				session as {
					_createKernelHostHandlers(): Record<string, unknown>;
				}
			)._createKernelHostHandlers();

		const withoutControllers = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-without")),
		});
		try {
			expect(visibleSkillNames(withoutControllers)).not.toContain(AGENT_MESSAGE_SKILL_NAME);
			expect(visibleSkillNames(withoutControllers)).not.toContain(AGENT_OBSERVE_SKILL_NAME);
		} finally {
			withoutControllers.dispose();
		}

		const agentObserveController: AgentObserveController = {
			listAgents: () => ({
				current: {
					activeSessionId: "current",
					sessionId: "session-current",
					runtimeKind: "top-level",
					cwd: tempDir,
					status: "idle",
					isCurrent: true,
					isStreaming: false,
					isCompacting: false,
					attachedClients: 1,
					messageCount: 0,
					queuedCount: 0,
					isSessionActive: false,
				},
				agents: [],
			}),
			getAgent: () => {
				throw new Error("not used");
			},
			recentMessages: () => {
				throw new Error("not used");
			},
		};
		const withControllers = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-with")),
			agentObserveController,
		});
		try {
			expect(visibleSkillNames(withControllers)).toContain(AGENT_OBSERVE_SKILL_NAME);
			expect(visibleSkillNames(withControllers)).not.toContain(AGENT_MESSAGE_SKILL_NAME);
		} finally {
			withControllers.dispose();
		}

		const agentMessageController: AgentSessionMessageController = {
			listAgents: () => ({
				current: { activeSessionId: "current", sessionId: "session-current" },
				agents: [],
			}),
			sendAgentMessage: async () => {
				throw new Error("not used");
			},
		};
		const withMessageController = await createSession({
			services,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions-with-message")),
			agentMessageController,
		});
		try {
			expect(visibleSkillNames(withMessageController)).toContain(AGENT_MESSAGE_SKILL_NAME);
			expect(kernelHostHandlers(withMessageController)).toHaveProperty("agent_message.send");
		} finally {
			withMessageController.dispose();
		}
	});
});
