#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

const releaseChannels = new Set(["stable", "beta"]);
const commitPattern = /^[0-9a-f]{40}$/;

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) {
		throw new Error(`Invalid release version: ${version}`);
	}
	return normalized;
}

function parseArgs(args) {
	const parsed = { artifactDir: undefined, channel: undefined, commit: undefined, dryRun: false, version: undefined };

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--artifact-dir":
				parsed.artifactDir = resolve(args[i + 1] || "");
				i += 1;
				break;
			case "--channel":
				parsed.channel = args[i + 1];
				i += 1;
				break;
			case "--commit":
				parsed.commit = args[i + 1];
				i += 1;
				break;
			case "--version":
				parsed.version = normalizeVersion(args[i + 1] || "");
				i += 1;
				break;
			case "--dry-run":
				parsed.dryRun = true;
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (!parsed.artifactDir || !parsed.channel || !parsed.commit || !parsed.version) {
		throw new Error("--artifact-dir, --channel, --commit, and --version are required");
	}
	if (!releaseChannels.has(parsed.channel)) {
		throw new Error("--channel must be stable or beta");
	}
	if (!commitPattern.test(parsed.commit)) {
		throw new Error("--commit must be a lowercase 40-character Git commit SHA");
	}
	return parsed;
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		throw new Error(`Invalid JSON in ${basename(path)}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	const manifestPath = `${args.artifactDir}/${manifestName}`;
	const sumsPath = `${args.artifactDir}/SHA256SUMS`;
	const channelPath = `${args.artifactDir}/${args.channel}`;

	for (const path of [manifestPath, sumsPath, channelPath]) {
		assert(existsSync(path) && statSync(path).isFile(), `Missing required artifact ${basename(path)}`);
	}

	const manifest = readJson(manifestPath);
	assert(manifest.version === `v${args.version}`, `Manifest version must be v${args.version}`);
	assert(manifest.source?.commit === args.commit, `Manifest source commit must be ${args.commit}`);
	assert(manifest.tarball === `releases/v${args.version}/prime-agent-${args.version}.tgz`, "Manifest primary tarball is invalid");
	assert(Array.isArray(manifest.tarballs) && manifest.tarballs.length > 0, "Manifest tarballs must be non-empty");

	const tarballs = [...manifest.tarballs];
	const files = tarballs.map((tarball) => tarball?.file);
	assert(files.every((file) => typeof file === "string" && file.endsWith(".tgz")), "Manifest tarball files must end in .tgz");
	assert(new Set(files).size === files.length, "Manifest tarball files must be unique");
	assert(JSON.stringify(files) === JSON.stringify([...files].sort()), "Manifest tarballs must be sorted by file");
	assert(files.includes(`prime-agent-${args.version}.tgz`), "Manifest must include the primary Prime Agent tarball");

	const actualFiles = readdirSync(args.artifactDir)
		.filter((file) => file.endsWith(".tgz"))
		.sort();
	assert(JSON.stringify(files) === JSON.stringify(actualFiles), "Artifact tarballs do not exactly match the manifest");

	const expectedSums = [];
	for (const tarball of tarballs) {
		assert(typeof tarball.sha256 === "string" && /^[0-9a-f]{64}$/.test(tarball.sha256), `Invalid hash for ${tarball.file}`);
		const artifactPath = `${args.artifactDir}/${tarball.file}`;
		assert(existsSync(artifactPath) && statSync(artifactPath).isFile(), `Missing tarball ${tarball.file}`);
		const actualHash = sha256File(artifactPath);
		assert(actualHash === tarball.sha256, `Hash mismatch for ${tarball.file}`);
		expectedSums.push(`${tarball.sha256}  ${tarball.file}`);
	}
	assert(readFileSync(sumsPath, "utf8") === `${expectedSums.join("\n")}\n`, "SHA256SUMS does not match the manifest");
	assert(readFileSync(channelPath, "utf8") === `v${args.version}\n`, `${args.channel} pointer does not match version`);

	if (args.dryRun) {
		console.log(
			JSON.stringify(
				{ channel: args.channel, commit: args.commit, manifest: manifestName, tarballs: files, version: `v${args.version}` },
				null,
				2,
			),
		);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
