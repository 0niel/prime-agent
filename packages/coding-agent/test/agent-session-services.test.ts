import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSessionMessageController } from "../src/core/agent-messages.js";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("createAgentSessionFromServices", () => {
	const cleanupPaths: string[] = [];
	const unregisters: Array<() => void> = [];

	afterEach(() => {
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
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
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
						pendingMessageCount: 0,
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
			expect(session.handleAgentMessageHostRequest("agent_message.list")).toMatchObject({
				current: { activeSessionId: "current" },
				agents: [{ activeSessionId: "worker" }],
			});
		} finally {
			session.dispose();
		}
	});
});
