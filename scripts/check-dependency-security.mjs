#!/usr/bin/env node

import { globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function findFiles(directory, filename) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (entry.name === ".git" || entry.name === "node_modules") continue;
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...findFiles(path, filename));
		else if (entry.isFile() && (!filename || entry.name === filename)) files.push(path);
	}
	return files;
}

function canonicalJson(value) {
	if (Array.isArray(value)) return value.map(canonicalJson);
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, canonicalJson(entry)]),
		);
	}
	return value;
}

function sameJson(left, right) {
	return JSON.stringify(canonicalJson(left ?? {})) === JSON.stringify(canonicalJson(right ?? {}));
}

function checkLockfile(lockPath) {
	const lock = readJson(lockPath);
	const lockLabel = relative(root, lockPath);
	if (lock.lockfileVersion !== 3) {
		errors.push(`${lockLabel}: expected lockfileVersion 3, found ${lock.lockfileVersion}`);
	}

	for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
		if (!packagePath.includes("node_modules/") || !metadata.version || metadata.link || metadata.inBundle) {
			continue;
		}
		const label = `${lockLabel}:${packagePath}@${metadata.version}`;
		if (!metadata.resolved?.startsWith("https://registry.npmjs.org/")) {
			errors.push(`${label}: missing npm registry resolved URL`);
		}
		if (!metadata.integrity?.startsWith("sha512-")) {
			errors.push(`${label}: missing SHA-512 integrity`);
		}
	}

	const manifestPath = join(dirname(lockPath), "package.json");
	const manifest = readJson(manifestPath);
	const lockedRoot = lock.packages?.[""];
	if (!lockedRoot) {
		errors.push(`${lockLabel}: missing root package metadata`);
		return;
	}
	for (const field of ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "engines"]) {
		if (!sameJson(lockedRoot[field], manifest[field])) {
			errors.push(`${lockLabel}: root ${field} does not match ${relative(root, manifestPath)}`);
		}
	}
}

function checkWorkspaceMetadata() {
	const rootManifest = readJson(join(root, "package.json"));
	const rootLock = readJson(join(root, "package-lock.json"));
	const workspacePaths = globSync(rootManifest.workspaces, { cwd: root });
	for (const workspacePath of workspacePaths) {
		const packagePath = workspacePath.replaceAll("\\", "/");
		const locked = rootLock.packages?.[packagePath];
		if (!locked) {
			errors.push(`package-lock.json:${packagePath} missing workspace package metadata`);
			continue;
		}
		const manifestPath = join(root, workspacePath, "package.json");
		const manifest = readJson(manifestPath);
		for (const field of ["name", "version", "dependencies", "devDependencies", "optionalDependencies", "engines"]) {
			if (!sameJson(locked[field], manifest[field])) {
				errors.push(`package-lock.json:${packagePath} ${field} does not match ${relative(root, manifestPath)}`);
			}
		}
	}
}

function checkActionPins() {
	const workflowsDir = join(root, ".github", "workflows");
	for (const workflowPath of findFiles(workflowsDir, "")) {
		if (!workflowPath.endsWith(".yml") && !workflowPath.endsWith(".yaml")) continue;
		const workflowLabel = relative(root, workflowPath);
		for (const [index, line] of readFileSync(workflowPath, "utf8").split("\n").entries()) {
			const action = line.match(/^\s*uses:\s*([^\s#]+)/)?.[1];
			if (!action || action.startsWith("./") || action.startsWith("docker://")) continue;
			if (!/^[^@\s]+@[0-9a-f]{40}$/.test(action)) {
				errors.push(`${workflowLabel}:${index + 1}: action is not pinned to a full commit SHA: ${action}`);
			}
		}
	}
}

function checkNpmPolicy() {
	const manifest = readJson(join(root, "package.json"));
	if (!/^npm@11\.\d+\.\d+$/.test(manifest.packageManager ?? "")) {
		errors.push("package.json: packageManager must pin npm 11");
	}
	if (manifest.engines?.npm !== ">=11.10.0 <12") {
		errors.push("package.json: engines.npm must require npm >=11.10.0 <12");
	}
	const npmrc = readFileSync(join(root, ".npmrc"), "utf8");
	if (!/^min-release-age=7$/m.test(npmrc)) {
		errors.push(".npmrc: expected min-release-age=7");
	}
}

for (const lockPath of findFiles(root, "package-lock.json")) checkLockfile(lockPath);
checkWorkspaceMetadata();
checkActionPins();
checkNpmPolicy();

if (errors.length > 0) {
	for (const error of errors) console.error(error);
	process.exit(1);
}

console.log("Dependency security policy checks passed.");
