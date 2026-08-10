#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const NPM_VERSION = "12.0.2";
const NPM_TARBALL_URL = `https://registry.npmjs.org/npm/-/npm-${NPM_VERSION}.tgz`;
const NPM_TARBALL_INTEGRITY = "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==";

function run(command, args, options = {}) {
	return new Promise((resolve) => {
		const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
		child.on("close", (status) => resolve({ status, stdout, stderr }));
	});
}

function requireSuccess(result, description) {
	if (result.status !== 0) {
		throw new Error(`${description} failed (${result.status ?? "spawn error"}):\n${result.stderr}${result.stdout}`);
	}
}

async function resolveVerifiedNpm12(root) {
	if (process.env.NPM12_COMMAND) return { command: process.env.NPM12_COMMAND, args: [] };
	const response = await fetch(NPM_TARBALL_URL);
	if (!response.ok) throw new Error(`Could not download npm ${NPM_VERSION}: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	const actualIntegrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (actualIntegrity !== NPM_TARBALL_INTEGRITY) {
		throw new Error(`npm ${NPM_VERSION} integrity mismatch: ${actualIntegrity}`);
	}
	const archivePath = join(root, `npm-${NPM_VERSION}.tgz`);
	const extractDir = join(root, "npm-cli");
	writeFileSync(archivePath, bytes);
	mkdirSync(extractDir);
	const extracted = await run("tar", ["-xzf", archivePath, "-C", extractDir], { cwd: root, env: process.env });
	requireSuccess(extracted, `extract npm ${NPM_VERSION}`);
	return { command: process.execPath, args: [join(extractDir, "package", "bin", "npm-cli.js")] };
}

function runNpm(npmInvocation, args, options) {
	return run(npmInvocation.command, [...npmInvocation.args, ...args], options);
}

async function pack(npmInvocation, packageDir, artifactsDir, environment) {
	const result = await runNpm(npmInvocation, ["pack", packageDir, "--pack-destination", artifactsDir, "--silent"], {
		cwd: artifactsDir,
		env: environment,
	});
	requireSuccess(result, `npm pack ${packageDir}`);
	const filename = result.stdout.trim().split("\n").at(-1);
	if (!filename) throw new Error(`npm pack did not report an artifact for ${packageDir}`);
	return join(artifactsDir, basename(filename));
}

function cleanNpmEnvironment(root) {
	const environment = { ...process.env };
	for (const key of Object.keys(environment)) {
		if (key.toLowerCase() === "npm_config_allow_remote" || key.toLowerCase() === "npm_config_allow_scripts") {
			delete environment[key];
		}
	}
	environment.NPM_CONFIG_USERCONFIG = join(root, "empty.npmrc");
	environment.NPM_CONFIG_CACHE = join(root, "npm-cache");
	environment.NPM_CONFIG_AUDIT = "false";
	environment.NPM_CONFIG_FUND = "false";
	writeFileSync(environment.NPM_CONFIG_USERCONFIG, "");
	return environment;
}

const root = mkdtempSync(join(tmpdir(), "prime-agent-npm12-remote-"));
let server;
try {
	const environment = cleanNpmEnvironment(root);
	const npmInvocation = await resolveVerifiedNpm12(root);
	const versionResult = await runNpm(npmInvocation, ["--version"], { cwd: root, env: environment });
	requireSuccess(versionResult, `npm ${NPM_VERSION} --version`);
	if (!versionResult.stdout.trim().startsWith("12.")) {
		throw new Error(`npm 12 is required, found ${versionResult.stdout.trim() || "unknown"}`);
	}
	const defaultPolicy = await runNpm(npmInvocation, ["config", "get", "allow-remote"], {
		cwd: root,
		env: environment,
	});
	requireSuccess(defaultPolicy, "read npm 12 default allow-remote policy");
	if (defaultPolicy.stdout.trim() !== "none") {
		throw new Error(`Expected npm 12 default allow-remote=none, found ${defaultPolicy.stdout.trim()}`);
	}

	const artifactsDir = join(root, "artifacts");
	const dependencyDir = join(root, "remote-dependency");
	const rootPackageDir = join(root, "root-package");
	mkdirSync(artifactsDir);
	mkdirSync(dependencyDir);
	mkdirSync(rootPackageDir);
	writeFileSync(
		join(dependencyDir, "package.json"),
		JSON.stringify({ name: "prime-agent-npm12-remote-fixture", version: "1.0.0" }),
	);
	writeFileSync(join(dependencyDir, "index.js"), "export const installed = true;\n");
	const dependencyTarball = await pack(npmInvocation, dependencyDir, artifactsDir, environment);
	const dependencyBytes = readFileSync(dependencyTarball);
	let requestCount = 0;
	server = createServer((request, response) => {
		if (request.url !== "/remote-dependency.tgz") {
			response.writeHead(404).end();
			return;
		}
		requestCount += 1;
		response.writeHead(200, { "content-type": "application/gzip", "content-length": dependencyBytes.length });
		response.end(dependencyBytes);
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Local fixture server did not expose a port");
	const dependencyUrl = `http://127.0.0.1:${address.port}/remote-dependency.tgz`;
	writeFileSync(
		join(rootPackageDir, "package.json"),
		JSON.stringify({
			name: "prime-agent-npm12-root-fixture",
			version: "1.0.0",
			dependencies: { "prime-agent-npm12-remote-fixture": dependencyUrl },
		}),
	);
	const rootTarball = await pack(npmInvocation, rootPackageDir, artifactsDir, environment);

	async function install(policy) {
		const prefix = join(root, `prefix-${policy ?? "default"}`);
		const policyArgs = policy ? ["--allow-remote", policy] : [];
		return runNpm(
			npmInvocation,
			[...policyArgs, "--prefix", prefix, "install", "-g", "--ignore-scripts", rootTarball],
			{ cwd: root, env: environment },
		);
	}

	const denied = await install();
	if (denied.status === 0 || !`${denied.stderr}${denied.stdout}`.includes("EALLOWREMOTE")) {
		throw new Error(`npm 12 default allow-remote=none did not reject the URL dependency:
${denied.stderr}${denied.stdout}`);
	}
	const rootOnly = await install("root");
	if (rootOnly.status === 0 || !`${rootOnly.stderr}${rootOnly.stdout}`.includes("EALLOWREMOTE")) {
		throw new Error(`npm 12 allow-remote=root did not reject the transitive URL dependency:
${rootOnly.stderr}${rootOnly.stdout}`);
	}
	const allowed = await install("all");
	requireSuccess(allowed, "npm 12 allow-remote=all install");
	if (requestCount < 1) throw new Error("npm 12 successful install never fetched the local URL dependency");

	console.log("npm 12 local URL dependency policy check passed (default none/root rejected, all installed).");
} finally {
	if (server) await new Promise((resolve) => server.close(resolve));
	rmSync(root, { recursive: true, force: true });
}
