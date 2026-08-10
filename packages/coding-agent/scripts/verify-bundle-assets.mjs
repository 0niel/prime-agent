#!/usr/bin/env node

import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REQUIRED_BUNDLE_PROVIDER_ASSETS = [
	{
		file: "amazon-bedrock.js",
		exports: ["streamBedrock", "streamSimpleBedrock"],
	},
];

export async function verifyBundleProviderAssets(outdir) {
	for (const asset of REQUIRED_BUNDLE_PROVIDER_ASSETS) {
		const assetPath = resolve(outdir, asset.file);
		let assetStat;
		try {
			assetStat = await stat(assetPath);
		} catch {
			throw new Error(`Missing required provider bundle: ${assetPath}`);
		}
		if (!assetStat.isFile() || assetStat.size === 0) {
			throw new Error(`Required provider bundle is not a non-empty file: ${assetPath}`);
		}

		let providerModule;
		try {
			providerModule = await import(`${pathToFileURL(assetPath).href}?verify=${Date.now()}`);
		} catch (error) {
			throw new Error(
				`Required provider bundle could not be imported: ${assetPath}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		for (const exportName of asset.exports) {
			if (typeof providerModule[exportName] !== "function") {
				throw new Error(`Required provider bundle ${assetPath} does not export ${exportName}()`);
			}
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
