import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	blockedCommandReason,
	blockedToolReason,
	extractRequestedSkills,
	loadAisuiteProject,
	parseHookDecision,
	requestsExternalReadOnly,
	resolveArtifactPath,
	restoreAisuiteState,
	runHookCommand,
} from "../examples/extensions/aisuite/index.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-aisuite-"));
	mkdirSync(join(root, ".codeassistant", "rules"), { recursive: true });
	mkdirSync(join(root, ".codeassistant", "skills", "duty-cracker"), { recursive: true });
	mkdirSync(join(root, ".agents", "skills", "duty-cracker"), { recursive: true });
	mkdirSync(join(root, ".codex"), { recursive: true });
	mkdirSync(join(root, "nested", "package"), { recursive: true });
	writeFileSync(join(root, ".codeassistant", "rules", "eats.md"), "Always verify evidence.\n");
	writeFileSync(join(root, ".agents", "skills", "duty-cracker", "SKILL.md"), "# Duty cracker\n");
	writeFileSync(join(root, ".codeassistant", "skills", "duty-cracker", "SKILL.md"), "# Duty cracker\n");
	writeFileSync(
		join(root, ".codeassistant", "aisuite_generated_artifacts.json"),
		JSON.stringify({
			rules: [{ name: "eats", path: ".codeassistant/rules/eats.md", source: "rules/eats.md", broken: false }],
			skills: [
				{
					name: "duty-cracker",
					path: ".codeassistant/skills/duty-cracker",
					source: "skills/duty-cracker",
					broken: false,
				},
			],
		}),
	);
	writeFileSync(
		join(root, ".codex", "aisuite_generated_artifacts.json"),
		JSON.stringify({
			rules: [{ name: "eats", path: ".codex/config.toml", source: "rules/eats.md", broken: false }],
			skills: [
				{ name: "duty-cracker", path: ".agents/skills/duty-cracker", source: "skills/duty-cracker", broken: false },
				{
					name: "duty-cracker",
					path: ".agents/skills/duty-cracker",
					source: "another/source/duty-cracker",
					broken: false,
				},
			],
		}),
	);
	writeFileSync(join(root, ".codex", "hooks.json"), JSON.stringify({ hooks: {} }));
	return root;
}

