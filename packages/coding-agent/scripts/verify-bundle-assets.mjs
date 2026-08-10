#!/usr/bin/env node

import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NODE_ONLY_PROVIDER_IMPORT = /\bimportNodeOnlyProvider[A-Za-z0-9_$]*\(\s*(["'`])(\.[^"'`]+)\1\s*\)/g;

async function listJavaScriptFiles(directory) {
	const files = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const entryPath = resolve(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listJavaScriptFiles(entryPath)));
		else if (entry.isFile() && entry.name.endsWith(".js")) files.push(entryPath);
	}
	return files;
}

function assertPathInside(root, target, description) {
	const pathFromRoot = relative(root, target);
	if (pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))) return;
	throw new Error(`${description} resolves outside the bundle directory: ${target}`);
}

export async function findNodeOnlyProviderReferences(outdir) {
	const root = await realpath(resolve(outdir));
	const references = [];
	for (const sourcePath of await listJavaScriptFiles(root)) {
		const source = await readFile(sourcePath, "utf8");
		for (const match of source.matchAll(NODE_ONLY_PROVIDER_IMPORT)) {
			const specifier = match[2];
			const targetPath = resolve(dirname(sourcePath), specifier);
			assertPathInside(root, targetPath, `Node-only provider reference ${specifier} in ${sourcePath}`);
			references.push({ sourcePath, specifier, targetPath });
		}
	}
	if (references.length === 0) {
		throw new Error(`No node-only provider dynamic import references found in ${root}`);
	}
	return { root, references };
}

export async function verifyBundleProviderAssets(outdir) {
	const { root, references } = await findNodeOnlyProviderReferences(outdir);
	const targets = new Map();
	for (const reference of references) {
		let targetStat;
		try {
			targetStat = await lstat(reference.targetPath);
		} catch {
			throw new Error(
				`Missing node-only provider bundle ${reference.specifier} referenced by ${reference.sourcePath}`,
			);
		}
		if (!targetStat.isFile() || targetStat.isSymbolicLink() || targetStat.size === 0) {
			throw new Error(`Node-only provider bundle is not a non-empty regular file: ${reference.targetPath}`);
		}
		const realTarget = await realpath(reference.targetPath);
		assertPathInside(root, realTarget, `Node-only provider bundle ${reference.specifier}`);
		targets.set(realTarget, reference);
	}

	for (const [targetPath, reference] of targets) {
		try {
			await import(`${pathToFileURL(targetPath).href}?verify=${Date.now()}`);
		} catch (error) {
			throw new Error(
				`Node-only provider bundle ${reference.specifier} referenced by ${reference.sourcePath} could not be imported: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
	try {
		await verifyBundleProviderAssets(process.argv[2] || "dist/bundle");
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
