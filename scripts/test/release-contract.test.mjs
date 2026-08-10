import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const packer = new URL("../pack-prime-agent-release.mjs", import.meta.url);
const verifier = new URL("../verify-prime-agent-release.mjs", import.meta.url);
const workflow = new URL("../../.github/workflows/build-binaries.yml", import.meta.url);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const version = "0.7.1";
const components = [
	["agent", "prime-agent-core"],
	["ai", "prime-agent-ai"],
	["tui", "prime-agent-tui"],
	["coding-agent", "prime-agent"],
];

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function createArtifacts(mutator) {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-contract-"));
	const tarballs = components.map(([component, packageName]) => {
		const file = `${packageName}-${version}.tgz`;
		const contents = `fixture ${file}\n`;
		writeFileSync(join(directory, file), contents);
		return { component, package: packageName, version, file, sha256: sha256(contents) };
	});
	const manifest = { version: `v${version}`, source: { commit: sourceCommit }, package: "prime-agent", tarball: `releases/v${version}/prime-agent-${version}.tgz`, tarballs };
	mutator?.({ directory, manifest, tarballs });
	writeFileSync(join(directory, "SHA256SUMS"), manifest.tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n");
	writeFileSync(join(directory, "stable"), `v${version}\n`);
	writeFileSync(join(directory, "latest.json"), JSON.stringify(manifest) + "\n");
	return directory;
}
function verify(directory, commit = sourceCommit) {
	return spawnSync(process.execPath, [verifier.pathname, "--artifact-dir", directory, "--channel", "stable", "--version", version, "--commit", commit, "--dry-run"], { cwd: root.pathname, encoding: "utf8" });
}
function cleanup(directory) { rmSync(directory, { force: true, recursive: true }); }

test("packer rejects a spoofed --commit instead of recording caller-controlled provenance", () => {
	const result = spawnSync(process.execPath, [packer.pathname, "--base-url", "https://release.invalid", "--commit", "0123456789abcdef0123456789abcdef01234567"], { cwd: root.pathname, encoding: "utf8" });
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /authoritative source HEAD/);
});

test("packer resolves HEAD and rejects tracked-dirty source before packaging", () => {
	const source = readFileSync(packer, "utf8");
	assert.match(source, /git", \["rev-parse", "HEAD"\]/);
	assert.match(source, /git", \["status", "--porcelain=v1", "--untracked-files=no"\]/);
	assert.match(source, /tracked-dirty source checkout/);
});

test("packer refuses a tracked-dirty source checkout", () => {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-dirty-"));
	try {
		const scripts = join(directory, "scripts");
		mkdirSync(scripts);
		copyFileSync(packer, join(scripts, "pack-prime-agent-release.mjs"));
		copyFileSync(new URL("../prime-agent-release-components.mjs", import.meta.url), join(scripts, "prime-agent-release-components.mjs"));
		writeFileSync(join(directory, "tracked.txt"), "clean\n");
		execFileSync("git", ["init", "--quiet"], { cwd: directory });
		execFileSync("git", ["add", "."], { cwd: directory });
		execFileSync("git", ["-c", "commit.gpgSign=false", "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "initial"], { cwd: directory });
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
		writeFileSync(join(directory, "tracked.txt"), "dirty\n");
		const result = spawnSync(process.execPath, [join(scripts, "pack-prime-agent-release.mjs"), "--base-url", "https://release.invalid", "--commit", commit], { cwd: directory, encoding: "utf8" });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /tracked-dirty source checkout/);
	} finally { cleanup(directory); }
});

test("release verifier accepts the exact fixed four-component inventory", () => {
	const directory = createArtifacts();
	try {
		const result = verify(directory);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout).tarballs, components.map(([, packageName]) => `${packageName}-${version}.tgz`));
	} finally { cleanup(directory); }
});

test("release verifier binds caller and manifest commits to authoritative HEAD", () => {
	const directory = createArtifacts(({ manifest }) => { manifest.source.commit = "fedcba9876543210fedcba9876543210fedcba98"; });
	try {
		const result = verify(directory);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Manifest source commit must be authoritative source HEAD/);
		const spoofed = verify(directory, "0123456789abcdef0123456789abcdef01234567");
		assert.notEqual(spoofed.status, 0);
		assert.match(spoofed.stderr, /--commit must exactly match authoritative source HEAD/);
	} finally { cleanup(directory); }
});

test("release verifier rejects missing or substituted secondary components", () => {
	for (const mutate of [
		({ manifest }) => { manifest.tarballs.splice(1, 1); },
		({ manifest }) => { manifest.tarballs[1].package = "prime-agent-substitute"; manifest.tarballs[1].file = `prime-agent-substitute-${version}.tgz`; },
	]) {
		const directory = createArtifacts(mutate);
		try {
			const result = verify(directory);
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /fixed release component inventory/);
		} finally { cleanup(directory); }
	}
});

test("release verifier retains hash tamper protection", () => {
	const directory = createArtifacts();
	try {
		writeFileSync(join(directory, `prime-agent-${version}.tgz`), "tampered\n");
		const result = verify(directory);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Hash mismatch/);
	} finally { cleanup(directory); }
});

test("workflow resolves once then only checks out and verifies immutable source_sha", () => {
	const source = readFileSync(workflow, "utf8");
	assert.match(source, /source_sha: \$\{\{ steps\.context\.outputs\.source_sha \}\}/);
	assert.match(source, /source_sha=\$\(git rev-parse "refs\/tags\/\$INPUT_RELEASE_TAG\^\{commit\}"\)/);
	assert.match(source, /source_sha="\$GITHUB_SHA_VALUE"/);
	assert.match(source, /ref: \$\{\{ env\.SOURCE_SHA \}\}/);
	assert.match(source, /test "\$\(git rev-parse HEAD\)" = "\$SOURCE_SHA"/);
	assert.match(source, /--commit "\$SOURCE_SHA"/);
	assert.match(source, /--target "\$SOURCE_SHA"/);
	assert.doesNotMatch(source, /BUILD_REF/);
	assert.doesNotMatch(source, /ref: \$\{\{ env\.BUILD_REF \}\}/);
});
