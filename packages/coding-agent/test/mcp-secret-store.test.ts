import { describe, expect, test } from "vitest";
import {
	createPlatformMcpKeychainAdapter,
	McpKeychainUnavailableError,
	McpOAuthSecretStore,
	type McpKeychainAdapter,
} from "../src/core/mcp/mcp-secret-store.js";

/** Test-only fake; production has no in-memory adapter selection. */
class InMemoryKeychainAdapter implements McpKeychainAdapter {
	readonly values = new Map<string, Uint8Array>();
	createCalls = 0;
	readCalls = 0;

	async create(id: string, value: Uint8Array): Promise<void> {
		this.createCalls += 1;
		if (this.values.has(id)) throw new Error("duplicate keychain item");
		this.values.set(id, value.slice());
	}
	async read(id: string): Promise<Uint8Array | undefined> {
		this.readCalls += 1;
		return this.values.get(id)?.slice();
	}
	async replace(id: string, expected: Uint8Array, value: Uint8Array): Promise<boolean> {
		const current = this.values.get(id);
		if (!current || !same(current, expected)) return false;
		this.values.set(id, value.slice());
		return true;
	}
	async delete(id: string, expected: Uint8Array): Promise<boolean> {
		const current = this.values.get(id);
		if (!current || !same(current, expected)) return false;
		this.values.delete(id);
		return true;
	}
}
function same(left: Uint8Array, right: Uint8Array): boolean {
	return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

describe("McpOAuthSecretStore", () => {
	test("returns an opaque versioned reference only after keychain read-back", async () => {
		const keychain = new InMemoryKeychainAdapter();
		const store = new McpOAuthSecretStore(keychain);
		const value = new Uint8Array([1, 2, 3, 254]);
		const reference = await store.put("mcp-oauth", value);

		expect(reference).toMatchObject({ version: 1, namespace: "mcp-oauth" });
		expect(reference.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(reference.revision).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(keychain.createCalls).toBe(1);
		expect(keychain.readCalls).toBe(1);
		expect(await store.get(reference)).toEqual(value);
	});

	test("revision-fences get, replace, and delete", async () => {
		const store = new McpOAuthSecretStore(new InMemoryKeychainAdapter());
		const original = await store.put("mcp-oauth", new Uint8Array([1]));
		const replacement = await store.replace(original, original.revision, new Uint8Array([2]));
		expect(replacement.id).toBe(original.id);
		expect(replacement.revision).not.toBe(original.revision);
		expect(await store.get(original)).toBeUndefined();
		await expect(store.replace(original, original.revision, new Uint8Array([3]))).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
		await expect(store.delete(original, original.revision)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
		expect(await store.get(replacement)).toEqual(new Uint8Array([2]));
		await store.delete(replacement, replacement.revision);
		expect(await store.get(replacement)).toBeUndefined();
	});

	test("does not return a reference if a write is not durably confirmed", async () => {
		class NonDurableAdapter extends InMemoryKeychainAdapter {
			override async read(): Promise<Uint8Array | undefined> { return undefined; }
		}
		await expect(new McpOAuthSecretStore(new NonDurableAdapter()).put("mcp-oauth", new Uint8Array([1]))).rejects.toMatchObject({
			code: "DURABILITY_CONFIRMATION_FAILED",
		});
	});

	test("production construction fails closed without a native adapter", () => {
		expect(() => createPlatformMcpKeychainAdapter("linux")).toThrow(McpKeychainUnavailableError);
		expect(() => createPlatformMcpKeychainAdapter("darwin")).toThrow(/no native keychain adapter/i);
	});
});
