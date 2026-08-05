import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { AcpMcpSkillInstaller } from "../src/modes/acp/acp-mcp.js";
import { runAcpModeWithConnection } from "../src/modes/acp/acp-mode.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import { createHarness } from "./suite/harness.js";

function runtimeHostFor(session: unknown): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

describe("ACP MCP servers", () => {
	it("advertises HTTP support and configures session/new servers", async () => {
		const harness = await createHarness();
		const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const configureMcpServers = vi.fn();
		const modeDone = runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
			configureMcpServers,
		});
		const handle = acp
			.client({ name: "mcp-test-client" })
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		const initialized = await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		expect(initialized.agentCapabilities?.mcpCapabilities?.http).toBe(true);

		const server: acp.McpServer = {
			type: "http",
			name: "task-tools",
			url: "http://127.0.0.1:8000/mcp",
			headers: [{ name: "Authorization", value: "Bearer task" }],
		};
		await handle.agent.request("session/new", {
			cwd: harness.tempDir,
			mcpServers: [server],
		});
		expect(configureMcpServers).toHaveBeenCalledWith([server]);

		handle.close();
		await toAgent.writable.close().catch(() => undefined);
		await modeDone;
		harness.cleanup();
	}, 30_000);

	it(
		"installs HTTP and stdio servers as one temporary Python skill",
		{ tags: ["kernel-heavy"], timeout: 180_000 },
		async () => {
			const resourceRoot = mkdtempSync(join(tmpdir(), "prime-agent-acp-mcp-test-"));
			const resourceLoader = new DefaultResourceLoader({
				cwd: resourceRoot,
				agentDir: resourceRoot,
				bundledSkillsDir: null,
			});
			await resourceLoader.reload();
			const harness = await createHarness({ resourceLoader });
			const installer = new AcpMcpSkillInstaller(harness.session);
			try {
				installer.configure([
					{
						type: "http",
						name: "remote-tools",
						url: "https://tools.example/mcp",
						headers: [{ name: "X-Task", value: "one" }],
					},
					{
						name: "local-tools",
						command: "/usr/bin/tool-server",
						args: ["--stdio"],
						env: [{ name: "TASK", value: "two" }],
					},
				]);

				const connection = new InProcessAgentConnection(runtimeHostFor(harness.session));
				const resources = await connection.getResourceSnapshot();
				const skill = resources.skills.find((candidate) => candidate.name === "acp-mcp");
				expect(skill).toBeDefined();
				expect(harness.session.systemPrompt).toContain("remote-tools");
				expect(harness.session.systemPrompt).toContain("local-tools");

				const source = readFileSync(join(dirname(skill!.filePath), "src", "acp_mcp", "__init__.py"), "utf-8");
				expect(source).toContain("https://tools.example/mcp");
				expect(source).toContain("X-Task");
				expect(source).toContain("/usr/bin/tool-server");
				expect(source).toContain("TASK");
				const pyproject = readFileSync(join(dirname(skill!.filePath), "pyproject.toml"), "utf-8");
				expect(pyproject).not.toContain("prime-agent-runtime");

				const ipython = harness.session.agent.state.tools.find((tool) => tool.name === "ipython");
				expect(ipython).toBeDefined();
				const imported = await ipython!.execute("acp-mcp-import", {
					code: "print(acp_mcp.list_servers())",
				});
				const output = imported.content
					.filter((item): item is { type: "text"; text: string } => item.type === "text")
					.map((item) => item.text)
					.join("");
				expect(output).toContain("local-tools");
				expect(output).toContain("remote-tools");

				const skillDirectory = dirname(skill!.filePath);
				await harness.session.disposeAsync();
				installer.dispose();
				expect(existsSync(skillDirectory)).toBe(false);
			} finally {
				await harness.session.disposeAsync();
				installer.dispose();
				harness.cleanup();
				rmSync(resourceRoot, { recursive: true, force: true });
			}
		},
	);
});
