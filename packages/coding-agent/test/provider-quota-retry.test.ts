import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

describe("provider quota retry safety", () => {
	let server: Server | undefined;
	let session: AgentSession | undefined;

	afterEach(async () => {
		session?.dispose();
		if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
	});

	it("makes exactly one HTTP request for a quota-flavored 429 by default", async () => {
		let requestCount = 0;
		server = createServer((_request, response) => {
			requestCount++;
			response.writeHead(429, {
				"content-type": "application/json",
				"request-id": "req_http_quota",
			});
			response.end(
				JSON.stringify({
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "premium request quota exceeded",
					},
				}),
			);
		});
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
		const address = server.address() as AddressInfo;
		const model: Model<"anthropic-messages"> = {
			id: "claude-fable-5",
			name: "Claude Fable 5",
			api: "anthropic-messages",
			provider: "github-copilot",
			baseUrl: `http://127.0.0.1:${address.port}`,
			reasoning: false,
			input: ["text"],
			cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
			contextWindow: 1_000_000,
			maxTokens: 16_384,
		};
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(model.provider, "test-token");
		const result = await createAgentSession({
			model,
			authStorage,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			noTools: "all",
		});
		session = result.session;

		await session.prompt("trigger quota").catch(() => undefined);

		expect(requestCount).toBe(1);
		expect(session.isProviderQuotaCircuitOpen).toBe(true);
		const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
		expect(lastAssistant).toMatchObject({
			stopReason: "error",
			diagnostics: [
				{
					type: "provider_stream_failure",
					details: { kind: "quota", status: 429, requestId: "req_http_quota" },
				},
			],
		});
	});
});
