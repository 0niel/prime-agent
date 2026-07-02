import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import type { PythonSkillRuntimeInfo } from "../src/core/skills.js";
import { IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function bundledPythonSkill(name: string, importName: string): PythonSkillRuntimeInfo {
	const packagePath = join(getBundledSkillsDir(), name);
	return {
		name,
		importName,
		packagePath,
		pyprojectPath: join(packagePath, "pyproject.toml"),
	};
}

describe("orchestration heartbeat skill over bundled host bridges", () => {
	let tempDir: string;
	let provisioner: IpythonKernelProvisioner | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-orchestration-heartbeat-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await provisioner?.dispose();
		provisioner = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates then refreshes a labeled RLM heartbeat from active session observations", async () => {
		const requests: Array<{ type: string; payload: Record<string, unknown> }> = [];
		let hasHeartbeat = false;
		let missingOnce = false;
		let scheduleExpression = "every 5m";

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [bundledPythonSkill("orchestration-heartbeat", "orchestration_heartbeat")],
			hostHandlers: {
				"agent_observe.list": async (payload) => {
					requests.push({ type: "agent_observe.list", payload });
					return {
						current: { sessionName: "orch", sessionId: "sess-orch", activeSessionId: "active-orch" },
						agents: [
							{
								sessionName: "orch",
								sessionId: "sess-orch",
								activeSessionId: "active-orch",
								cwd: "/repo/orch",
								status: "idle",
								isStreaming: false,
								pendingMessageCount: 0,
							},
							{
								sessionName: "autoenv",
								sessionId: "sess-autoenv",
								activeSessionId: "active-autoenv",
								cwd: "/repo/autoenv",
								status: "tool",
								isStreaming: false,
								pendingMessageCount: 1,
							},
							{
								sessionName: "emulatorBench",
								sessionId: "sess-emulator",
								activeSessionId: "active-emulator",
								cwd: "/repo/emulator",
								status: "idle",
								isStreaming: false,
								pendingMessageCount: 0,
							},
						],
					};
				},
				"rlm_heartbeat.list": async (payload) => {
					requests.push({ type: "rlm_heartbeat.list", payload });
					return {
						heartbeats: hasHeartbeat
							? [
									{
										id: "job-orch",
										status: "active",
										label: "orchestrator",
										instruction: "old instruction",
										schedule: { kind: "interval", expression: scheduleExpression },
									},
									{
										id: "job-missing",
										status: "active",
										label: "missing-on-update",
										instruction: "old instruction",
										schedule: { kind: "interval", expression: scheduleExpression },
									},
									{
										id: "job-paused",
										status: "paused",
										label: "paused-orchestrator",
										instruction: "old instruction",
										schedule: { kind: "interval", expression: scheduleExpression },
									},
									{
										id: "job-plain",
										status: "active",
										label: "plain-schedule",
										instruction: "old instruction",
										schedule: { kind: "interval", expression: "10m" },
									},
								]
							: [],
					};
				},
				"rlm_heartbeat.create": async (payload) => {
					requests.push({ type: "rlm_heartbeat.create", payload });
					hasHeartbeat = true;
					scheduleExpression = String(payload.interval ?? "5m").startsWith("every ")
						? String(payload.interval)
						: `every ${payload.interval ?? "5m"}`;
					return {
						heartbeat: {
							id: "job-orch",
							status: "active",
							label: payload.label,
							instruction: payload.instruction,
							schedule: { kind: "interval", expression: scheduleExpression },
						},
					};
				},
				"rlm_heartbeat.update": async (payload) => {
					requests.push({ type: "rlm_heartbeat.update", payload });
					if (payload.label === "missing-on-update" && !missingOnce) {
						missingOnce = true;
						return { heartbeat: null };
					}
					if (payload.interval) {
						scheduleExpression = String(payload.interval).startsWith("every ")
							? String(payload.interval)
							: `every ${payload.interval}`;
					}
					return {
						heartbeat: {
							id: payload.id,
							status: "active",
							label: payload.label,
							instruction: payload.instruction,
							schedule: { kind: "interval", expression: scheduleExpression },
						},
					};
				},
			},
		});

		const manager = await provisioner.ensure();
		const result = await manager.execute(`
import json
created = await orchestration_heartbeat.initialize(focus="keep long-running sessions moving")
updated = await orchestration_heartbeat.initialize(interval="10m")
try:
    await orchestration_heartbeat.initialize(interval="10m", label="missing-on-update")
except RuntimeError as error:
    missing_once_error = str(error)
paused = await orchestration_heartbeat.initialize(interval="10m", label="paused-orchestrator")
refreshed = await orchestration_heartbeat.initialize(interval="10m")
plain = await orchestration_heartbeat.initialize(interval="every 10m", label="plain-schedule")
print(json.dumps({
    "created_action": created["action"],
    "updated_action": updated["action"],
    "missing_once_error": missing_once_error,
    "paused_action": paused["action"],
    "refreshed_action": refreshed["action"],
    "plain_action": plain["action"],
    "created_label": created["heartbeat"]["label"],
    "updated_label": updated["heartbeat"]["label"],
    "session_names": [agent.get("sessionName") for agent in updated["sessions"]],
    "instruction": updated["instruction"],
}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim());
		expect(output).toMatchObject({
			created_action: "created",
			updated_action: "updated",
			paused_action: "updated",
			refreshed_action: "updated",
			plain_action: "updated",
			created_label: "orchestrator",
			updated_label: "orchestrator",
			session_names: ["autoenv", "emulatorBench"],
		});
		expect(output.missing_once_error).toContain("RLM heartbeat job-missing disappeared");
		expect(output.instruction).toContain("Use agent_observe to inspect active Prime Agent sessions");
		expect(output.instruction).toContain("recommend the exact action and draft the target message");
		expect(output.instruction).toContain("Do not send cross-session messages until the user approves");
		expect(output.instruction).not.toContain("name=orch");
		expect(output.instruction).toContain("name=autoenv");
		expect(output.instruction).toContain("session_id=sess-autoenv");
		expect(output.instruction).toContain("active_session_id=active-autoenv");
		expect(output.instruction).toContain("streaming=False");
		expect(output.instruction).toContain("pending_messages=1");
		expect(requests.map((request) => request.type)).toEqual([
			"agent_observe.list",
			"rlm_heartbeat.list",
			"rlm_heartbeat.create",
			"agent_observe.list",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"agent_observe.list",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"agent_observe.list",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"agent_observe.list",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
			"agent_observe.list",
			"rlm_heartbeat.list",
			"rlm_heartbeat.update",
		]);
		expect(requests[2].payload).toMatchObject({
			type: "rlm_heartbeat.create",
			interval: "5m",
			label: "orchestrator",
		});
		expect(requests[5].payload).toMatchObject({
			type: "rlm_heartbeat.update",
			id: "job-orch",
			interval: "10m",
			label: "orchestrator",
		});
		expect(requests[5].payload).not.toHaveProperty("status");
		expect(requests[8].payload).toMatchObject({
			type: "rlm_heartbeat.update",
			id: "job-missing",
			label: "missing-on-update",
		});
		expect(requests[11].payload).toMatchObject({
			type: "rlm_heartbeat.update",
			id: "job-paused",
			label: "paused-orchestrator",
			status: "resume",
		});
		expect(requests[14].payload).toMatchObject({
			type: "rlm_heartbeat.update",
			id: "job-orch",
			label: "orchestrator",
		});
		expect(requests[14].payload).not.toHaveProperty("interval");
		expect(requests[14].payload).not.toHaveProperty("status");
		expect(requests[17].payload).toMatchObject({
			type: "rlm_heartbeat.update",
			id: "job-plain",
			label: "plain-schedule",
		});
		expect(requests[17].payload).not.toHaveProperty("interval");
	});
});