describe("AISuite extension", () => {
	it("finds the project from a nested cwd and loads generated resources", () => {
		const root = fixture();
		const project = loadAisuiteProject(join(root, "nested", "package"), join(root, "agent-home"));
		expect(project?.root).toBe(root);
		expect(project?.rules.map((rule) => rule.name)).toEqual(["eats"]);
		expect(project?.skills.map((skill) => skill.name)).toEqual(["duty-cracker"]);
		expect(project?.skills[0]?.path).toBe(".agents/skills/duty-cracker");
		expect(project?.hooksPath).toBe(join(root, ".codex", "hooks.json"));
	});

	it("preserves generated skill symlink names", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-aisuite-symlink-"));
		mkdirSync(join(root, "canonical", "intrasearch"), { recursive: true });
		mkdirSync(join(root, ".agents", "skills"), { recursive: true });
		const generatedPath = join(root, ".agents", "skills", "community-intrasearch");
		symlinkSync(join(root, "canonical", "intrasearch"), generatedPath);

		expect(
			resolveArtifactPath(root, { name: "community-intrasearch", path: ".agents/skills/community-intrasearch" }),
		).toBe(generatedPath);
	});

	it("detects explicitly requested skills", () => {
		const available = ["duty-cracker", "tracker", "wiki"];
		expect(extractRequestedSkills("/skill:duty-cracker investigate", available)).toEqual(["duty-cracker"]);
		expect(extractRequestedSkills("Use $tracker", available)).toEqual(["tracker"]);
	});

	it("detects Russian and English read-only requests", () => {
		expect(requestsExternalReadOnly("Не отвечай в тикете, результат только сюда")).toBe(true);
		expect(requestsExternalReadOnly("Work read-only and do not comment on the PR")).toBe(true);
		expect(requestsExternalReadOnly("Investigate and publish the result")).toBe(false);
	});

	it("blocks external mutations only when read-only mode is active", () => {
		const mutation = "./tracker-cli.sh comment YXPROAPPS-1 --text hi";
		expect(blockedCommandReason(mutation, true)).toContain("read-only");
		expect(blockedCommandReason(mutation, false)).toBeUndefined();
		expect(blockedCommandReason('find / -name "YXPROAPPS-1"', false)).toContain("Full-filesystem");
		expect(blockedCommandReason('find /Users/me/project -name "YXPROAPPS-1"', false)).toBeUndefined();
		expect(
			blockedCommandReason('await mcp.call_tool("tracker_mcp", "add_comment", { issue: "YXPROAPPS-1" })', true),
		).toContain("read-only");
		expect(blockedCommandReason('await tools.mcp__tracker__add_comment({ issue: "YXPROAPPS-1" })', true)).toContain(
			"read-only",
		);
		expect(blockedCommandReason('await mcp.call_tool("tracker_mcp", "get_issue", {})', true)).toBeUndefined();
		expect(blockedCommandReason('requests.patch("https://api.tracker.yandex.net/v3/issues/1")', true)).toContain(
			"read-only",
		);
		expect(blockedCommandReason("curl https://api.tracker.yandex.net/v3/issues/1", true)).toBeUndefined();
	});

	it("blocks native external mutation tools while allowing reads", () => {
		expect(blockedToolReason("mcp__tracker__add_comment", { issue: "YXPROAPPS-1" }, true)).toContain("read-only");
		expect(blockedToolReason("mcp__tracker__get_issue", { issue: "YXPROAPPS-1" }, true)).toBeUndefined();
		expect(blockedToolReason("mcp__tracker__add_comment", {}, false)).toBeUndefined();
	});

	it("restores the latest persisted safety and skill state", () => {
		expect(
			restoreAisuiteState([
				{ type: "custom", customType: "aisuite-state", data: { readOnlyExternal: false, selectedSkills: [] } },
				{
					type: "custom",
					customType: "aisuite-state",
					data: { readOnlyExternal: true, selectedSkills: ["duty-cracker", "duty-cracker", "tracker"] },
				},
			]),
		).toEqual({ readOnlyExternal: true, selectedSkills: ["duty-cracker", "tracker"] });
		expect(restoreAisuiteState([])).toEqual({ readOnlyExternal: false, selectedSkills: [] });
	});

	it("ignores invalid prompt byte limits", () => {
		const root = fixture();
		mkdirSync(join(root, ".prime", "agent"), { recursive: true });
		writeFileSync(join(root, ".prime", "agent", "aisuite.json"), JSON.stringify({ maxPromptBytes: -1 }));
		expect(loadAisuiteProject(root, join(root, "agent-home"))?.config.maxPromptBytes).toBe(256 * 1024);
		writeFileSync(
			join(root, ".prime", "agent", "aisuite.json"),
			JSON.stringify({ maxPromptBytes: 10 * 1024 * 1024 }),
		);
		expect(loadAisuiteProject(root, join(root, "agent-home"))?.config.maxPromptBytes).toBe(1024 * 1024);
	});

	it("terminates hooks that exceed the output limit", async () => {
		const result = await runHookCommand(
			{ type: "command", command: `node -e 'process.stdout.write("x".repeat(1100000))'` },
			{ session_id: "test", cwd: tmpdir(), hook_event_name: "SessionStart" },
			tmpdir(),
		);
		expect(result.exitCode).toBeNull();
		expect(result.stderr).toContain("output exceeded 1 MiB");
		expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThan(1024 * 1024 + 128);
	});

	it("parses Codex-compatible AISuite hook output", () => {
		const decision = parseHookDecision(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: "policy",
					updatedInput: { command: "safe" },
				},
			}),
		);
		expect(decision).toEqual({
			block: true,
			reason: "policy",
			updatedInput: { command: "safe" },
			additionalContext: undefined,
			env: undefined,
		});
	});

	it("parses pretty-printed hook output", () => {
		const decision = parseHookDecision(
			JSON.stringify(
				{
					hookSpecificOutput: {
						hookEventName: "SessionStart",
						additionalContext: "generated context",
						env: { AISUITE_READY: "1" },
					},
				},
				null,
				2,
			),
		);
		expect(decision.additionalContext).toBe("generated context");
		expect(decision.env).toEqual({ AISUITE_READY: "1" });
	});
});
