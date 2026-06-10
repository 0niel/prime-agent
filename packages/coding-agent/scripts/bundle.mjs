#!/usr/bin/env node
/**
 * Bundles the compiled CLI entry (dist/cli.js) into dist/bundle/ with esbuild.
 *
 * Why: the unbundled module graph is ~2,500 files; resolving and reading them
 * dominates startup (~1.5s on slow filesystems). The bundle loads the same code
 * from ~20 chunk files in under half the time. dist/ stays unbundled for
 * library consumers and type resolution; only the bin entry uses the bundle.
 *
 * Extension loading inside the bundle uses jiti virtualModules (same as the
 * compiled Bun binary), keyed off the __PI_BUNDLED__ define below, so extension
 * imports of pi packages share the bundle's module instances.
 */
import { chmodSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const outdir = join(packageDir, "dist", "bundle");

rmSync(outdir, { recursive: true, force: true });

await build({
	entryPoints: [join(packageDir, "dist", "cli.js")],
	outdir,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	// Native or interop-sensitive packages stay external; they resolve from
	// node_modules at runtime (and are loaded via createRequire/lazily anyway).
	external: ["zeromq", "koffi", "undici", "@silvia-odwyer/photon-node", "@mariozechner/clipboard"],
	define: { __PI_BUNDLED__: "true" },
	banner: {
		js: "import { createRequire as __piBundleCreateRequire } from 'node:module'; const require = __piBundleCreateRequire(import.meta.url);",
	},
	logLevel: "warning",
});

chmodSync(join(outdir, "cli.js"), 0o755);
console.log("bundled dist/cli.js -> dist/bundle/");
