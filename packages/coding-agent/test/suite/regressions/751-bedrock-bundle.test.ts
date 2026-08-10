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
	const root = mkdtempSync(join(tmpdir(), "prime-agent-provider-bundle-"));
	tempDirs.push(root);
	const outdir = join(root, "bundle");
	mkdirSync(outdir);
	return outdir;
}

function writeProviderReferences(outdir: string, specifiers: string[]): void {
	writeFileSync(
		join(outdir, "chunk-provider-registry.js"),
		[
			"const importNodeOnlyProvider = (specifier) => import(specifier);",
			...specifiers.map((specifier) => `importNodeOnlyProvider(${JSON.stringify(specifier)});`),
		].join("\n"),
	);
}

function writeProvider(outdir: string, name: string): void {
	writeFileSync(join(outdir, name), `export const provider = ${JSON.stringify(name)};\n`);
}

function verify(outdir: string) {
	return spawnSync(process.execPath, [verifier, outdir], { encoding: "utf8" });
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("issue #751 node-only provider release bundles", () => {
	it("fails closed when emitted output contains no node-only provider references", () => {
		const result = verify(createBundleDir());

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("No node-only provider dynamic import references found");
	});

	it("derives every emitted reference and fails when a synthetic second provider is missing", () => {
		const outdir = createBundleDir();
		writeProviderReferences(outdir, ["./provider-one.js", "./provider-two.js"]);
		writeProvider(outdir, "provider-one.js");

		const missing = verify(outdir);
		expect(missing.status).toBe(1);
		expect(missing.stderr).toContain("Missing node-only provider bundle ./provider-two.js");

		writeProvider(outdir, "provider-two.js");
		const complete = verify(outdir);
		expect(complete.status, complete.stderr).toBe(0);
	});

	it("wires the explicit Bedrock entry and derived verifier into build and release packing", () => {
		const bundleScript = readFileSync(join(packageRoot, "scripts", "bundle.mjs"), "utf8");
		const releaseScript = readFileSync(join(repoRoot, "scripts", "pack-prime-agent-release.mjs"), "utf8");

		expect(bundleScript).toContain('"amazon-bedrock": join(aiPackageDir, "dist", "providers", "amazon-bedrock.js")');
		expect(bundleScript).toContain("await verifyBundleProviderAssets(outdir)");
		expect(releaseScript).toContain('releasePackage.packageDir === "coding-agent"');
		expect(releaseScript).toContain("await verifyBundleProviderAssets");
	});
});
