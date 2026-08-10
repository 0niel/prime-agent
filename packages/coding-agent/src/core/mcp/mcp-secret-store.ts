/**
 * Keychain-only MCP OAuth secret storage.
 *
 * This module has no file, environment, or plaintext fallback. Production
 * construction fails with KEYCHAIN_UNAVAILABLE until a native keychain adapter
 * is linked. Test fakes are only usable through explicit adapter injection.
 */
import { randomBytes } from "node:crypto";

export const MCP_OAUTH_SECRET_NAMESPACE = "mcp-oauth" as const;
const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** Opaque, revision-fenced handle. It contains no credential bytes. */
export interface SecretReference {
	version: 1;
	namespace: typeof MCP_OAUTH_SECRET_NAMESPACE;
	id: string;
	revision: string;
}

export type McpOAuthSecretReference = SecretReference;
export type McpOAuthSecretRevision = string;

export type McpSecretStoreErrorCode =
	| "KEYCHAIN_UNAVAILABLE"
	| "KEYCHAIN_LOCKED"
	| "KEYCHAIN_OPERATION_FAILED"
	| "SECRET_NOT_FOUND"
	| "REVISION_CONFLICT"
	| "DURABILITY_CONFIRMATION_FAILED";

export class McpSecretStoreError extends Error {
	constructor(readonly code: McpSecretStoreErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "McpSecretStoreError";
	}
}

/** Native keychain support is absent or unreachable. No fallback is used. */
export class McpKeychainUnavailableError extends McpSecretStoreError {
	constructor(message = "MCP OAuth secrets require a native platform keychain; no fallback is available.", options?: ErrorOptions) {
		super("KEYCHAIN_UNAVAILABLE", message, options);
		this.name = "McpKeychainUnavailableError";
	}
}

/** The native keychain needs user interaction before it can operate. */
export class McpKeychainLockedError extends McpSecretStoreError {
	constructor(message = "MCP OAuth secrets cannot be accessed because the platform keychain is locked.", options?: ErrorOptions) {
		super("KEYCHAIN_LOCKED", message, options);
		this.name = "McpKeychainLockedError";
	}
}

/**
 * Narrow native-vault boundary. Implementations must atomically compare the
 * existing bytes for replace/delete. Production never selects an in-memory
 * implementation; tests inject their own fake explicitly.
 */
export interface McpKeychainAdapter {
	create(id: string, value: Uint8Array): Promise<void>;
	read(id: string): Promise<Uint8Array | undefined>;
	replace(id: string, expectedValue: Uint8Array, value: Uint8Array): Promise<boolean>;
	delete(id: string, expectedValue: Uint8Array): Promise<boolean>;
}

type StoredEnvelope = { version: 1; revision: string; value: string };

function token(): string {
	return randomBytes(32).toString("base64url");
}

function requireReference(reference: SecretReference): void {
	if (
		reference.version !== 1 ||
		reference.namespace !== MCP_OAUTH_SECRET_NAMESPACE ||
		!ID_PATTERN.test(reference.id) ||
		!ID_PATTERN.test(reference.revision)
	) {
		throw new McpSecretStoreError("KEYCHAIN_OPERATION_FAILED", "Invalid MCP OAuth secret reference.");
	}
}

function encode(value: Uint8Array, revision: string): Uint8Array {
	const envelope: StoredEnvelope = { version: 1, revision, value: Buffer.from(value).toString("base64") };
	return Buffer.from(JSON.stringify(envelope), "utf8");
}

function decode(raw: Uint8Array): StoredEnvelope {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(raw).toString("utf8"));
		if (
			typeof parsed !== "object" || parsed === null ||
			(parsed as { version?: unknown }).version !== 1 ||
			typeof (parsed as { revision?: unknown }).revision !== "string" || !ID_PATTERN.test((parsed as { revision: string }).revision) ||
			typeof (parsed as { value?: unknown }).value !== "string"
		) throw new Error("invalid envelope");
		return parsed as StoredEnvelope;
	} catch (cause) {
		throw new McpSecretStoreError("KEYCHAIN_OPERATION_FAILED", "MCP OAuth keychain item has an invalid envelope.", { cause });
	}
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function adaptError(operation: string, cause: unknown): McpSecretStoreError {
	if (cause instanceof McpSecretStoreError) return cause;
	const detail = cause instanceof Error ? cause.message : String(cause);
	if (/errSecInteractionNotAllowed|errSecAuthFailed|user interaction is not allowed/i.test(detail)) {
		return new McpKeychainLockedError(undefined, { cause: cause instanceof Error ? cause : undefined });
	}
	return new McpSecretStoreError("KEYCHAIN_OPERATION_FAILED", `MCP OAuth keychain ${operation} failed.`, {
		cause: cause instanceof Error ? cause : undefined,
	});
}

