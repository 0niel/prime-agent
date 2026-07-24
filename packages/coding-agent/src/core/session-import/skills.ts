import { randomUUID } from "node:crypto";
import { copyFileSync, type Dirent, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

const MAX_SKILL_FILES = 2_000;
const MAX_SKILL_BYTES = 64 * 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([".git", ".venv", "__pycache__", "node_modules"]);

export function discoverSkillDirectories(root: string): string[] {
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== ".system")
		.map((entry) => join(root, entry.name))
		.filter((directory) => existsSync(join(directory, "SKILL.md")));
}

function copySkillTree(source: string, destination: string, budget: { entries: number; bytes: number }): void {
	mkdirSync(destination, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true, encoding: "utf8" })) {
		if (entry.isSymbolicLink()) {
			continue;
		}
		const sourcePath = join(source, entry.name);
		const destinationPath = join(destination, entry.name);
		if (entry.isDirectory()) {
			if (!EXCLUDED_DIRECTORIES.has(entry.name)) {
				budget.entries++;
				if (budget.entries > MAX_SKILL_FILES) {
					throw new Error("Skill exceeds safe import size limits");
				}
				copySkillTree(sourcePath, destinationPath, budget);
			}
			continue;
		}
		if (!entry.isFile()) {
			continue;
		}
		const size = lstatSync(sourcePath).size;
		budget.entries++;
		budget.bytes += size;
		if (budget.entries > MAX_SKILL_FILES || budget.bytes > MAX_SKILL_BYTES) {
			throw new Error("Skill exceeds safe import size limits");
		}
		copyFileSync(sourcePath, destinationPath);
	}
}

export function importSkillDirectory(source: string, destinationRoot: string): "imported" | "skipped" {
	const name = basename(source);
	if (!name || name === "." || name === "..") {
		throw new Error("Invalid skill directory name");
	}
	mkdirSync(destinationRoot, { recursive: true });
	const destination = join(destinationRoot, name);
	if (existsSync(destination)) {
		return "skipped";
	}

	const temporary = join(destinationRoot, `.${name}.import-${randomUUID()}`);
	try {
		copySkillTree(source, temporary, { entries: 0, bytes: 0 });
		if (!existsSync(join(temporary, "SKILL.md"))) {
			throw new Error("Imported skill has no SKILL.md");
		}
		renameSync(temporary, destination);
		return "imported";
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw error;
	}
}
