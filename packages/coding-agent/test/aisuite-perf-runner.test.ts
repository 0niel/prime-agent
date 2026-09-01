import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const runner = join(repoRoot, "scripts", "prime-agent-perf-runner.sh");
const loop = join(repoRoot, "scripts", "prime-agent-perf-loop.sh");

describe("Prime Agent performance runner", () => {
	it("translates the ralph Claude invocation into an ephemeral Prime skill run", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-perf-runner-"));
		const fakePrime = join(root, "prime-agent-aisuite");
		const argsFile = join(root, "args");
		const promptFile = join(root, "prompt");
		writeFileSync(
			fakePrime,
			`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "${argsFile}"
cat > "${promptFile}"
`,
		);
		chmodSync(fakePrime, 0o755);

		execFileSync(
			"bash",
			[
				runner,
				"--print",
				"--output-format",
				"text",
				"--allowedTools",
				"Bash,Read,Edit",
				"--dangerously-skip-permissions",
				"--model",
				"deepseek-v4-flash",
			],
			{
				env: { ...process.env, PRIME_PERF_PRIME_AGENT_BIN: fakePrime },
				input: "/eats-perf-profiler do one iteration\n",
			},
		);

		expect(readFileSync(promptFile, "utf8")).toBe(
			"/skill:eats-perf-profiler Work read-only for external systems: do not comment on, update, publish, or otherwise mutate Tracker, pull requests, Wiki, chats, or remote services. Keep profiling artifacts local. do one iteration\n",
		);
		expect(readFileSync(argsFile, "utf8").split("\n")).toEqual(
			expect.arrayContaining(["--no-session", "-p", "--tools", "ipython,bash,edit", "--model", "deepseek-v4-flash"]),
		);
	});

	it("does not silently grant full host access when auto-approval is disabled", () => {
		const result = spawnSync("bash", [runner, "--print"], {
			env: { ...process.env, PRIME_PERF_PRIME_AGENT_BIN: "/bin/echo" },
			input: "measure one hypothesis\n",
			encoding: "utf8",
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("not sandboxed");
	});

	it("locates the generated skill and delegates the loop through the adapter", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-perf-loop-"));
		const project = join(root, "project");
		const skill = join(project, ".agents", "skills", "eats-perf-profiler");
		const fakeRalph = join(skill, "scripts", "ralph_perf.sh");
		const fakeRunner = join(root, "prime-agent-perf-runner");
		mkdirSync(join(skill, "scripts"), { recursive: true });
		writeFileSync(fakeRunner, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(fakeRunner, 0o755);
		writeFileSync(fakeRalph, '#!/usr/bin/env bash\nprintf "EATS_ROOT=%s\\n" "$EATS_ROOT"\nprintf "%s\\n" "$@"\n');

		const output = execFileSync("bash", [loop, "--max", "2", "--sleep", "0"], {
			env: {
				...process.env,
				PRIME_PERF_PROJECT_DIR: project,
				PRIME_PERF_RUNNER_BIN: fakeRunner,
			},
			encoding: "utf8",
		});
		expect(output).toContain(`EATS_ROOT=${realpathSync(project)}`);
		expect(output.split("\n")).toEqual(
			expect.arrayContaining(["--runner", "claude", "--agent-bin", fakeRunner, "--max", "2", "--sleep", "0"]),
		);
	});

	it("uses the native Prime runner when the generated skill supports it", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-perf-native-loop-"));
		const project = join(root, "project");
		const skill = join(project, ".agents", "skills", "eats-perf-profiler");
		const fakeRalph = join(skill, "scripts", "ralph_perf.sh");
		const fakePrime = join(root, "prime-agent-aisuite");
		mkdirSync(join(skill, "scripts"), { recursive: true });
		writeFileSync(fakePrime, "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(fakePrime, 0o755);
		writeFileSync(
			fakeRalph,
			'#!/usr/bin/env bash\n# auto|claude|opencode|prime\nprintf "EATS_ROOT=%s\\n" "$EATS_ROOT"\nprintf "provider=%s\\n" "$PERF_PRIME_PROVIDER"\nprintf "model=%s\\n" "$PERF_AGENT_MODEL"\nprintf "%s\\n" "$@"\n',
		);

		const output = execFileSync("bash", [loop, "--max", "2", "--sleep", "0"], {
			env: {
				...process.env,
				PRIME_PERF_PROJECT_DIR: project,
				PRIME_PERF_PRIME_AGENT_BIN: fakePrime,
				PRIME_PERF_PROVIDER: "eliza-deepseek-internal",
				PRIME_PERF_MODEL: "deepseek-v4-flash",
			},
			encoding: "utf8",
		});
		expect(output).toContain(`EATS_ROOT=${realpathSync(project)}`);
		expect(output).toContain("provider=eliza-deepseek-internal");
		expect(output).toContain("model=deepseek-v4-flash");
		expect(output.split("\n")).toEqual(
			expect.arrayContaining(["--runner", "prime", "--agent-bin", fakePrime, "--max", "2", "--sleep", "0"]),
		);
	});
});
