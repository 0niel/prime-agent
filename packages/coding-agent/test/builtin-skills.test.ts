import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBundledSkillsDir } from "../src/config.js";
import { DefaultPackageManager } from "../src/core/package-manager.js";
import { DefaultResourceLoader } from "../src/core/resource-loader.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { loadSkillsFromDir } from "../src/core/skills.js";

function writeSkill(dir: string, name: string, description = `Description for ${name}`): void {
	const skillDir = join(dir, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---
name: ${name}
description: ${description}
---
Content for ${name}.`,
	);
}

describe("builtin skills", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let bundledDir: string;
	let settingsManager: SettingsManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `builtin-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		bundledDir = join(tempDir, "bundled-skills");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		mkdirSync(bundledDir, { recursive: true });
		settingsManager = SettingsManager.inMemory();
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("DefaultPackageManager", () => {
		it("resolves bundled skills with builtin source at lowest precedence", async () => {
			writeSkill(bundledDir, "builtin-skill");

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			const builtin = result.skills.find((r) => r.path === join(bundledDir, "builtin-skill", "SKILL.md"));
			expect(builtin).toBeDefined();
			expect(builtin?.enabled).toBe(true);
			expect(builtin?.metadata.source).toBe("builtin");
			expect(builtin?.metadata.scope).toBe("user");
			expect(builtin?.metadata.baseDir).toBe(bundledDir);
		});

		it("sorts builtin skills after user and project skills so collisions favor local skills", async () => {
			writeSkill(bundledDir, "shared-skill");
			writeSkill(join(agentDir, "skills"), "shared-skill");

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			const paths = result.skills.map((r) => r.path);
			const userIndex = paths.indexOf(join(agentDir, "skills", "shared-skill", "SKILL.md"));
			const builtinIndex = paths.indexOf(join(bundledDir, "shared-skill", "SKILL.md"));
			expect(userIndex).toBeGreaterThanOrEqual(0);
			expect(builtinIndex).toBeGreaterThanOrEqual(0);
			expect(userIndex).toBeLessThan(builtinIndex);
		});

		it("excludes bundled skills when enableBuiltinSkills is false", async () => {
			writeSkill(bundledDir, "builtin-skill");
			settingsManager.setEnableBuiltinSkills(false);

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			expect(result.skills.some((r) => r.metadata.source === "builtin")).toBe(false);
		});

		it("disables individual bundled skills via settings override patterns", async () => {
			writeSkill(bundledDir, "builtin-skill");
			writeSkill(bundledDir, "other-skill");
			settingsManager.setSkillPaths(["-builtin-skill/SKILL.md"]);

			const packageManager = new DefaultPackageManager({
				cwd,
				agentDir,
				settingsManager,
				bundledSkillsDir: bundledDir,
			});
			const result = await packageManager.resolve();

			const disabled = result.skills.find((r) => r.path === join(bundledDir, "builtin-skill", "SKILL.md"));
			const enabled = result.skills.find((r) => r.path === join(bundledDir, "other-skill", "SKILL.md"));
			expect(disabled?.enabled).toBe(false);
			expect(enabled?.enabled).toBe(true);
		});
	});

	describe("DefaultResourceLoader", () => {
		it("loads bundled skills with builtin source info", async () => {
			writeSkill(bundledDir, "builtin-skill");

			const loader = new DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: bundledDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			const builtin = skills.find((s) => s.name === "builtin-skill");
			expect(builtin).toBeDefined();
			expect(builtin?.sourceInfo.source).toBe("builtin");
		});

		it("prefers user skills over bundled skills with the same name", async () => {
			writeSkill(bundledDir, "shared-skill", "Bundled variant");
			writeSkill(join(agentDir, "skills"), "shared-skill", "User variant");

			const loader = new DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: bundledDir });
			await loader.reload();

			const { skills } = loader.getSkills();
			const winner = skills.find((s) => s.name === "shared-skill");
			expect(winner?.description).toBe("User variant");
		});

		it("excludes bundled skills with --no-skills", async () => {
			writeSkill(bundledDir, "builtin-skill");

			const loader = new DefaultResourceLoader({ cwd, agentDir, bundledSkillsDir: bundledDir, noSkills: true });
			await loader.reload();

			expect(loader.getSkills().skills).toEqual([]);
		});
	});

	describe("shipped skill content", () => {
		it("loads all bundled skills without diagnostics", () => {
			const { skills, diagnostics } = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });

			expect(diagnostics).toEqual([]);
			expect(skills.length).toBeGreaterThan(0);
			expect(skills.map((s) => s.name)).toContain("prime-intellect");
		});
	});
});
