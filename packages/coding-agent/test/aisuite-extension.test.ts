import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	blockedCommandReason,
	extractRequestedSkills,
	loadAisuiteProject,
	parseHookDecision,
	requestsExternalReadOnly,
} from "../examples/extensions/aisuite/index.js";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "prime-aisuite-"));
	mkdirSync(join(root, ".codeassistant", "rules"), { recursive: true });
	mkdirSync(join(root, ".agents", "skills", "duty-cracker"), { recursive: true });
	mkdirSync(join(root, ".codex"), { recursive: true });
	mkdirSync(join(root, "nested", "package"), { recursive: true });
	writeFileSync(join(root, ".codeassistant", "rules", "eats.md"), "Always verify evidence.\n");
	writeFileSync(join(root, ".agents", "skills", "duty-cracker", "SKILL.md"), "# Duty cracker\n");
	writeFileSync(
		join(root, ".codeassistant", "aisuite_generated_artifacts.json"),
		JSON.stringify({
			rules: [{ name: "eats", path: ".codeassistant/rules/eats.md", source: "rules/eats.md", broken: false }],
			skills: [{ name: "duty-cracker", path: ".agents/skills/duty-cracker", broken: false }],
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
		expect(project?.hooksPath).toBe(join(root, ".codex", "hooks.json"));
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
