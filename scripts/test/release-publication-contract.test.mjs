import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = new URL("../../.github/workflows/build-binaries.yml", import.meta.url);
const source = readFileSync(workflow, "utf8");

function step(name, nextName) {
	const start = source.indexOf(`- name: ${name}`);
	assert.notEqual(start, -1, `missing workflow step: ${name}`);
	const end = nextName ? source.indexOf(`- name: ${nextName}`, start + 1) : source.length;
	assert.notEqual(end, -1, `missing workflow step following ${name}: ${nextName}`);
	return source.slice(start, end);
}

function indexOfStep(name) {
	const index = source.indexOf(`- name: ${name}`);
	assert.notEqual(index, -1, `missing workflow step: ${name}`);
	return index;
}

test("immutable R2 publication conditionally creates then hash-verifies collisions", () => {
	const helpers = step("Prepare immutable publication helpers", "Extract production release notes");
	assert.match(helpers, /create_or_verify_immutable_r2_object\(\)/);
	assert.match(helpers, /aws s3api put-object[\s\S]*--if-none-match '\*'/);
	assert.match(helpers, /aws s3api get-object/);
	assert.match(helpers, /expected_sha=\$\(sha256sum "\$local_file"/);
	assert.match(helpers, /actual_sha=\$\(sha256sum "\$collision_file"/);
	assert.match(helpers, /\[ "\$actual_sha" != "\$expected_sha" \]/);

	for (const [publishStep, directory] of [
		["Publish immutable production artifacts to R2", "PRODUCTION_DIR"],
		["Publish immutable beta artifacts to R2", "BETA_DIR"],
	]) {
		const publication = step(publishStep, publishStep.startsWith("Publish immutable production") ? "Create or verify immutable production GitHub release and assets" : "Create or verify immutable beta GitHub release and assets");
		assert.ok(publication.includes(`for artifact in "$${directory}"/*.tgz; do`));
		assert.match(publication, /create_or_verify_immutable_r2_object "\$artifact"/);
		assert.ok(publication.includes(`create_or_verify_immutable_r2_object "$${directory}/manifest.json"`));
		assert.ok(publication.includes(`create_or_verify_immutable_r2_object "$${directory}/SHA256SUMS"`));
		assert.doesNotMatch(publication, /aws s3 cp/);
	}
});

test("GitHub release assets are create-or-verify-identical canonical release evidence", () => {
	const helpers = step("Prepare immutable publication helpers", "Extract production release notes");
	assert.match(helpers, /attach_or_verify_immutable_release_asset\(\)/);
	assert.match(helpers, /gh release upload "\$release_tag" "\$local_file" \|\| true/);
	assert.match(helpers, /Accept: application\/octet-stream/);
	assert.match(helpers, /Immutable release asset collision/);

	const production = step("Create or verify immutable production GitHub release and assets", "Advance production root pointers after immutable release publication");
	assert.match(production, /for artifact in "\$PRODUCTION_DIR"\/\*\.tgz "\$PRODUCTION_DIR\/manifest\.json" "\$PRODUCTION_DIR\/SHA256SUMS"/);
	assert.doesNotMatch(production, /\$PRODUCTION_DIR\/stable|install(?:-beta)?\.sh/);

	const beta = step("Create or verify immutable beta GitHub release and assets", "Advance beta root pointers after immutable release publication");
	assert.match(beta, /for artifact in "\$BETA_DIR"\/\*\.tgz "\$BETA_DIR\/manifest\.json" "\$BETA_DIR\/SHA256SUMS"/);
	assert.doesNotMatch(beta, /"\$BETA_DIR\/beta"(?!\.json)|install(?:-beta)?\.sh/);
});

test("publication order is tag, immutable objects, verified release assets, then mutable pointers", () => {
	const productionTag = indexOfStep("Create or verify immutable production tag");
	const productionR2 = indexOfStep("Publish immutable production artifacts to R2");
	const productionRelease = indexOfStep("Create or verify immutable production GitHub release and assets");
	const productionPointers = indexOfStep("Advance production root pointers after immutable release publication");
	assert.ok(productionTag < productionR2 && productionR2 < productionRelease && productionRelease < productionPointers);

	const betaTag = indexOfStep("Create or verify immutable beta tag");
	const betaR2 = indexOfStep("Publish immutable beta artifacts to R2");
	const betaRelease = indexOfStep("Create or verify immutable beta GitHub release and assets");
	const betaPointers = indexOfStep("Advance beta root pointers after immutable release publication");
	assert.ok(betaTag < betaR2 && betaR2 < betaRelease && betaRelease < betaPointers);

	const productionPointerStep = step("Advance production root pointers after immutable release publication", "Create or verify immutable beta tag");
	const latest = productionPointerStep.indexOf('s3://${R2_BUCKET}/latest.json');
	const installer = productionPointerStep.indexOf('s3://${R2_BUCKET}/install.sh');
	const betaInstaller = productionPointerStep.indexOf('s3://${R2_BUCKET}/install-beta.sh');
	const stable = productionPointerStep.indexOf('s3://${R2_BUCKET}/stable');
	assert.ok(latest >= 0 && latest < installer && installer < betaInstaller && betaInstaller < stable, "stable must be the final mutable production write");
});

test("workflow never overwrites or deletes immutable release identities", () => {
	for (const publishStep of [
		step("Publish immutable production artifacts to R2", "Create or verify immutable production GitHub release and assets"),
		step("Publish immutable beta artifacts to R2", "Create or verify immutable beta GitHub release and assets"),
	]) assert.doesNotMatch(publishStep, /aws s3 cp/);
	assert.doesNotMatch(source, /--clobber/);
	assert.doesNotMatch(source, /gh api --method DELETE|gh release delete|aws s3(?:api)? rm|delete-object/);
	assert.doesNotMatch(source, /force=true|--force/);
});
