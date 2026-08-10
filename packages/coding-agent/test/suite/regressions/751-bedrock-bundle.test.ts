import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(__dirname, "../../..");
const repoRoot = resolve(packageRoot, "../..");
const verifier = join(packageRoot, "scripts", "verify-bundle-assets.mjs");
const tempDirs: string[] = [];

function createBundleDir(): string {
	const root = mkdtempSync(join(tmpdir(), "prime-agent-bedrock-bundle-"));
	tempDirs.push(root);
	const outdir = join(root, "bundle");
	mkdirSync(outdir);
	return outdir;
}

function verify(outdir: string) {
	return spawnSync(process.execPath, [verifier, outdir], { encoding: "utf8" });
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("issue #751 Bedrock release bundle", () => {
	it("fails distribution verification when the Bedrock entry is absent", () => {
		const result = verify(createBundleDir());

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Missing required provider bundle");
		expect(result.stderr).toContain("amazon-bedrock.js");
	});

	it("requires the Bedrock bundle to expose both streaming entry points", () => {
		const outdir = createBundleDir();
		const asset = join(outdir, "amazon-bedrock.js");
		writeFileSync(asset, "export function streamBedrock() {}\n");
		expect(verify(outdir).stderr).toContain("does not export streamSimpleBedrock()");

		writeFileSync(asset, "export function streamBedrock() {}\nexport function streamSimpleBedrock() {}\n");
		const result = verify(outdir);
		expect(result.status, result.stderr).toBe(0);
	});

	it("wires the explicit provider entry and verifier into build and release packing", () => {
		const bundleScript = readFileSync(join(packageRoot, "scripts", "bundle.mjs"), "utf8");
		const releaseScript = readFileSync(join(repoRoot, "scripts", "pack-prime-agent-release.mjs"), "utf8");

		expect(bundleScript).toContain('"amazon-bedrock": join(aiPackageDir, "dist", "providers", "amazon-bedrock.js")');
		expect(bundleScript).toContain("await verifyBundleProviderAssets(outdir)");
		expect(releaseScript).toContain('releasePackage.packageDir === "coding-agent"');
		expect(releaseScript).toContain("await verifyBundleProviderAssets");
	});
});
