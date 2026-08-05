import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { KernelManager, type KernelSentAgentMessage } from "../src/core/kernel/index.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledAgentMessageSkill(): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), "agent-message");
	return {
		name: "agent-message",
		importName: "agent_message",
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

type LateHandlerRetentionHost = {
	lateSentAgentMessageHandlers: Map<string, (message: KernelSentAgentMessage) => void>;
	registerLateSentAgentMessageHandler: (
		requestMessageId: string,
		handler: (message: KernelSentAgentMessage) => void,
	) => void;
};

describe("agent-message skill over the kernel host bridge", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-message-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("lists agents and sends without exposing a spoofable sender", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.list": async (payload) => {
					requests.push({ type: "agent_message.list", payload });
					return {
						current: { activeSessionId: "alpha", sessionId: "session-alpha" },
						agents: [
							{
								activeSessionId: "alpha",
								sessionId: "session-alpha",
								cwd: tempDir,
								isStreaming: false,
								unfinishedActionCount: 0,
							},
							{
								activeSessionId: "beta",
								sessionId: "session-beta",
								sessionName: "Beta",
								cwd: tempDir,
								isStreaming: true,
								unfinishedActionCount: 1,
							},
						],
					};
				},
				"agent_message.roster": async (payload) => {
					requests.push({ type: "agent_message.roster", payload });
					return {
						current: { name: "alpha", id: "session-alpha", depth: 0 },
						entries: [{ relationship: "sibling", name: "Beta", id: "session-beta", depth: 0, status: "idle" }],
					};
				},
				"agent_message.send": async (payload) => {
					requests.push({ type: "agent_message.send", payload });
					return {
						id: "agentmsg-test",
						source: "agent_message",
						target: { activeSessionId: payload.target, sessionId: "session-beta", sessionName: "Beta" },
						from: { activeSessionId: "alpha", sessionId: "session-alpha" },
						message: payload.message,
						deliveryStatus: "queued",
						queuedAt: "2026-06-16T00:00:00.000Z",
						deliveryMode: payload.mode,
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
agents = await agent_message.list_agents()
roster = await agent_message.roster()
receipt = await agent_message.send("beta", "hello beta", mode="follow_up")
print(json.dumps({"agents": agents, "roster": roster, "receipt": receipt}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim());
		expect(output.agents.agents).toHaveLength(2);
		expect(output.roster).toMatchObject({
			current: { id: "session-alpha", depth: 0 },
			entries: [{ relationship: "sibling", id: "session-beta", status: "idle" }],
		});
		expect(output.receipt).toMatchObject({
			id: "agentmsg-test",
			source: "agent_message",
			message: "hello beta",
			deliveryStatus: "queued",
			deliveryMode: "follow_up",
		});
		expect(result.sentAgentMessages).toEqual([
			{
				id: "agentmsg-test",
				message: "hello beta",
				deliveryStatus: "queued",
				target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
			},
		]);
		expect(requests[0]).toMatchObject({ type: "agent_message.list", payload: { type: "agent_message.list" } });
		expect(requests[1]).toMatchObject({ type: "agent_message.roster", payload: { type: "agent_message.roster" } });
		expect(requests[2]).toMatchObject({
			type: "agent_message.send",
			payload: {
				type: "agent_message.send",
				target: "beta",
				message: "hello beta",
				mode: "follow_up",
			},
		});
		expect(requests[2].payload).not.toHaveProperty("from");
	});

	it("validates mode before sending to the host", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async () => {
					throw new Error("should not reach host");
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
try:
    await agent_message.send("beta", "hello", mode="broadcast")
except ValueError as error:
    print(f"ValueError: {error}")
`);
		expect(result.status).toBe("ok");
		expect(result.stdout.trim()).toBe('ValueError: mode must be "auto", "follow_up", or "steer"');
	});

	it("captures sent messages from detached tasks after the cell is idle", async () => {
		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledAgentMessageSkill()],
			hostHandlers: {
				"agent_message.send": async (payload) => ({
					id: "agentmsg-background",
					source: "agent_message",
					target: { activeSessionId: payload.target, sessionId: "session-beta", sessionName: "Beta" },
					message: payload.message,
					deliveryStatus: "delivered",
					deliveredAt: "2026-07-10T00:00:00.000Z",
					deliveryMode: payload.mode,
				}),
			},
		});

		const manager = await provisioner.ensure();
		let resolveLateMessage!: (message: KernelSentAgentMessage) => void;
		const lateMessage = new Promise<KernelSentAgentMessage>((resolve) => {
			resolveLateMessage = resolve;
		});
		const result = await manager.execute(
			`async def send_later():
    await asyncio.sleep(0.05)
    await agent_message.send("beta", "background hello")

background_send = asyncio.create_task(send_later())`,
			{ onLateSentAgentMessage: (message) => resolveLateMessage(message) },
		);

		expect(result.status).toBe("ok");
		expect(result.sentAgentMessages).toBeUndefined();
		await expect(lateMessage).resolves.toEqual({
			id: "agentmsg-background",
			message: "background hello",
			deliveryStatus: "delivered",
			target: { activeSessionId: "beta", sessionId: "session-beta", sessionName: "Beta" },
		});
	});

	it("bounds retained handlers for late sent messages", async () => {
		const manager = new KernelManager({ cwd: tempDir });
		const host = manager as unknown as LateHandlerRetentionHost;
		const handler = () => {};

		for (let index = 0; index < 300; index += 1) {
			host.registerLateSentAgentMessageHandler(`request-${index}`, handler);
		}

		expect(host.lateSentAgentMessageHandlers.size).toBe(256);
		expect(host.lateSentAgentMessageHandlers.has("request-0")).toBe(false);
		expect(host.lateSentAgentMessageHandlers.has("request-299")).toBe(true);
		await manager.dispose();
	});
});
