import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const installer = join(repoRoot, "scripts", "install-aisuite-eliza.sh");

function run(command: string, args: string[], cwd: string) {
	return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("AISuite Eliza installer", () => {
	it("clones the bridge and writes secret-safe idempotent configuration", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-aisuite-installer-"));
		const source = join(root, "source");
		const home = join(root, "home");
		const project = join(root, "project");
		const bin = join(root, "bin");
		const agentDir = join(home, ".prime", "agent");
		const checkout = join(root, "checkout");
		const fakePrime = join(root, "fake-prime-agent");
		const tools = join(root, "tools");
		const fallbackMarker = join(root, "fallback-installer-used");
		const branch = "installer-test";

		mkdirSync(join(source, "packages", "coding-agent", "examples", "extensions", "aisuite"), { recursive: true });
		mkdirSync(join(source, "scripts"), { recursive: true });
		mkdirSync(tools, { recursive: true });
		writeFileSync(
			join(source, "packages", "coding-agent", "examples", "extensions", "aisuite", "index.ts"),
			"export default function extension() {}\n",
		);
		for (const name of ["prime-agent-perf-runner.sh", "prime-agent-perf-loop.sh"]) {
			const path = join(source, "scripts", name);
			writeFileSync(path, "#!/usr/bin/env bash\nexit 0\n");
			chmodSync(path, 0o755);
		}
		const sourceInstaller = join(source, "install.sh");
		writeFileSync(
			sourceInstaller,
			`#!/bin/sh
set -eu
printf '%s' "\${PRIME_AGENT_DOWNLOAD_BASE_URL:?}" > "\${PRIME_AISUITE_TEST_FALLBACK_MARKER:?}"
`,
		);
		chmodSync(sourceInstaller, 0o755);
		const fakeCurl = join(tools, "curl");
		writeFileSync(fakeCurl, "#!/bin/sh\nexit 22\n");
		chmodSync(fakeCurl, 0o755);
		run("git", ["init", "-b", branch], source);
		run(
			"git",
			[
				"add",
				"packages/coding-agent/examples/extensions/aisuite/index.ts",
				"scripts/prime-agent-perf-runner.sh",
				"scripts/prime-agent-perf-loop.sh",
				"install.sh",
			],
			source,
		);
		run(
			"git",
			["-c", "user.name=Installer Test", "-c", "user.email=installer@example.test", "commit", "-m", "fixture"],
			source,
		);

		mkdirSync(join(project, ".codex"), { recursive: true });
		mkdirSync(join(project, ".agents", "skills", "duty-cracker"), { recursive: true });
		mkdirSync(join(project, ".agents", "skills", "eats-perf-profiler"), { recursive: true });
		writeFileSync(join(project, ".codex", "aisuite_generated_artifacts.json"), '{"skills":[]}\n');
		writeFileSync(join(project, ".agents", "skills", "duty-cracker", "SKILL.md"), "# Duty Cracker\n");
		writeFileSync(
			join(project, ".agents", "skills", "eats-perf-profiler", "SKILL.md"),
			"# Eats performance profiler\n",
		);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { existing: { baseUrl: "http://localhost" } } }),
		);
		writeFileSync(
			fakePrime,
			`#!/usr/bin/env bash
set -euo pipefail
[[ -z "\${ELIZA_API_TOKEN:-}" ]] || exit 91
for arg in "$@"; do
	if [[ "$arg" == "--version" ]]; then
		echo "prime-agent vtest"
		exit 0
	fi
done
exit 0
`,
		);
		chmodSync(fakePrime, 0o755);

		const env = {
			...process.env,
			HOME: home,
			PATH: `${tools}:${process.env.PATH ?? ""}`,
			ELIZA_API_TOKEN: "fixture-secret-token",
			PRIME_AISUITE_REPO_URL: source,
			PRIME_AISUITE_BRANCH: branch,
			PRIME_AISUITE_REPO_DIR: checkout,
			PRIME_AISUITE_PROJECT_DIR: project,
			PRIME_AISUITE_BIN_DIR: bin,
			PRIME_AISUITE_PRIME_AGENT_BIN: fakePrime,
			PRIME_AISUITE_AGENT_DIR: agentDir,
			PRIME_AISUITE_STATE_DIR: join(root, "state"),
			PRIME_AISUITE_TOKEN_SOURCE: "prompt",
			PRIME_AISUITE_SKIP_PRIME_INSTALL: "0",
			PRIME_AISUITE_PRIME_INSTALLER_URL: "https://installer.invalid/install.sh",
			PRIME_AISUITE_PRIME_RELEASE_BASE_URL: "https://releases.example.test",
			PRIME_AISUITE_TEST_FALLBACK_MARKER: fallbackMarker,
			PRIME_AISUITE_SKIP_AISUITE_SETUP: "1",
			PRIME_AISUITE_SKIP_LIVE_SMOKE: "1",
			PRIME_AISUITE_NON_INTERACTIVE: "1",
		};
		const first = execFileSync("bash", [installer], { cwd: project, env, encoding: "utf8" });
		const second = execFileSync("bash", [installer], { cwd: project, env, encoding: "utf8" });

		expect(first).toContain("Installation complete");
		expect(first).toContain("official installer endpoint is unavailable");
		expect(second).toContain("Already up to date");
		expect(readFileSync(fallbackMarker, "utf8")).toBe("https://releases.example.test");
		expect(
			readFileSync(
				join(checkout, "packages", "coding-agent", "examples", "extensions", "aisuite", "index.ts"),
				"utf8",
			),
		).toContain("extension");

		const tokenPath = join(agentDir, "secrets", "eliza-token");
		const canonicalTokenPath = realpathSync(tokenPath);
		expect(readFileSync(tokenPath, "utf8")).toBe("fixture-secret-token");
		expect(statSync(tokenPath).mode & 0o777).toBe(0o600);

		const modelsText = readFileSync(join(agentDir, "models.json"), "utf8");
		const models = JSON.parse(modelsText) as {
			providers: Record<string, { apiKey?: string; baseUrl?: string }>;
		};
		expect(modelsText).not.toContain("fixture-secret-token");
		expect(models.providers.existing?.baseUrl).toBe("http://localhost");
		expect(models.providers["eliza-deepseek-internal"]?.apiKey).toBe(`!cat '${canonicalTokenPath}'`);

		const launcherPath = join(bin, "prime-agent-aisuite");
		const launcher = readFileSync(launcherPath, "utf8");
		expect(statSync(launcherPath).mode & 0o111).not.toBe(0);
		expect(launcher).toContain(join(checkout, "packages", "coding-agent", "examples", "extensions", "aisuite"));
		expect(launcher).toContain("eliza-deepseek-internal");
		expect(launcher).toContain(`PRIME_AGENT_CODING_AGENT_DIR=${realpathSync(agentDir)}`);
		expect(dirname(launcherPath)).toBe(bin);

		const perfRunnerPath = join(bin, "prime-agent-perf-runner");
		const perfLoopPath = join(bin, "prime-agent-perf-loop");
		expect(statSync(perfRunnerPath).mode & 0o111).not.toBe(0);
		expect(statSync(perfLoopPath).mode & 0o111).not.toBe(0);
		expect(readFileSync(perfRunnerPath, "utf8")).toContain("prime-agent-perf-runner.sh");
		expect(readFileSync(perfLoopPath, "utf8")).toContain("prime-agent-perf-loop.sh");
	});
});