/** Fails closed: no subprocess, plaintext persistence, or in-memory production adapter exists. */
export function createPlatformMcpKeychainAdapter(platform = process.platform): McpKeychainAdapter {
	throw new McpKeychainUnavailableError(
		`MCP OAuth secrets are unavailable on ${platform}: no native keychain adapter is linked; no fallback exists.`,
	);
}

/** Keychain-only store. Successful puts/replaces are read back before returning a reference. */
export class McpOAuthSecretStore {
	constructor(private readonly keychain: McpKeychainAdapter = createPlatformMcpKeychainAdapter()) {}

	async put(namespace: typeof MCP_OAUTH_SECRET_NAMESPACE, value: Uint8Array): Promise<SecretReference> {
		if (namespace !== MCP_OAUTH_SECRET_NAMESPACE) {
			throw new McpSecretStoreError("KEYCHAIN_OPERATION_FAILED", "MCP OAuth secrets require the mcp-oauth namespace.");
		}
		const id = token();
		const revision = token();
		const raw = encode(value, revision);
		try {
			await this.keychain.create(id, raw);
			await this.confirm(id, raw);
			return { version: 1, namespace: MCP_OAUTH_SECRET_NAMESPACE, id, revision };
		} catch (cause) {
			throw adaptError("create", cause);
		}
	}

	/** Returns undefined for a missing or stale reference, never a stale secret. */
	async get(reference: SecretReference): Promise<Uint8Array | undefined> {
		try {
			const current = await this.current(reference);
			return Buffer.from(current.envelope.value, "base64");
		} catch (cause) {
			if (cause instanceof McpSecretStoreError && (cause.code === "SECRET_NOT_FOUND" || cause.code === "REVISION_CONFLICT")) return undefined;
			throw cause;
		}
	}

	async replace(reference: SecretReference, expectedRevision: McpOAuthSecretRevision, value: Uint8Array): Promise<SecretReference> {
		if (reference.revision !== expectedRevision) this.conflict();
		const current = await this.current(reference);
		const revision = token();
		const raw = encode(value, revision);
		try {
			if (!(await this.keychain.replace(reference.id, current.raw, raw))) this.conflict();
			await this.confirm(reference.id, raw);
			return { ...reference, revision };
		} catch (cause) {
			throw adaptError("replace", cause);
		}
	}

	async delete(reference: SecretReference, expectedRevision?: McpOAuthSecretRevision): Promise<void> {
		if (expectedRevision !== undefined && reference.revision !== expectedRevision) this.conflict();
		const current = await this.current(reference);
		try {
			if (!(await this.keychain.delete(reference.id, current.raw))) this.conflict();
			if ((await this.keychain.read(reference.id)) !== undefined) {
				throw new McpSecretStoreError("DURABILITY_CONFIRMATION_FAILED", "MCP OAuth keychain delete could not be confirmed.");
			}
		} catch (cause) {
			throw adaptError("delete", cause);
		}
	}

	private conflict(): never {
		throw new McpSecretStoreError("REVISION_CONFLICT", "MCP OAuth secret revision no longer matches.");
	}

	private async current(reference: SecretReference): Promise<{ raw: Uint8Array; envelope: StoredEnvelope }> {
		requireReference(reference);
		try {
			const raw = await this.keychain.read(reference.id);
			if (raw === undefined) throw new McpSecretStoreError("SECRET_NOT_FOUND", "MCP OAuth secret reference was not found.");
			const envelope = decode(raw);
			if (envelope.revision !== reference.revision) this.conflict();
			return { raw, envelope };
		} catch (cause) {
			throw adaptError("read", cause);
		}
	}

	private async confirm(id: string, expected: Uint8Array): Promise<void> {
		const actual = await this.keychain.read(id);
		if (actual === undefined || !equal(actual, expected)) {
			throw new McpSecretStoreError("DURABILITY_CONFIRMATION_FAILED", "MCP OAuth keychain write could not be confirmed.");
		}
	}
}
