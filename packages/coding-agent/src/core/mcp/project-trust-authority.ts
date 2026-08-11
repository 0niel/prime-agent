import { createHash } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * Explicit policy input from a global, user-owned authority. Project settings
 * are deliberately not an input to this factory or to the returned authority.
 */
export interface McpProjectTrustAuthorityInput {
	/** Caller-owned policy revision, captured with the allowlist before use. */
	readonly revision: string;
	/** User-approved project directories. They must be exact canonical directories. */
	readonly allowedProjectDirectories: readonly string[];
}

/** An opaque, one-shot grant for a single project authority snapshot. */
declare const mcpProjectTrustBindingBrand: unique symbol;
export interface McpProjectTrustBinding {
	readonly [mcpProjectTrustBindingBrand]: never;
}

export type McpProjectTrustAuthorization =
	| { readonly kind: "denied" }
	| { readonly kind: "granted"; readonly binding: McpProjectTrustBinding };

/**
 * A project trust authority exposes no policy, path, digest, or boolean
 * authorization surface. Consumers retain a grant and may only validate it.
 */
export interface McpProjectTrustAuthority {
	authorizeProjectDirectory(projectDirectory: string): McpProjectTrustAuthorization;
}

interface DirectoryIdentity {
	readonly canonicalPath: string;
	readonly device: string;
	readonly inode: string;
}

interface BindingRecord {
	readonly revision: string;
	readonly digest: string;
	readonly identity: DirectoryIdentity;
}

const DENIED: McpProjectTrustAuthorization = Object.freeze({ kind: "denied" });

/**
 * Reads a directory only when the supplied spelling is already its exact
 * physical spelling. Relative paths, lexical aliases, symlinks (including
 * ancestor symlinks), unreadable paths, and non-directories all fail closed.
 */
function exactDirectoryIdentity(path: string): DirectoryIdentity | undefined {
	if (!isAbsolute(path) || resolve(path) !== path) {
		return undefined;
	}

	try {
		const initial = lstatSync(path);
		if (initial.isSymbolicLink() || !initial.isDirectory()) {
			return undefined;
		}
		accessSync(path, constants.R_OK | constants.X_OK);
		const canonicalPath = realpathSync.native(path);
		if (canonicalPath !== path) {
			return undefined;
		}
		const canonical = statSync(canonicalPath, { bigint: true });
		if (!canonical.isDirectory()) {
			return undefined;
		}
		accessSync(canonicalPath, constants.R_OK | constants.X_OK);
		return {
			canonicalPath,
			device: canonical.dev.toString(),
			inode: canonical.ino.toString(),
		};
	} catch {
		return undefined;
	}
}

function digestSnapshot(revision: string, directories: readonly DirectoryIdentity[]): string {
	return createHash("sha256")
		.update(revision)
		.update("\0")
		.update(directories.map(({ canonicalPath, device, inode }) => `${canonicalPath}\0${device}\0${inode}`).join("\0"))
		.digest("hex");
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
	return left.canonicalPath === right.canonicalPath && left.device === right.device && left.inode === right.inode;
}

/**
 * Snapshots a global/user-owned allowlist before an MCP use. Construction is
 * read-only and invalidates the complete policy on malformed, missing,
 * unreadable, symlinked, or canonical-alias entries. No runtime settings,
 * secrets, network, startup state, or ambient trust are consulted.
 */
export function createMcpProjectTrustAuthority(input: McpProjectTrustAuthorityInput): McpProjectTrustAuthority {
	const revision = typeof input.revision === "string" ? input.revision : "";
	const requestedDirectories = Array.isArray(input.allowedProjectDirectories)
		? [...input.allowedProjectDirectories]
		: [];
	const identities = requestedDirectories.map((directory) =>
		typeof directory === "string" ? exactDirectoryIdentity(directory) : undefined,
	);
	const valid =
		revision.length > 0 &&
		identities.every((identity): identity is DirectoryIdentity => identity !== undefined) &&
		new Set(identities.map((identity) => identity.canonicalPath)).size === identities.length;
	const snapshot = valid ? Object.freeze([...identities]) : Object.freeze([] as DirectoryIdentity[]);
	const snapshotDigest = digestSnapshot(revision, snapshot);
	const bindings = new WeakSet<object>();
	const records = new WeakMap<object, BindingRecord>();
	return Object.freeze({
		authorizeProjectDirectory(projectDirectory: string): McpProjectTrustAuthorization {
			const requested = typeof projectDirectory === "string" ? exactDirectoryIdentity(projectDirectory) : undefined;
			if (!requested || !snapshot.some((approved) => sameIdentity(approved, requested))) {
				return DENIED;
			}

			// Module-private brands and records make this opaque grant runtime-unforgeable.
			const binding = Object.freeze(Object.create(null)) as McpProjectTrustBinding;
			bindings.add(binding);
			records.set(binding, Object.freeze({ revision, digest: snapshotDigest, identity: requested }));
			return Object.freeze({ kind: "granted", binding });
		},
	});
}
