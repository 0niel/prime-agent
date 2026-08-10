import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getSelfUpdateCommand,
	NPM_REMOTE_DEPENDENCY_WARNING,
	npmRemoteInstallArgs,
	selfUpdateUsesRemoteDependencyAccess,
} from "../../../src/config.js";
import { confirmNpmRemoteDependencyAccess } from "../../../src/package-manager-cli.js";

const packageRoot = resolve(__dirname, "../../..");
const repoRoot = resolve(packageRoot, "../..");
const installerSource = readFileSync(join(repoRoot, "install.sh"), "utf8");
const installerWithoutMain = installerSource.slice(0, installerSource.lastIndexOf('\nmain "$@"'));
const tempDirs: string[] = [];
const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPackageDir = process.env.PI_PACKAGE_DIR;

function tempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-npm12-"));
	tempDirs.push(directory);
	return directory;
}

function fakeNpmScript(): string {
	return `#!/bin/sh
for arg in "$@"; do
	if [ "$arg" = "--version" ]; then
		printf '%s\n' "$FAKE_NPM_VERSION"
		exit 0
	fi
done
while [ "$#" -gt 0 ]; do
	if [ "$1" = "root" ] && [ "\${2:-}" = "-g" ]; then
		printf '%s\n' "$FAKE_NPM_ROOT"
		exit 0
	fi
	shift
done
printf 'remote=%s\nscripts=%s\n' "\${npm_config_allow_remote:-}" "\${npm_config_allow_scripts:-}" >> "$FAKE_NPM_LOG"
`;
}

function runInstallerInstall(npmVersion: string): string {
	const directory = tempDir();
	const binDir = join(directory, "bin");
	const logPath = join(directory, "npm.log");
	const npmPath = join(binDir, "npm");
	const harnessPath = join(directory, "installer-harness.sh");
	mkdirSync(binDir);
	writeFileSync(npmPath, fakeNpmScript());
	chmodSync(npmPath, 0o755);
	writeFileSync(
		harnessPath,
		`${installerWithoutMain}
prime_agent_screen_enabled=0
prime_agent_bootstrap_kernel_on_install=0
install_prime_agent_package "/tmp/prime-agent-0.7.1.tgz"
`,
	);
	const result = spawnSync("sh", [harnessPath], {
		encoding: "utf8",
		env: {
			...process.env,
			FAKE_NPM_LOG: logPath,
			FAKE_NPM_VERSION: npmVersion,
			PATH: `${binDir}:${process.env.PATH ?? ""}`,
		},
	});
	expect(result.status, result.stderr).toBe(0);
	return readFileSync(logPath, "utf8");
}

function renderInstallerPromptDetail(detail: string): string[] {
	const directory = tempDir();
	const harnessPath = join(directory, "prompt-harness.sh");
	writeFileSync(
		harnessPath,
		`${installerWithoutMain}
prime_agent_screen_question="Install? [Y/n]"
prime_agent_screen_title="Install Prime Agent?"
prime_agent_screen_detail="$1"
printf '%s\n' "$(prime_agent_content_height)"
prime_agent_content_line 1
printf '%s\n' "$prime_agent_content_text"
prime_agent_content_line 2
printf '%s\n' "$prime_agent_content_text"
`,
	);
	const result = spawnSync("sh", [harnessPath, detail], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.trim().split("\n");
}

afterEach(() => {
	if (originalExecPath) Object.defineProperty(process, "execPath", originalExecPath);
	if (originalPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
	else process.env.PI_PACKAGE_DIR = originalPackageDir;
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("issue #741 npm 12 release installs", () => {
	it("scopes remote and postinstall access to npm 12 installer invocations", () => {
		expect(runInstallerInstall("11.17.0")).toBe("remote=\nscripts=\n");
		expect(runInstallerInstall("12.0.2")).toBe("remote=all\nscripts=file:/tmp/prime-agent-0.7.1.tgz\n");
		expect(installerSource).toContain("allow-remote=all allows unverified URLs from any host/depth");
		expect(installerSource).toContain("permits dependencies at any depth to download from any URL host");
		expect(installerSource).toContain(
			"Only the Prime Agent archive is checksum-verified; remote dependency archives are not.",
		);
	});

	it("renders the npm 12 risk disclosure before interactive consent", () => {
		const detail = "npm 12: allow-remote=all allows unverified URLs from any host/depth.";
		expect(renderInstallerPromptDetail(detail)).toEqual(["3", detail, "Press Enter to continue; type n to cancel."]);
	});

	it("adds the npm 12 remote grant to self-update commands only", () => {
		expect(npmRemoteInstallArgs("11.17.0")).toEqual([]);
		expect(npmRemoteInstallArgs("12.0.2")).toEqual(["--allow-remote=all"]);
		expect(npmRemoteInstallArgs("not-a-version")).toEqual([]);

		const directory = tempDir();
		const prefix = join(directory, "prefix");
		const packageDir = join(prefix, "lib", "node_modules", "prime-agent");
		const npmPath = join(directory, "npm");
		mkdirSync(packageDir, { recursive: true });
		writeFileSync(npmPath, fakeNpmScript());
		chmodSync(npmPath, 0o755);
		process.env.PI_PACKAGE_DIR = packageDir;
		Object.defineProperty(process, "execPath", {
			value: join(packageDir, "dist", "bundle", "cli.js"),
			configurable: true,
		});
		process.env.FAKE_NPM_VERSION = "12.0.2";
		process.env.FAKE_NPM_ROOT = join(prefix, "lib", "node_modules");
		process.env.FAKE_NPM_LOG = join(directory, "npm.log");

		const command = getSelfUpdateCommand("prime-agent", [npmPath, "--prefix", prefix]);
		expect(command?.args).toEqual(["--prefix", prefix, "--allow-remote=all", "install", "-g", "prime-agent"]);
		if (!command) throw new Error("Expected npm self-update command");
		expect(selfUpdateUsesRemoteDependencyAccess(command)).toBe(true);
		expect(NPM_REMOTE_DEPENDENCY_WARNING).toContain("at any depth");
		expect(NPM_REMOTE_DEPENDENCY_WARNING).toContain("any URL host");
		expect(NPM_REMOTE_DEPENDENCY_WARNING).toContain("does not verify those dependency archives");
	});

	it("warns and requires explicit non-TTY self-update consent", async () => {
		const command = {
			command: "npm",
			args: ["--allow-remote=all", "install", "-g", "prime-agent"],
			display: "npm --allow-remote=all install -g prime-agent",
		};
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			await expect(confirmNpmRemoteDependencyAccess(command, false)).resolves.toBe(false);
			expect(error.mock.calls.flat().join(" ")).toContain("any URL host");
			expect(error.mock.calls.flat().join(" ")).toContain("Re-run with --force to consent");
			error.mockClear();
			await expect(confirmNpmRemoteDependencyAccess(command, true)).resolves.toBe(true);
			expect(error.mock.calls.flat().join(" ")).toContain("does not verify those dependency archives");
		} finally {
			error.mockRestore();
		}
	});

	it("uses npm prefix for PATH recovery instead of the removed npm bin command", () => {
		expect(installerSource).toContain('echo "$(npm prefix -g)/bin"');
		expect(installerSource).not.toContain("npm bin -g");
	});
});
