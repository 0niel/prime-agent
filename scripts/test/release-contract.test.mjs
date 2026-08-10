import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = new URL("../..", import.meta.url);
const packer = new URL("../pack-prime-agent-release.mjs", import.meta.url);
const verifier = new URL("../verify-prime-agent-release.mjs", import.meta.url);
const workflow = new URL("../../.github/workflows/build-binaries.yml", import.meta.url);
const commit = "0123456789abcdef0123456789abcdef01234567";
const version = "0.7.1";

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}

function createArtifacts() {
	const directory = mkdtempSync(join(tmpdir(), "prime-agent-release-contract-"));
	const files = ["prime-agent-0.7.1.tgz", "prime-agent-ai-0.7.1.tgz"];
	const tarballs = files.map((file) => {
		const contents = `fixture ${file}\n`;
		writeFileSync(join(directory, file), contents);
		return { file, package: file.replace(/-0\.7\.1\.tgz$/, ""), sha256: sha256(contents) };
	});
	writeFileSync(join(directory, "SHA256SUMS"), tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n");
	writeFileSync(join(directory, "stable"), "v0.7.1\n");
	writeFileSync(
		join(directory, "latest.json"),
		JSON.stringify({
			version: "v0.7.1",
			source: { commit },
			package: "prime-agent",
			tarball: "releases/v0.7.1/prime-agent-0.7.1.tgz",
			tarballs,
		}) + "\n",
	);
	return directory;
}

function verify(directory, expectedCommit = commit) {
	return spawnSync(process.execPath, [verifier.pathname, "--artifact-dir", directory, "--channel", "stable", "--version", version, "--commit", expectedCommit, "--dry-run"], {
		cwd: root.pathname,
		encoding: "utf8",
	});
}

test("packer requires an exact commit before it can create release artifacts", () => {
	const result = spawnSync(process.execPath, [packer.pathname, "--base-url", "https://release.invalid"], {
		cwd: root.pathname,
		encoding: "utf8",
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /--commit is required/);
});

test("packer records the supplied commit in its release manifest contract", () => {
	const source = readFileSync(packer, "utf8");
	assert.match(source, /source: \{\n\t\t\tcommit: args\.commit,/);
});

test("release verifier accepts a complete manifest and emits deterministic dry-run context", () => {
	const directory = createArtifacts();
	try {
		const result = verify(directory);
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout), {
			channel: "stable",
			commit,
			manifest: "latest.json",
			tarballs: ["prime-agent-0.7.1.tgz", "prime-agent-ai-0.7.1.tgz"],
			version: "v0.7.1",
		});
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("release verifier rejects a manifest from a different commit before publication", () => {
	const directory = createArtifacts();
	try {
		const result = verify(directory, "fedcba9876543210fedcba9876543210fedcba98");
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Manifest source commit must be/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("release verifier rejects artifacts whose bytes no longer match the manifest", () => {
	const directory = createArtifacts();
	try {
		writeFileSync(join(directory, "prime-agent-0.7.1.tgz"), "tampered\n");
		const result = verify(directory);
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /Hash mismatch/);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("release workflow passes the checked-out SHA to pack and verifies it before publication", () => {
	const source = readFileSync(workflow, "utf8");
	assert.match(source, /id: source-commit[\s\S]*git rev-parse HEAD/);
	assert.match(source, /--commit "\$\(git rev-parse HEAD\)"/);
	assert.match(source, /Confirm publication checkout matches packed source[\s\S]*git rev-parse HEAD.*SOURCE_COMMIT/);
	assert.match(source, /SOURCE_COMMIT: \$\{\{ needs\.build\.outputs\.source_commit \}\}/);
	assert.match(source, /--artifact-dir "\$PRODUCTION_DIR"[\s\S]*--commit "\$SOURCE_COMMIT"[\s\S]*--dry-run/);
	assert.match(source, /--artifact-dir "\$BETA_DIR"[\s\S]*--commit "\$SOURCE_COMMIT"[\s\S]*--dry-run/);
});
