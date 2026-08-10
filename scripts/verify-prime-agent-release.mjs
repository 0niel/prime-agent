#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicPackageName, releaseComponents } from "./prime-agent-release-components.mjs";

const releaseChannels = new Set(["stable", "beta"]);
const commitPattern = /^[0-9a-f]{40}$/;

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) throw new Error(`Invalid release version: ${version}`);
	return normalized;
}

function parseArgs(args) {
	const parsed = { artifactDir: undefined, channel: undefined, commit: undefined, dryRun: false, version: undefined };
	for (let i = 0; i < args.length; i += 1) {
		switch (args[i]) {
			case "--artifact-dir": {
				const value = args[i + 1];
				if (!value || value.startsWith("--")) throw new Error("--artifact-dir requires a value");
				parsed.artifactDir = resolve(value);
				i += 1;
				break;
			}
			case "--channel": parsed.channel = args[++i]; break;
			case "--commit": parsed.commit = args[++i]; break;
			case "--version": parsed.version = normalizeVersion(args[++i] || ""); break;
			case "--dry-run": parsed.dryRun = true; break;
			default: throw new Error(`Unknown argument: ${args[i]}`);
		}
	}
	if (!parsed.artifactDir || !parsed.channel || !parsed.commit || !parsed.version) throw new Error("--artifact-dir, --channel, --commit, and --version are required");
	if (!releaseChannels.has(parsed.channel)) throw new Error("--channel must be stable or beta");
	if (!commitPattern.test(parsed.commit)) throw new Error("--commit must be a lowercase 40-character Git commit SHA");
	return parsed;
}

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function authoritativeSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to resolve authoritative source HEAD: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function sha256File(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch (error) { throw new Error(`Invalid JSON in ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`); } }
function assert(condition, message) { if (!condition) throw new Error(message); }
function exact(value, expected, label) { assert(JSON.stringify(value) === JSON.stringify(expected), `${label} must exactly match the fixed release component inventory`); }
function isWithin(path, parent) {
	const pathRelative = relative(parent, path);
	return pathRelative === "" || (!pathRelative.startsWith("..") && !isAbsolute(pathRelative));
}
function artifactPath(artifactDir, name) {
	const path = resolve(artifactDir, name);
	assert(path !== artifactDir && isWithin(path, artifactDir), `Artifact path escapes artifact directory: ${name}`);
	return path;
}
function lstatArtifact(path, missingMessage) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") throw new Error(missingMessage);
		throw error;
	}
}
function assertRegularArtifact(artifactDir, name, label) {
	const path = artifactPath(artifactDir, name);
	const stat = lstatArtifact(path, `Missing required artifact ${label}`);
	assert(!stat.isSymbolicLink(), `Artifact ${label} must not be a symbolic link`);
	assert(stat.isFile(), `Artifact ${label} must be a regular file`);
	return path;
}
function assertArtifactDirectory(artifactDir) {
	const stat = lstatArtifact(artifactDir, `Missing artifact directory ${artifactDir}`);
	assert(!stat.isSymbolicLink(), "Artifact directory must not be a symbolic link");
	assert(stat.isDirectory(), "Artifact directory must be a directory");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sourceCommit = authoritativeSourceCommit();
	assert(args.commit === sourceCommit, `--commit must exactly match authoritative source HEAD ${sourceCommit}`);
	const pointerName = args.channel === "stable" ? "latest.json" : "beta.json";
	const manifestName = "manifest.json";
	const manifestPath = join(args.artifactDir, manifestName);
	const sumsPath = join(args.artifactDir, "SHA256SUMS");
	const channelPath = join(args.artifactDir, args.channel);
	const pointerPath = join(args.artifactDir, pointerName);
	assertArtifactDirectory(args.artifactDir);
	for (const [name, path] of [[manifestName, manifestPath], ["SHA256SUMS", sumsPath], [args.channel, channelPath], [pointerName, pointerPath]]) {
		assert(path === artifactPath(args.artifactDir, name), `Artifact path escapes artifact directory: ${name}`);
		assertRegularArtifact(args.artifactDir, name, basename(path));
	}
	for (const entry of readdirSync(args.artifactDir)) {
		const entryPath = artifactPath(args.artifactDir, entry);
		assert(!lstatSync(entryPath).isSymbolicLink(), `Artifact ${entry} must not be a symbolic link`);
	}

	const manifestBytes = readFileSync(manifestPath, "utf8");
	const manifest = readJson(manifestPath);
	assert(manifest.version === `v${args.version}`, `Manifest version must be v${args.version}`);
	assert(manifest.source?.commit === sourceCommit, `Manifest source commit must be authoritative source HEAD ${sourceCommit}`);
	assert(manifest.package === publicPackageName, `Manifest package must be ${publicPackageName}`);
	assert(manifest.tarball === `releases/v${args.version}/prime-agent-${args.version}.tgz`, "Manifest primary tarball is invalid");
	assert(Array.isArray(manifest.tarballs), "Manifest tarballs must be an array");

	const expectedTarballInventory = releaseComponents.map(({ component, packageName, artifactName }) => ({
		component, package: packageName, version: args.version, file: `${artifactName}-${args.version}.tgz`,
	}));
	const tarballs = manifest.tarballs;
	exact(tarballs.map(({ component, package: packageName, version, file }) => ({ component, package: packageName, version, file })), expectedTarballInventory, "Manifest tarballs");
	const expectedTarballs = tarballs.map((tarball, index) => {
		const expected = { ...expectedTarballInventory[index], sha256: tarball.sha256 };
		exact(tarball, expected, `Manifest tarball ${expected.file}`);
		assert(typeof expected.sha256 === "string" && /^[0-9a-f]{64}$/.test(expected.sha256), `Invalid hash for ${expected.file}`);
		const path = assertRegularArtifact(args.artifactDir, expected.file, `tarball ${expected.file}`);
		assert(sha256File(path) === expected.sha256, `Hash mismatch for ${expected.file}`);
		return expected;
	});
	const files = expectedTarballs.map(({ file }) => file);
	const expectedManifest = {
		schema: 1,
		version: `v${args.version}`,
		source: { commit: sourceCommit },
		package: publicPackageName,
		tarball: `releases/v${args.version}/prime-agent-${args.version}.tgz`,
		tarballs: expectedTarballs,
	};
	exact(manifest, expectedManifest, "Canonical manifest");
	assert(manifestBytes === `${JSON.stringify(manifest, null, 2)}\n`, "Manifest must use canonical JSON bytes");

	const manifestSha256 = sha256File(manifestPath);
	const expectedSums = [...expectedTarballs.map(({ sha256, file }) => `${sha256}  ${file}`), `${manifestSha256}  ${manifestName}`].join("\n") + "\n";
	assert(readFileSync(sumsPath, "utf8") === expectedSums, "SHA256SUMS does not match the canonical manifest inventory");
	assert(readFileSync(channelPath, "utf8") === `v${args.version}\n`, `${args.channel} pointer does not match version`);

	const pointerBytes = readFileSync(pointerPath, "utf8");
	const pointer = readJson(pointerPath);
	const expectedPointer = { manifest: `releases/v${args.version}/${manifestName}`, sha256: manifestSha256 };
	exact(pointer, expectedPointer, "Root manifest pointer");
	assert(pointerBytes === `${JSON.stringify(pointer, null, 2)}\n`, "Root manifest pointer must use canonical JSON bytes");
	const expectedInventory = [...files, manifestName, "SHA256SUMS", args.channel, pointerName].sort();
	exact(readdirSync(args.artifactDir).sort(), expectedInventory, "Artifact inventory");
	if (args.dryRun) console.log(JSON.stringify({ channel: args.channel, commit: sourceCommit, manifest: manifestName, pointer: pointerName, tarballs: files, version: `v${args.version}` }, null, 2));
}
try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
