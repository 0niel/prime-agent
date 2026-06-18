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

		provisioner = new IpythonKernelProvisioner(tempDir, {
			pythonSkills: [
				bundledPythonSkill("agent-observe", "agent_observe"),
				bundledPythonSkill("rlm-heartbeat", "rlm_heartbeat"),
				bundledPythonSkill("orchestration-heartbeat", "orchestration_heartbeat"),
			],
			hostHandlers: {
				"agent_observe.list": async (payload) => {
					requests.push({ type: "agent_observe.list", payload });
					return {
						current: { name: "orch" },
						agents: [
							{
								name: "autoenv",
								session_id: "sess-autoenv",
								active_session_id: "active-autoenv",
								cwd: "/repo/autoenv",
								status: "tool",
								streaming: false,
								pending_message_count: 1,
							},
							{
								name: "emulatorBench",
								session_id: "sess-emulator",
								active_session_id: "active-emulator",
								cwd: "/repo/emulator",
								status: "idle",
								streaming: false,
								pending_message_count: 0,
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
									},
								]
							: [],
					};
				},
				"rlm_heartbeat.create": async (payload) => {
					requests.push({ type: "rlm_heartbeat.create", payload });
					hasHeartbeat = true;
					return {
						heartbeat: {
							id: "job-orch",
							status: "active",
							label: payload.label,
							instruction: payload.instruction,
							schedule: { kind: "interval", expression: payload.interval },
						},
					};
				},
				"rlm_heartbeat.update": async (payload) => {
					requests.push({ type: "rlm_heartbeat.update", payload });
					return {
						heartbeat: {
							id: payload.id,
							status: "active",
							label: payload.label,
							instruction: payload.instruction,
							schedule: { kind: "interval", expression: payload.interval },
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
print(json.dumps({
    "created_action": created["action"],
    "updated_action": updated["action"],
    "created_label": created["heartbeat"]["label"],
    "updated_label": updated["heartbeat"]["label"],
    "session_names": [agent.get("name") for agent in updated["sessions"]],
    "instruction": updated["instruction"],
}, sort_keys=True))
`);

		expect(result.status).toBe("ok");
		const output = JSON.parse(result.stdout.trim());
		expect(output).toMatchObject({
			created_action: "created",
			updated_action: "updated",
			created_label: "orchestrator",
			updated_label: "orchestrator",
			session_names: ["autoenv", "emulatorBench"],
		});
		expect(output.instruction).toContain("Use agent_observe to inspect active Prime Agent sessions");
		expect(output.instruction).toContain("recommend the exact action and draft the target message");
		expect(output.instruction).toContain("Do not send cross-session messages until the user approves");
		expect(output.instruction).toContain("name=autoenv");
		expect(requests.map((request) => request.type)).toEqual([
			"agent_observe.list",
			"rlm_heartbeat.list",
			"rlm_heartbeat.create",
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
			status: "resume",
		});
	});
});
