import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSelfUpdateCommand, npmRemoteInstallArgs } from "../../../src/config.js";

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
		expect(installerSource).toContain("npm 12 will use allow-remote=all for this verified install only.");
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
	});

	it("uses npm prefix for PATH recovery instead of the removed npm bin command", () => {
		expect(installerSource).toContain('echo "$(npm prefix -g)/bin"');
		expect(installerSource).not.toContain("npm bin -g");
	});
});
